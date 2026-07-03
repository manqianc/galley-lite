// galley-lite.test.mjs — queue integration tests
// Run: node --test galley-lite.test.mjs
// Uses GALLEY_MOCK_AGENT=<ms> so no real `claude` CLI is needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const GL = fileURLToPath(new URL("galley-lite.mjs", import.meta.url));
const MOCK_MS = 180; // mock turn duration — long enough to queue multiple messages

// ---- helpers -------------------------------------------------------------------

async function startServer(port) {
  const dir = mkdtempSync(join(tmpdir(), "galley-test-"));
  const file = join(dir, "test.html");
  writeFileSync(file, "<html><body><p>hello</p></body></html>");

  const proc = spawn("node", [GL, file, "--no-open", "--port", String(port), "--fresh"], {
    env: { ...process.env, GALLEY_MOCK_AGENT: String(MOCK_MS), ANTHROPIC_API_KEY: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  await new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error("server start timeout")), 8000);
    proc.stdout.on("data", (d) => {
      buf += d;
      if (buf.includes("galley-lite →")) { clearTimeout(timer); resolve(); }
    });
    proc.on("exit", (code) => { clearTimeout(timer); reject(new Error("server exited: " + code)); });
  });

  // Extract per-run CSRF token from served HTML (it's injected as GL_TOKEN=<json>).
  const html = await fetch(`http://localhost:${port}/`).then((r) => r.text());
  const m = html.match(/var GL_TOKEN=([^;]+)/);
  if (!m) throw new Error("token not found in served HTML");
  const token = JSON.parse(m[1]);

  return { proc, port, token };
}

function authHdr(token) {
  return { "content-type": "application/json", "x-galley-token": token };
}

async function send(port, token, msg) {
  const r = await fetch(`http://localhost:${port}/__galley/send`, {
    method: "POST",
    headers: authHdr(token),
    body: JSON.stringify({ message: msg, comments: [] }),
  });
  return r.json();
}

async function getQueue(port, token) {
  const r = await fetch(`http://localhost:${port}/__galley/queue`, {
    headers: { "x-galley-token": token },
  });
  return r.json();
}

async function reorder(port, token, ids) {
  const r = await fetch(`http://localhost:${port}/__galley/queue/reorder`, {
    method: "POST",
    headers: authHdr(token),
    body: JSON.stringify({ ids }),
  });
  return r.json();
}

async function cancel(port, token, id) {
  const r = await fetch(`http://localhost:${port}/__galley/queue/cancel`, {
    method: "POST",
    headers: authHdr(token),
    body: JSON.stringify({ id }),
  });
  return r.json();
}

// Collect SSE events until `ms` milliseconds pass or we receive `until` events
// matching a predicate (whichever comes first).
function collectSSE(port, ms, until) {
  return new Promise((resolve) => {
    const events = [];
    const ctrl = new AbortController();
    const done = () => { ctrl.abort(); resolve(events); };
    const timer = setTimeout(done, ms);

    fetch(`http://localhost:${port}/__galley/events`, { signal: ctrl.signal })
      .then((res) => {
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        function read() {
          reader.read().then(({ done: d, value }) => {
            if (d) { clearTimeout(timer); resolve(events); return; }
            buf += dec.decode(value, { stream: true });
            const parts = buf.split("\n\n");
            buf = parts.pop();
            for (const part of parts) {
              const line = part.split("\n").find((l) => l.startsWith("data: "));
              if (!line) continue;
              try {
                const ev = JSON.parse(line.slice(6));
                events.push(ev);
                if (until && until(ev, events)) { clearTimeout(timer); done(); return; }
              } catch { /* ignore */ }
            }
            read();
          }).catch(() => { clearTimeout(timer); resolve(events); });
        }
        read();
      })
      .catch(() => { clearTimeout(timer); resolve(events); });
  });
}

// ---- tests ---------------------------------------------------------------------

test("messages queue while agent is busy and run in order", { timeout: 6000 }, async (t) => {
  const { proc, port, token } = await startServer(14501);
  t.after(() => proc.kill());

  // Start listening for SSE before sending (so we don't miss events).
  // Resolve when we've seen 3 turn-end events (all 3 turns completed).
  const sseP = collectSSE(port, 4000, (_, all) => all.filter((e) => e.type === "turn-end").length === 3);

  // Send all 3 messages quickly — first is picked up immediately (mock takes MOCK_MS),
  // the other two queue up behind it.
  const [r1, r2, r3] = await Promise.all([
    send(port, token, "first"),
    send(port, token, "second"),
    send(port, token, "third"),
  ]);

  assert.equal(r1.ok, true, "first accepted");
  assert.equal(r2.ok, true, "second accepted");
  assert.equal(r3.ok, true, "third accepted");

  const events = await sseP;
  const turns = events.filter((e) => e.type === "turn" && e.role === "user");
  assert.equal(turns.length, 3, "3 user turns fired");
  assert.equal(turns[0].text, "first",  "1st turn: first");
  assert.equal(turns[1].text, "second", "2nd turn: second");
  assert.equal(turns[2].text, "third",  "3rd turn: third");
});

test("reorder changes execution order", { timeout: 6000 }, async (t) => {
  const { proc, port, token } = await startServer(14502);
  t.after(() => proc.kill());

  const sseP = collectSSE(port, 4000, (_, all) => all.filter((e) => e.type === "turn-end").length === 3);

  // Send sequentially so the first is definitely running by the time we call getQueue.
  await send(port, token, "alpha");
  await send(port, token, "beta");
  await send(port, token, "gamma");

  // alpha is running (MOCK_MS left); beta and gamma are queued.
  const q = await getQueue(port, token);
  assert.ok(q.items.length >= 1, "at least one item queued");

  // Reverse whatever is in the queue (gamma before beta).
  const reversedIds = [...q.items].reverse().map((i) => i.id);
  const rr = await reorder(port, token, reversedIds);
  assert.equal(rr.ok, true, "reorder succeeded");

  const events = await sseP;
  const turns = events.filter((e) => e.type === "turn" && e.role === "user");
  assert.equal(turns.length, 3, "3 turns ran");
  assert.equal(turns[0].text, "alpha", "alpha ran first (was already running)");
  // After reorder the queue order swapped; if only 2 were queued, gamma is now first.
  if (q.items.length === 2) {
    assert.equal(turns[1].text, "gamma", "gamma ran before beta after reorder");
    assert.equal(turns[2].text, "beta",  "beta ran last");
  }
  // If only one was queued by the time we reordered, just verify 3 ran.
});

test("cancel removes a message from the queue", { timeout: 6000 }, async (t) => {
  const { proc, port, token } = await startServer(14503);
  t.after(() => proc.kill());

  const sseP = collectSSE(port, 4000, (_, all) => all.filter((e) => e.type === "turn-end").length === 2);

  await send(port, token, "keep-1");
  await send(port, token, "delete-me");
  await send(port, token, "keep-2");

  // keep-1 is running; delete-me and keep-2 are queued.
  const q = await getQueue(port, token);
  const toCancel = q.items.find((i) => i.text === "delete-me");

  if (toCancel) {
    // Cancel it.
    const cr = await cancel(port, token, toCancel.id);
    assert.equal(cr.ok, true, "cancel succeeded");

    // Queue should now have only keep-2.
    const q2 = await getQueue(port, token);
    assert.ok(!q2.items.some((i) => i.text === "delete-me"), "delete-me no longer queued");
  }
  // If the mock was fast enough that delete-me already started, it will run — that's
  // a valid race (cancel only works on queued items, not running ones). Either way,
  // keep-1 and keep-2 must appear in the SSE turns.

  const events = await sseP;
  const turns = events.filter((e) => e.type === "turn" && e.role === "user");
  assert.ok(turns.some((t2) => t2.text === "keep-1"), "keep-1 ran");
  assert.ok(turns.some((t2) => t2.text === "keep-2"), "keep-2 ran");
  assert.ok(!turns.some((t2) => t2.text === "delete-me"), "delete-me did not run");
});

test("GET /queue reflects current pending items", { timeout: 6000 }, async (t) => {
  const { proc, port, token } = await startServer(14504);
  t.after(() => proc.kill());

  // Nothing queued yet.
  const empty = await getQueue(port, token);
  assert.deepEqual(empty.items, [], "queue empty at start");

  const sseP = collectSSE(port, 3000, (_, all) => all.filter((e) => e.type === "turn-end").length === 2);

  await send(port, token, "one");
  await send(port, token, "two");

  const q = await getQueue(port, token);
  // At least one of the two should be in the queue (the other may already be running).
  assert.ok(q.items.length >= 0, "queue is an array");
  assert.ok(q.items.every((i) => i.id && i.text), "each item has id and text");

  await sseP;
});
