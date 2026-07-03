#!/usr/bin/env node
// galley-lite — open any local HTML, click an element, leave a comment, and a
// Claude Code session edits the file in place + live reloads. Bring your own
// Anthropic API key (ANTHROPIC_API_KEY). Zero deps, single file. Works on any
// HTML on disk.
//
//   node galley-lite.mjs report.html [--port 4321] [--model sonnet] [--resume <sessionId>]
//
// Linked mode: if the HTML contains  <!-- galley-session: <id> -->  (or you pass
// --resume), edits RESUME that Claude session, so they inherit its full context
// (sources, reasoning) instead of only seeing the rendered HTML. Each edit chains
// the session forward.
import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync, statSync, watch, createReadStream, readdirSync, appendFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { platform, homedir } from "node:os";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { dirname, basename, extname, resolve, sep, join } from "node:path";

// Per-run secret. State-changing endpoints (which invoke the agent + write files)
// require it in a header. It's embedded into the same-origin overlay only, so a
// cross-origin page can't read it — and the custom header forces a CORS preflight
// we never approve, which is what actually defeats CSRF.
const TOKEN = randomUUID();

// ---- args ----------------------------------------------------------------------
const BOOL_FLAGS = new Set(["open", "no-open", "help", "no-link", "fresh", "share"]); // never consume the next arg
const argv = process.argv.slice(2);
const flags = {};
const positionals = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith("--")) {
    const key = a.slice(2);
    flags[key] = BOOL_FLAGS.has(key) || argv[i + 1]?.startsWith("--") || argv[i + 1] === undefined ? true : argv[++i];
  } else positionals.push(a);
}
const fileArg = positionals[0];
if (!fileArg || flags.help) {
  console.log("Usage: galley-lite <file.html> [--port 4321] [--model sonnet] [--fresh] [--no-open]");
  console.log("       advanced: [--resume <sessionId>] [--cwd <dir>]");
  console.log("  Opens the file in your browser; comment on elements or chat, and Claude edits it in place.");
  console.log("  Auto-links to the Claude Code session that built the file. --fresh skips it; --resume <id> forces one.");
  process.exit(flags.help ? 0 : 1); // --help is a successful invocation; only no-file-given is an error
}
const FILE = resolve(fileArg);
if (!existsSync(FILE)) {
  console.error("No such file:", FILE);
  process.exit(1);
}
const DIR = dirname(FILE);
const NAME = basename(FILE);
const PORT = Number(flags.port) || 4321;
const MODEL = typeof flags.model === "string" ? flags.model : "sonnet";

// Linked-session: a session marker baked into the HTML.
function detectMarkerSession() {
  try {
    const m = readFileSync(FILE, "utf8").match(/<!--\s*galley-session:\s*([A-Za-z0-9-]+)\s*-->/);
    return m?.[1] || null;
  } catch {
    return null;
  }
}

// Auto-link: find the Claude Code session that actually built this file (a Write
// to its absolute path), so `galley-lite <file>` links itself with no flags. We
// also recover that session's cwd, since --resume only resolves from its project
// dir. Scans the newest transcripts first and stops at the first match.
function autodetectSession() {
  try {
    const root = join(homedir(), ".claude", "projects");
    if (!existsSync(root)) return null;
    const files = [];
    for (const proj of readdirSync(root)) {
      const pdir = join(root, proj);
      let st;
      try {
        st = statSync(pdir);
      } catch {
        continue;
      }
      if (!st.isDirectory()) continue;
      for (const f of readdirSync(pdir)) {
        if (!f.endsWith(".jsonl")) continue;
        const fp = join(pdir, f);
        try {
          files.push({ fp, id: f.slice(0, -6), mtime: statSync(fp).mtimeMs });
        } catch {
          /* ignore */
        }
      }
    }
    files.sort((a, b) => b.mtime - a.mtime);
    for (const { fp, id } of files.slice(0, 80)) {
      let raw;
      try {
        raw = readFileSync(fp, "utf8");
      } catch {
        continue;
      }
      if (raw.indexOf(FILE) < 0) continue; // quick prefilter
      // Precise: a Write/Edit tool_use whose file_path is exactly this file.
      let cwd = null;
      let wrote = false;
      for (const line of raw.split("\n")) {
        if (!line) continue;
        let o;
        try {
          o = JSON.parse(line);
        } catch {
          continue;
        }
        if (!cwd && typeof o.cwd === "string") cwd = o.cwd;
        const content = o.message && o.message.content;
        if (!Array.isArray(content)) continue;
        for (const b of content) {
          if (b && b.type === "tool_use" && (b.name === "Write" || b.name === "Edit" || b.name === "MultiEdit") && b.input && b.input.file_path === FILE) {
            wrote = true;
          }
        }
      }
      if (wrote) return { id, cwd };
    }
  } catch {
    /* ignore */
  }
  return null;
}

const linkOff = flags["no-link"] === true || flags.fresh === true;
let sessionId = null;
let autoCwd = null;
let linkMode = "fresh"; // fresh | resume | marker | auto
if (typeof flags.resume === "string") {
  sessionId = flags.resume;
  linkMode = "resume";
} else if (!linkOff) {
  const marker = detectMarkerSession();
  if (marker) {
    sessionId = marker;
    linkMode = "marker";
  } else {
    const det = autodetectSession();
    if (det) {
      sessionId = det.id;
      autoCwd = det.cwd;
      linkMode = "auto";
    }
  }
}
const startedLinked = !!sessionId;

// Directory the agent runs in. Resuming a session built elsewhere must run from
// THAT session's project dir (sessions are stored per-cwd); the file is still
// edited by absolute path, so it works regardless of cwd.
const AGENT_CWD = typeof flags.cwd === "string" ? resolve(flags.cwd) : autoCwd || DIR;

// ---- share / trusted-pair collaboration (opt-in, --share) ----------------------
// SAFETY MODEL: a remote guest can NEVER act directly. Guests reach a page that
// never embeds the host CSRF token; their requests carry only a separate share
// token, and every guest turn is GATED ON THE HOST'S EXPLICIT APPROVAL (the host
// reads the literal prompt before it runs). Plus expiry + a turn budget + an
// append-only audit log. This is the owner-gated model — not "open a tunnel and
// hope." Host = loopback (no tunnel headers). Guest = arrives through the tunnel.
const SHARE = flags.share === true;
const SHARE_TOKEN = SHARE ? randomUUID() : null;
const SHARE_TTL_MIN = Number(flags["share-ttl"]) || 120;
const SHARE_EXPIRES = SHARE ? Date.now() + SHARE_TTL_MIN * 60_000 : 0;
const SHARE_CAP = Number(flags["share-cap"]) || 40; // max guest-approved turns
let guestTurns = 0;
const AUDIT = join(homedir(), ".galley-lite-audit.jsonl");
function audit(ev) {
  if (!SHARE) return;
  try {
    appendFileSync(AUDIT, JSON.stringify({ ts: new Date().toISOString(), file: FILE, ...ev }) + "\n");
  } catch {
    /* ignore */
  }
}
let tunnelHost = null; // the trycloudflare hostname, once the tunnel is up
// A request is a tunnel/guest request if ANY forwarding header is present — we
// treat anything proxied as untrusted. The host is additionally required to be on
// a real loopback socket (below), so an absent-header proxied request still can't
// claim host. --share requires cloudflared (which stamps cf-connecting-ip), so a
// genuine guest always trips this; see startShare.
function isTunnelReq(req) {
  return !!(req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"] || req.headers["x-real-ip"] || req.headers["forwarded"]);
}
function isLoopback(req) {
  const a = req.socket && req.socket.remoteAddress;
  return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1";
}
// Host = a genuinely local request (loopback socket, no forwarding header). Used
// for everything host-privileged so a forwarded/rebound request can never be host.
function isHostReq(req) {
  return isLoopback(req) && !isTunnelReq(req);
}
function eq(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
function shareValid(req) {
  return SHARE && Date.now() < SHARE_EXPIRES && typeof req.headers["x-galley-share"] === "string" && eq(req.headers["x-galley-share"], SHARE_TOKEN);
}
function shareKeyValid(k) {
  return SHARE && Date.now() < SHARE_EXPIRES && typeof k === "string" && eq(k, SHARE_TOKEN);
}
// Defeat DNS-rebinding: only serve requests whose Host header is one we expect.
function validHost(req) {
  const h = (req.headers.host || "").toLowerCase();
  if (!h) return false;
  const hostname = h.split(":")[0];
  if (hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "[::1]") return true;
  if (SHARE && tunnelHost && hostname === tunnelHost.toLowerCase()) return true;
  return false;
}
// Pending guest requests awaiting host approval.
const approvals = new Map(); // id -> { who, userText, comments, message }

// Deny-list passed to the agent: it edits the user's document, but it must not be
// usable (by a malicious opened HTML, or a tricked share approval) to read secrets
// or write persistence/RCE paths. Verified: blocks .env/~/.ssh reads, edits still work.
const AGENT_DENY = JSON.stringify({
  permissions: {
    // Scope the agent's file MUTATIONS to the document's own directory. Combined
    // with --permission-mode default (below), an Edit/Write outside DIR has no
    // allow rule and can't prompt in -p mode, so it's blocked — a malicious
    // document can't drive the agent to rewrite files elsewhere on disk. Reads
    // stay broad (minus the secret deny-list) so the agent keeps full context.
    allow: [
      "Read(//**)",
      "Grep",
      "Glob",
      `Edit(/${DIR}/**)`,
      `Write(/${DIR}/**)`,
    ],
    deny: [
      "Read(~/.ssh/**)",
      "Read(~/.aws/**)",
      "Read(~/.gnupg/**)",
      "Read(~/.config/gh/**)",
      "Read(~/.netrc)",
      "Read(~/.claude/**)",
      "Read(//**/.env)",
      "Read(//**/.env.*)",
      "Read(//**/*.pem)",
      "Read(//**/id_rsa*)",
      "Read(//**/id_ed25519*)",
      "Read(//**/credentials)",
      "Write(~/.zshrc)",
      "Write(~/.bashrc)",
      "Write(~/.bash_profile)",
      "Write(~/.profile)",
      "Edit(~/.zshrc)",
      "Edit(~/.bashrc)",
      "Write(//**/.git/hooks/**)",
      "Edit(//**/.git/hooks/**)",
    ],
  },
});

// ---- claude batch edit (streamed) ----------------------------------------------
function describeTool(name, input = {}) {
  const base = (p) => (typeof p === "string" ? p.split("/").pop() : "");
  switch (name) {
    case "Read":
      return "Reading " + base(input.file_path);
    case "Edit":
    case "MultiEdit":
      return "Editing " + base(input.file_path);
    case "Write":
      return "Writing " + base(input.file_path);
    case "Grep":
    case "Glob":
      return "Searching “" + String(input.pattern || input.query || "").slice(0, 50) + "”";
    case "Bash":
      return "Running: " + String(input.command || "").slice(0, 60);
    case "TodoWrite":
      return "Planning…";
    default:
      return name;
  }
}

// Build the prompt for one conversational turn: optional anchored comments plus an
// optional free-text message. Claude may answer, edit the file, or both.
function buildTurnPrompt(comments, message) {
  const lines = [
    `You are in an ongoing conversation with a user who is viewing this live document in their browser:`,
    `  ${FILE}`,
    `Respond conversationally. If they ask for changes, edit the file in place with your tools (preserve everything else; keep valid HTML). If they're only asking a question or discussing, just answer — do not edit. Keep replies brief and to the point.`,
    `IMPORTANT: before making any edit, re-Read the file first. It may have changed since your last turn — the user can Undo, or edit it externally — so your remembered version may be stale.`,
    ``,
  ];
  if (comments.length) {
    lines.push(`They left ${comments.length} comment(s) anchored to elements on the page:`);
    comments.forEach((c, i) => {
      lines.push(`${i + 1}. on <${c.tag || "element"}>${c.sel ? ` (selected text: "${String(c.sel).slice(0, 80)}")` : ""}: "${c.comment}"`);
      lines.push(`   element: ${String(c.outerHTML || "").slice(0, 1200)}`);
    });
    lines.push("");
  }
  if (message && message.trim()) lines.push(`Message: "${message.trim()}"`);
  return lines.join("\n");
}

// A persistent, warm `claude` process for this doc's whole session. It boots once
// (resuming the linked build session if any), keeps the document + conversation in
// context, and serves each turn over stdin — so follow-ups skip both the process
// boot AND re-reading the file. Verified: stream-json + Edit/Write + acceptEdits
// edits without a permission hang, and --resume restores context.
// Deterministic, append-only event log for journey/metrics verification — one
// JSON object per line. OFF by default so normal runs stay side-effect-free; a
// harness opts in with GALLEY_EVENTS=1 (default path) or GALLEY_EVENTS_LOG=/path.
const EVENTS_LOG = process.env.GALLEY_EVENTS_LOG || (process.env.GALLEY_EVENTS ? join(homedir(), ".galley-lite-events.jsonl") : null);
const RUN_ID = randomUUID().slice(0, 8);
let _turnSeq = 0;
const nextTurnId = () => `t${++_turnSeq}`;
let currentTurnId = null; // the turn actively running (for stop attribution)
function logEvent(type, data = {}) {
  if (!EVENTS_LOG) return;
  try {
    appendFileSync(EVENTS_LOG, JSON.stringify({ ts: Date.now(), run: RUN_ID, file: FILE, type, ...data }) + "\n");
  } catch { /* never let logging break a turn */ }
}

class ClaudeAgent {
  constructor() {
    this.child = null;
    this.buf = "";
    this.busy = false;
    this.onResult = null;
    this.onErr = null;
    this.onEvent = null;
  }
  start() {
    if (process.env.GALLEY_MOCK_AGENT) return;
    if (this.child && !this.child.killed) return;
    const args = [
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages", // stream the reply token-by-token
      "--permission-mode",
      "default", // not acceptEdits: unlisted paths can't auto-approve in -p, so Edit/Write is confined to the allow-list (the doc's dir) — see AGENT_DENY
      "--allowedTools",
      "Read Grep Glob", // Edit/Write are granted ONLY via the dir-scoped settings allow-list (AGENT_DENY); a bare "Edit Write" here would override that scoping and let the agent write anywhere

      "--settings",
      AGENT_DENY, // deny reading secrets / writing persistence paths — limits blast radius
      "--model",
      MODEL,
    ];
    if (sessionId) args.push("--resume", sessionId); // resume the build session ONCE
    // API-key-first: if ANTHROPIC_API_KEY is set, claude runs on the metered
    // Anthropic API (billed to that key — the supported, ToS-clean path). If it
    // isn't set, claude falls back to whatever auth it already has locally. We
    // neither inject nor strip the key: the user's own environment picks the mode.
    const env = { ...process.env };
    this.buf = "";
    this.child = spawn("claude", args, { cwd: AGENT_CWD, env });
    this._died = false;
    logEvent("agent_spawn", { withResume: !!sessionId, pid: this.child.pid });
    this.child.stdout.on("data", (d) => this._data(d));
    this.child.stderr.on("data", () => {});
    const die = (e) => {
      if (this._died) return; // idempotent — error + close both fire on one death
      this._died = true;
      this.child = null;
      const f = this.onErr;
      this.onErr = this.onResult = this.onEvent = null;
      const wasBusy = this.busy;
      this.busy = false;
      logEvent("agent_died", { reason: String((e && e.message) || e), midTurn: wasBusy });
      if (f) f(e);
    };
    this.child.on("close", () => die(new Error("claude process exited")));
    this.child.on("error", (e) => die(e));
  }
  _data(d) {
    this.buf += d.toString();
    let nl;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      if (ev.type === "stream_event") {
        // Token-by-token text deltas for the live-typing reply.
        const d2 = ev.event;
        if (d2?.type === "content_block_delta" && d2.delta?.type === "text_delta" && d2.delta.text && this.onEvent) {
          this.onEvent({ kind: "token", text: d2.delta.text });
        }
      } else if (ev.type === "assistant") {
        for (const b of ev.message?.content || []) {
          if (b.type !== "tool_use" || !this.onEvent) continue;
          const input = b.input || {};
          this.onEvent({ kind: "tool", text: describeTool(b.name, input), name: b.name, n: b.name === "MultiEdit" ? ((input.edits && input.edits.length) || 1) : 1 });
          // Capture the agent's OWN edits — this is the faithful source for the
          // "what changed" readout (what the agent changed, not what the user
          // clicked). Edit/MultiEdit carry new_string(s); Write replaces the file.
          if (b.name === "Edit" || b.name === "MultiEdit" || b.name === "Write") {
            const newStrings =
              b.name === "MultiEdit"
                ? (Array.isArray(input.edits) ? input.edits.map((e) => e && e.new_string).filter((s) => typeof s === "string") : [])
                : typeof input.new_string === "string"
                ? [input.new_string]
                : [];
            this.onEvent({ kind: "edit", tool: b.name, filePath: input.file_path || "", newStrings });
          }
        }
      } else if (ev.type === "result") {
        if (ev.session_id) sessionId = ev.session_id; // chain forward (for respawn/marker)
        const reply = typeof ev.result === "string" ? ev.result.slice(0, 8000) : "";
        const ok = !ev.is_error;
        const f = this.onResult;
        this.onResult = this.onErr = this.onEvent = null;
        this.busy = false;
        if (f) f({ ok, reply: reply || "done" });
      }
    }
  }
  // One turn. Resolves { ok, reply }. Never rejects (errors come back as a reply).
  send(text, onEvent) {
    if (process.env.GALLEY_MOCK_AGENT) {
      const ms = +(process.env.GALLEY_MOCK_AGENT) || 100;
      return new Promise((resolve) => setTimeout(() => resolve({ ok: true, reply: `[mock] ${text.slice(0, 60)}` }), ms));
    }
    return new Promise((resolve) => {
      this.start();
      if (!this.child) return resolve({ ok: false, reply: "Could not start claude. Is Claude Code installed + logged in?" });
      if (this.busy) return resolve({ ok: false, reply: "agent busy — wait for the current turn" });
      this.busy = true;
      this.onEvent = onEvent;
      const timer = setTimeout(() => {
        this.onResult = this.onErr = this.onEvent = null;
        this.busy = false;
        this.close(); // kill the wedged child so the NEXT turn respawns clean
        resolve({ ok: false, reply: "turn timed out" });
      }, 600_000);
      this.onResult = (r) => {
        clearTimeout(timer);
        resolve(r);
      };
      this.onErr = (e) => {
        clearTimeout(timer);
        resolve({ ok: false, reply: "agent error: " + String(e) });
      };
      try {
        this.child.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } }) + "\n");
      } catch (e) {
        clearTimeout(timer);
        this.busy = false;
        this.onResult = this.onErr = this.onEvent = null;
        resolve({ ok: false, reply: "could not send: " + String(e) });
      }
    });
  }
  close() {
    if (!this.child) return;
    const c = this.child;
    this.child = null;
    try {
      c.stdin.end();
    } catch {
      /* ignore */
    }
    setTimeout(() => {
      try {
        c.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }, 800);
  }
  // Synchronous kill for process-exit handlers — close()'s 800ms timer never
  // fires before process.exit(), which would orphan the child (holding a sub slot).
  killSync() {
    if (!this.child) return;
    try {
      this.child.kill("SIGKILL");
    } catch {
      /* ignore */
    }
    this.child = null;
  }
}
const agent = new ClaudeAgent();

// ---- conversation thread (persists across reloads) -----------------------------
const thread = []; // { role: "user" | "assistant", text }

// ---- undo stack ----------------------------------------------------------------
// Bounded by both count and TOTAL BYTES — 50 copies of a 10MB generated doc would
// be 500MB resident, so cap the aggregate too.
const undoStack = [];
const UNDO_MAX = 50;
const UNDO_MAX_BYTES = 64 * 1024 * 1024;
function undoBytes() {
  let n = 0;
  for (const s of undoStack) n += s.length;
  return n;
}
function snapshot() {
  try {
    undoStack.push(readFileSync(FILE, "utf8"));
    while (undoStack.length > UNDO_MAX || (undoStack.length > 1 && undoBytes() > UNDO_MAX_BYTES)) undoStack.shift();
  } catch {
    /* ignore */
  }
}

// ---- SSE clients ---------------------------------------------------------------
const clients = new Set();
function broadcast(obj) {
  const line = `data: ${JSON.stringify(obj)}\n\n`;
  for (const res of clients) {
    try {
      res.write(line);
    } catch {
      /* dropped client */
    }
  }
}
function sendPresence() {
  if (!SHARE) return;
  let hosts = 0;
  let guests = 0;
  for (const c of clients) c._glGuest ? guests++ : hosts++;
  broadcast({ type: "presence", hosts, guests });
}

// While a turn is running, Claude may make several edits; suppress per-edit
// reloads so the page doesn't refresh out from under the live activity view. One
// reload is sent when the turn finishes. Owned by the turn queue (set true while
// a turn runs, false when the queue is idle) — never per-request, which used to
// let a fast-rejected concurrent request unsuppress reloads mid-turn.
let editing = false;

// Live reload: watch the file, debounce, tell browsers to reload. Re-arm on every
// event because an atomic save (write-temp + rename) swaps the inode and a single
// fs.watch would silently stop firing — killing live-reload for the rest of the run.
let reloadTimer = null;
function armWatch() {
  try {
    const w = watch(FILE, () => {
      try {
        w.close();
      } catch {
        /* ignore */
      }
      if (!editing) {
        clearTimeout(reloadTimer);
        reloadTimer = setTimeout(() => { broadcast({ type: "reload", external: true }); logEvent("file_reloaded", { source: "external" }); }, 150);
      }
      setTimeout(armWatch, 200); // re-arm after the (possibly inode-swapping) write settles
    });
  } catch {
    /* some platforms; ignore */
  }
}
armWatch();

function safeJson(str) {
  try {
    return JSON.parse(str || "{}");
  } catch {
    return {};
  }
}

// ---- change tracking: the faithful "what changed" readout ----------------------
// The readout must reflect what the AGENT actually changed (its own Edit/Write
// fragments + a before/after content compare), NOT what the user clicked. Each
// turn's change is stored under a monotonic id; the client fetches it after reload.
let changeSeq = 0;
const changes = new Map(); // id -> change object
const CHANGES_MAX = 30;
const FRAG_CAP = 25; // beyond this, a turn is a "large edit", not an enumeration
function putChange(obj) {
  const id = ++changeSeq;
  changes.set(id, { id, ...obj });
  while (changes.size > CHANGES_MAX) changes.delete(changes.keys().next().value);
  return id;
}
// Is source offset `idx` inside a <tag>…</tag> block (so a CSS/JS edit isn't
// reported as a changed visible element)?
function enclosedBy(after, idx, tag) {
  const open = after.lastIndexOf("<" + tag, idx);
  if (open < 0) return false;
  const close = after.indexOf("</" + tag + ">", open);
  return close < 0 || close > idx;
}
function classifyFragment(after, text) {
  const idx = after.indexOf(text);
  if (idx < 0) return "visual"; // reformatted/not found verbatim — assume visible
  if (enclosedBy(after, idx, "style")) return "style";
  if (enclosedBy(after, idx, "script")) return "script";
  return "visual";
}
// Pure (unit-testable): derive the change payload from before/after content + the
// agent's own edit fragments. kind ∈ none | edit | write.
function computeChange(before, after, edits) {
  const contentChanged = before !== after;
  const byteDelta = after.length - before.length;
  if (!contentChanged) return { kind: "none", contentChanged: false, fragments: [], byteDelta: 0 };
  const hasWrite = edits.some((e) => e.tool === "Write");
  const frags = [];
  for (const e of edits) {
    if (e.tool === "Write") continue; // whole-file rewrite: not granular
    for (const ns of e.newStrings || []) {
      const t = String(ns || "").trim();
      if (t) frags.push(t);
    }
  }
  // Whole-file Write, a reformat with no captured Edit fragments, or a huge edit:
  // don't fake an element count — say "rewrote the page".
  if (hasWrite || frags.length === 0 || frags.length > FRAG_CAP) {
    return { kind: "write", contentChanged: true, fragments: [], byteDelta, fragCount: frags.length };
  }
  const seen = new Set();
  const fragments = [];
  for (const text of frags) {
    const key = text.slice(0, 200);
    if (seen.has(key)) continue;
    seen.add(key);
    fragments.push({ text: text.slice(0, 4000), type: classifyFragment(after, text) });
  }
  return { kind: "edit", contentChanged: true, fragments, byteDelta };
}

// Explicit turn queue: items are inspectable/reorderable/cancellable.
// addToQueue() enqueues and returns the id synchronously; results come back via SSE.
const pendingQueue = []; // { id, comments, message, userText }
let queueRunning = false;

function broadcastQueue() {
  broadcast({ type: "queue", items: pendingQueue.map((q, i) => ({ id: q.id, text: q.userText, position: i })) });
}

function drainQueue() {
  if (queueRunning || !pendingQueue.length) return;
  queueRunning = true;
  const item = pendingQueue.shift();
  broadcastQueue();
  logEvent("turn_dequeued", { id: item.id, remaining: pendingQueue.length });
  runTurn(item.comments, item.message, item.userText).finally(() => {
    queueRunning = false;
    drainQueue();
  });
}

function addToQueue(comments, message, userText) {
  const id = randomUUID().slice(0, 8);
  pendingQueue.push({ id, comments, message, userText });
  logEvent("turn_queued", { id, depth: pendingQueue.length, running: queueRunning });
  broadcastQueue();
  drainQueue();
  return id;
}

// One serialized conversational turn. Pushes the user turn, runs the agent (with
// activity streamed to all clients + the terminal), records the reply, and reloads
// the doc only if the file actually changed.
async function runTurn(comments, message, userText) {
  const turnId = nextTurnId();
  currentTurnId = turnId;
  const t0 = Date.now();
  let firstTokenAt = 0;
  thread.push({ role: "user", text: userText });
  broadcast({ type: "turn", role: "user", text: userText });
  process.stdout.write(`\n\x1b[1m\x1b[38;5;209m› you\x1b[0m\n${userText}\n`);
  logEvent("turn_started", { turnId, comments_n: comments.length, text_len: userText.length });

  let beforeContent = "";
  try {
    beforeContent = readFileSync(FILE, "utf8");
  } catch {
    /* ignore */
  }
  snapshot();
  editing = true;
  const editEvents = []; // the agent's own Edit/Write fragments, this turn
  let out;
  try {
    out = await agent.send(buildTurnPrompt(comments, message), (e) => {
      if (e.kind === "token") {
        if (!firstTokenAt) { firstTokenAt = Date.now(); logEvent("turn_first_token", { turnId, ms: firstTokenAt - t0 }); }
        broadcast({ type: "token", text: e.text }); // live-typing reply
      } else if (e.kind === "edit") {
        editEvents.push(e);
      } else {
        if (e.kind === "tool") logEvent("tool_used", { turnId, tool: e.name || null, n: e.n || 1 });
        broadcast({ type: "activity", kind: e.kind, text: e.text });
        if (e.kind === "tool" || e.kind === "error") process.stdout.write(`\x1b[2m  · ${e.text}\x1b[0m\n`);
      }
    });
  } finally {
    editing = false;
  }
  if (out.reply && out.reply.trim()) thread.push({ role: "assistant", text: out.reply });
  while (thread.length > 400) thread.shift(); // bound memory + /thread payload
  broadcast({ type: "turn-end", reply: out.reply || "" });
  process.stdout.write(`\x1b[1m\x1b[38;5;79m‹ claude\x1b[0m\n${out.reply}\n`);

  // Faithful "what changed" readout: compare before/after CONTENT (not mtime — a
  // no-op/whitespace rewrite must not report "updated"), attributed by the agent's
  // own edits. Persist under a changeId the client fetches AFTER the reload.
  let afterContent = "";
  try {
    afterContent = readFileSync(FILE, "utf8");
  } catch {
    /* ignore */
  }
  const change = computeChange(beforeContent, afterContent, editEvents);
  const editsN = editEvents.reduce((a, e) => a + ((e.newStrings && e.newStrings.length) || 1), 0);
  if (change.contentChanged) {
    const changeId = putChange(change);
    broadcast({ type: "reload", changed: true, changeId });
    logEvent("edit_applied", { turnId, edits_n: editsN });
    logEvent("file_reloaded", { turnId, changeId });
  }
  logEvent("turn_completed", { turnId, ok: !!out.ok, changed: !!change.contentChanged, edits_n: editsN, duration_ms: Date.now() - t0, reply_len: (out.reply || "").length });
  currentTurnId = null;
  const visN = change.fragments.filter((f) => f.type === "visual").length;
  process.stdout.write(
    `\x1b[2m  · change: ${change.kind} ${change.byteDelta >= 0 ? "+" : ""}${change.byteDelta}b · ${change.fragments.length} frag (${visN} visual) · ${editEvents.length} edit-call(s)\x1b[0m\n`
  );
  return out;
}

// ---- overlay -------------------------------------------------------------------
const OVERLAY = /* html */ `
<style id="galley-lite-style">
  #gl-bar{position:fixed;left:16px;bottom:16px;z-index:2147483647;display:flex;align-items:center;gap:10px;
    background:#1b1a18;color:#f2ede3;font:13px/1.3 ui-sans-serif,system-ui,-apple-system,sans-serif;
    padding:9px 12px;border-radius:12px;box-shadow:0 6px 24px rgba(0,0,0,.28);border:1px solid #3a3733}
  #gl-bar .gl-dot{width:8px;height:8px;border-radius:50%;background:#69b58a;transition:background .2s}
  #gl-bar.gl-working .gl-dot{background:#e0a44e;animation:gl-pulse 1s infinite}
  #gl-bar.gl-error .gl-dot{background:#d9694e}
  @keyframes gl-pulse{50%{opacity:.35}}
  #gl-bar button{font:inherit;color:inherit;background:#302d29;border:1px solid #46423c;border-radius:8px;padding:5px 9px;cursor:pointer;transition:transform .12s cubic-bezier(.23,1,.32,1),background .15s ease}
  #gl-bar button:active,#gl-send:active,#gl-pop button:active{transform:scale(.95)}
  #gl-bar button:hover{background:#3a3631}
  #gl-bar button.gl-on{background:#c4623f;border-color:#c4623f;color:#fff}
  #gl-bar .gl-muted{color:#9a948a}
  .gl-hi{outline:2px solid #c4623f !important;outline-offset:1px;cursor:crosshair !important;background:rgba(196,98,63,.06) !important}
  #gl-pop{position:fixed;z-index:2147483647;width:300px;background:#fbf8f1;color:#1b1a18;border:1px solid #d8d1c4;
    border-radius:12px;box-shadow:0 10px 36px rgba(0,0,0,.22);font:13px/1.4 ui-sans-serif,system-ui,sans-serif;overflow:hidden;
    transform-origin:top left;animation:gl-pop .19s cubic-bezier(.23,1,.32,1)}
  #gl-pop .gl-tag{padding:7px 10px;background:#f1ece1;border-bottom:1px solid #e3dccd;color:#6a6358;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  #gl-pop textarea{width:100%;border:0;outline:0;padding:10px;font:inherit;resize:vertical;min-height:64px;background:transparent;box-sizing:border-box}
  #gl-pop .gl-row{display:flex;gap:8px;justify-content:flex-end;padding:8px 10px;border-top:1px solid #e3dccd}
  #gl-pop button{font:inherit;border-radius:8px;padding:6px 11px;cursor:pointer;border:1px solid #d8d1c4;background:#fff}
  #gl-pop button.gl-go{background:#c4623f;color:#fff;border-color:#c4623f}
  #gl-panel{--gl-panel-width:340px;position:fixed;top:0;right:0;bottom:0;width:var(--gl-panel-width);z-index:2147483646;background:#1b1a18;color:#f2ede3;
    font:13px/1.45 ui-sans-serif,system-ui,sans-serif;box-shadow:-8px 0 30px rgba(0,0,0,.25);border-left:1px solid #3a3733;
    transform:translateX(100%);transition:transform .36s cubic-bezier(.32,.72,0,1);display:flex;flex-direction:column}
  #gl-panel.gl-show{transform:none}
  /* motion (Emil Kowalski principles): strong ease-out, blur-bridged reveals, press feedback, never scale(0) */
  @keyframes gl-rise{from{opacity:0;transform:translateY(8px) scale(.985);filter:blur(6px)}to{opacity:1;transform:none;filter:blur(0)}}
  @keyframes gl-pop{from{opacity:0;transform:scale(.94);filter:blur(4px)}to{opacity:1;transform:scale(1);filter:blur(0)}}
  @media (prefers-reduced-motion:reduce){.gl-bubble,#gl-pop,.gl-chip,.gl-badge{animation:none !important}}
  #gl-panel header{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;border-bottom:1px solid #322f2b}
  #gl-panel .gl-x{background:none;border:0;color:#9a948a;cursor:pointer;font-size:17px;line-height:1}
  #gl-thread{flex:1;overflow:auto;padding:12px;display:flex;flex-direction:column;gap:9px}
  .gl-bubble{max-width:88%;padding:8px 11px;border-radius:13px;white-space:pre-wrap;word-break:break-word;font-size:12.5px;line-height:1.5;animation:gl-rise .28s cubic-bezier(.23,1,.32,1)}
  .gl-user{align-self:flex-end;background:#c4623f;color:#fff;border-bottom-right-radius:4px}
  .gl-asst{align-self:flex-start;background:#262321;color:#ece6da;border:1px solid #322f2b;border-bottom-left-radius:4px}
  .gl-empty{color:#8f897e;padding:16px 8px;text-align:center}
  .gl-act{align-self:flex-start;display:flex;gap:6px;font:11.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:#8f897e;padding-left:2px}
  .gl-act-tool{color:#b9b1a3}
  .gl-act-error{color:#d9694e}
  #gl-pending{display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:0 10px 2px}
  #gl-pending .gl-pendlbl{width:100%;color:#8f897e;font-size:10.5px;letter-spacing:.02em;padding:2px 0}
  .gl-chip{display:inline-flex;align-items:center;gap:6px;max-width:100%;background:#2c2926;border:1px solid #3a3733;border-radius:20px;padding:4px 6px 4px 9px;font-size:11px;color:#d8d1c4;animation:gl-pop .2s cubic-bezier(.23,1,.32,1)}
  .gl-chip .gl-chip-n{color:#c4623f;font-weight:600}
  .gl-chip .gl-chip-t{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:150px}
  .gl-chip button{background:none;border:0;color:#8f897e;cursor:pointer;font-size:13px;padding:0}
  #gl-compose{display:flex;gap:8px;padding:10px;border-top:1px solid #322f2b}
  #gl-input{flex:1;background:#232120;color:#f2ede3;border:1px solid #3a3733;border-radius:10px;padding:8px 10px;font:inherit;resize:none;min-height:38px;max-height:130px;box-sizing:border-box}
  #gl-input:focus{outline:0;border-color:#c4623f}
  #gl-send{border:0;border-radius:10px;background:#c4623f;color:#fff;font:inherit;font-weight:600;padding:0 14px;cursor:pointer}
  #gl-send[disabled]{opacity:.4;cursor:default}
  .gl-badge{position:absolute;z-index:2147483645;min-width:18px;height:18px;padding:0 4px;border-radius:9px;background:#c4623f;color:#fff;animation:gl-pop .24s cubic-bezier(.23,1,.32,1);
    font:11px/18px ui-sans-serif,system-ui,sans-serif;text-align:center;box-shadow:0 2px 6px rgba(0,0,0,.3);pointer-events:none}
  /* markdown inside assistant bubbles */
  .gl-asst p{margin:.3rem 0} .gl-asst p:first-child{margin-top:0} .gl-asst p:last-child{margin-bottom:0}
  .gl-asst strong{color:#fff;font-weight:600} .gl-asst em{font-style:italic}
  .gl-asst code{font-family:ui-monospace,Menlo,monospace;font-size:.92em;background:#1a1816;border:1px solid #3a3733;border-radius:4px;padding:0 4px}
  .gl-asst pre{background:#16140f;border:1px solid #322f2b;border-radius:8px;padding:8px 10px;overflow-x:auto;margin:.4rem 0}
  .gl-asst pre code{background:none;border:0;padding:0}
  .gl-asst ul,.gl-asst ol{margin:.3rem 0;padding-left:1.1rem} .gl-asst li{margin:.15rem 0}
  .gl-asst a{color:#e8a07a;text-decoration:underline}
  .gl-asst h1,.gl-asst h2,.gl-asst h3{font-size:1em;font-weight:600;color:#fff;margin:.4rem 0 .2rem}
  /* streaming caret */
  .gl-caret::after{content:"";display:inline-block;width:7px;height:1.05em;vertical-align:-2px;margin-left:1px;background:#e88a72;border-radius:1px;animation:gl-blink 1s steps(2) infinite}
  @keyframes gl-blink{50%{opacity:0}}
  .gl-warm{align-self:flex-start;display:flex;gap:7px;align-items:center;color:#9fb6c9;font-size:12px;padding:2px 2px}
  .gl-warm .gl-spin{width:10px;height:10px;border:2px solid #3a4750;border-top-color:#9fb6c9;border-radius:50%;animation:gl-rot .8s linear infinite}
  @keyframes gl-rot{to{transform:rotate(360deg)}}
  #gl-stop{border:1px solid #6a4a42;border-radius:8px;background:#3a2723;color:#ffd9cd;font:inherit;padding:5px 9px;cursor:pointer;display:none}
  #gl-stop.gl-on{display:inline-block}
  /* change pulse: flash elements the agent just edited */
  @keyframes gl-flash{0%{box-shadow:0 0 0 3px rgba(196,98,63,.0)}18%{box-shadow:0 0 0 3px rgba(196,98,63,.55);background:rgba(196,98,63,.10)}100%{box-shadow:0 0 0 3px rgba(196,98,63,0)}}
  .gl-changed{animation:gl-flash 1.6s ease-out}
  /* "what changed" count chip + stepper (the visual locator) */
  #gl-change-chip{position:fixed;right:16px;bottom:16px;z-index:2147483646;display:flex;align-items:center;gap:8px;
    background:#1b1a18;color:#f2ede3;border:1px solid #3a3733;border-radius:20px;padding:6px 8px 6px 12px;
    font:12.5px/1.2 ui-sans-serif,system-ui,sans-serif;box-shadow:0 6px 22px rgba(0,0,0,.3);
    animation:gl-pop .22s cubic-bezier(.23,1,.32,1);transition:opacity .55s ease}
  #gl-change-chip.gl-fade{opacity:0}
  #gl-change-chip .gl-cc-dot{width:8px;height:8px;border-radius:50%;background:#c4623f;flex:none}
  #gl-change-chip .gl-cc-l{font-weight:600;white-space:nowrap}
  #gl-change-chip .gl-step{background:#302d29;border:1px solid #46423c;color:#f2ede3;border-radius:7px;cursor:pointer;font:inherit;line-height:1;padding:3px 8px}
  #gl-change-chip .gl-step:hover{background:#3a3631}
  #gl-change-chip .gl-step-i{color:#9a948a;font-size:11px;min-width:30px;text-align:center}
  #gl-change-chip .gl-cc-x{background:none;border:0;color:#8f897e;cursor:pointer;font-size:15px;line-height:1;padding:0 2px}
  #gl-change-chip .gl-cc-x:hover{color:#f2ede3}
  #gl-frameflash{position:fixed;inset:0;z-index:2147483640;pointer-events:none;box-shadow:inset 0 0 0 3px rgba(196,98,63,.5);animation:gl-framefade 1.4s ease-out forwards}
  @keyframes gl-framefade{0%{opacity:0}20%{opacity:1}100%{opacity:0}}
  #gl-toast{position:fixed;left:50%;top:18px;transform:translateX(-50%) translateY(-12px);z-index:2147483647;opacity:0;
    background:#1b1a18;color:#f2ede3;border:1px solid #3a3733;border-radius:20px;padding:7px 15px;font:13px ui-sans-serif,system-ui,sans-serif;
    box-shadow:0 8px 24px rgba(0,0,0,.25);transition:opacity .25s,transform .25s;pointer-events:none}
  #gl-toast.gl-show{opacity:1;transform:translateX(-50%) translateY(0)}
  /* share: approval cards + guest bar */
  #gl-approvals{padding:8px 10px 0;display:flex;flex-direction:column;gap:8px}
  .gl-appr{border:1px solid #b8741b;border-radius:10px;background:#2a2117;padding:9px 10px}
  .gl-appr-h{color:#e0a44e;font-size:11px;font-weight:600;margin-bottom:3px}
  .gl-appr-t{color:#ece6da;font-size:12.5px;white-space:pre-wrap;word-break:break-word;margin-bottom:8px}
  .gl-appr-r{display:flex;gap:8px;justify-content:flex-end}
  .gl-appr-r button{border:0;border-radius:8px;font:inherit;font-size:12px;padding:5px 12px;cursor:pointer}
  .gl-appr-r .gl-app{background:#69b58a;color:#11281c;font-weight:600}
  .gl-appr-r .gl-rej{background:#3a2723;color:#ffd9cd;border:1px solid #6a4a42}
  .gl-guestbar{margin:8px 10px 0;padding:7px 10px;border-radius:9px;background:#23303a;border:1px solid #2d4754;color:#bcd2dd;font-size:11.5px;line-height:1.4}
  #gl-queue{padding:0 10px 4px;display:flex;flex-direction:column;gap:4px}
  .gl-qi{display:flex;align-items:center;gap:6px;background:#1e1c19;border:1px solid #3a3733;border-radius:8px;padding:5px 8px;font-size:11.5px;color:#c8c0b4}
  .gl-qi .gl-qi-n{color:#9a948a;font-weight:600;flex:none}
  .gl-qi .gl-qi-t{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .gl-qi-lbl{color:#8f897e;font-size:10.5px;padding:2px 0 4px}
  .gl-qi button{background:none;border:0;color:#6a6258;cursor:pointer;font-size:12px;padding:0 2px;line-height:1}
  .gl-qi button:hover{color:#f2ede3}
</style>
<div id="gl-bar">
  <span class="gl-dot"></span>
  <button id="gl-toggle">💬 Comment</button>
  <button id="gl-list">Chat</button>
  <button id="gl-undo">Undo</button>
  <button id="gl-stop">Stop</button>
  <span class="gl-muted" id="gl-status">galley-lite · ${MODEL}${startedLinked ? " · linked" : ""}</span>
</div>
<div id="gl-toast"></div>
<div id="gl-panel">
  <header><b>Conversation</b><button class="gl-x" id="gl-close">×</button></header>
  <div id="gl-thread"></div>
  <div id="gl-queue"></div>
  <div id="gl-pending"></div>
  <div id="gl-compose">
    <textarea id="gl-input" rows="1" placeholder="Message Claude…  (turn on Comment to attach elements)"></textarea>
    <button id="gl-send" disabled>Send</button>
  </div>
</div>
<script>
(function(){
  __GL_AUTH__
  function authHeaders(extra){ var h=extra||{}; if(GL_ROLE==='guest') h['x-galley-share']=GL_SHARE; else h['x-galley-token']=GL_TOKEN; return h; }
  var picking=false, pop=null, hovered=null, pending=[], nextId=1, turnActive=false, emptyShown=false;
  function byId(i){return document.getElementById(i);}
  var bar=byId('gl-bar'), toggle=byId('gl-toggle'), undo=byId('gl-undo'), statusEl=byId('gl-status'),
      panel=byId('gl-panel'), thread=byId('gl-thread'), queueEl=byId('gl-queue'), pendEl=byId('gl-pending'),
      input=byId('gl-input'), sendBtn=byId('gl-send');
  function inUI(el){ return el && el.closest && (el.closest('#gl-bar')||el.closest('#gl-pop')||el.closest('#gl-panel')||el.closest('.gl-badge')); }
  function setStatus(t){ statusEl.textContent=t; }
  function esc(s){ return String(s).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];}); }
  function clearHi(){ if(hovered){hovered.classList.remove('gl-hi'); hovered=null;} }
  // Push the document left so the panel doesn't cover content (or the comment pins).
  function panelWidth(){ return parseInt(getComputedStyle(panel).getPropertyValue('--gl-panel-width'),10)||340; }
  function showPanel(){ panel.classList.add('gl-show'); document.documentElement.style.transition='margin-right .22s ease'; document.documentElement.style.marginRight=panelWidth()+'px'; setTimeout(positionBadges,240); try{sessionStorage.setItem('gl-panel','1');}catch(e){} }
  function hidePanel(){ panel.classList.remove('gl-show'); document.documentElement.style.marginRight=''; setTimeout(positionBadges,240); try{sessionStorage.removeItem('gl-panel');}catch(e){} }
  function togglePanel(){ if(panel.classList.contains('gl-show')) hidePanel(); else showPanel(); }
  function atBottom(){ return thread.scrollHeight-thread.scrollTop-thread.clientHeight < 60; }
  function scroll(){ thread.scrollTop=thread.scrollHeight; }

  function setPicking(on){ picking=on; toggle.classList.toggle('gl-on',on); document.body.style.cursor=on?'crosshair':''; if(!on){clearHi(); closePop();} }
  toggle.onclick=function(){ setPicking(!picking); if(picking) showPanel(); };
  byId('gl-list').onclick=togglePanel;
  byId('gl-close').onclick=hidePanel;

  document.addEventListener('mousemove',function(e){ if(!picking||pop) return; var el=e.target; if(inUI(el)){clearHi();return;} if(el!==hovered){clearHi(); hovered=el; el.classList.add('gl-hi');} },true);
  document.addEventListener('click',function(e){ if(!picking||inUI(e.target)) return; e.preventDefault(); e.stopPropagation();
    var el=e.target; clearHi();
    var clone=el.cloneNode(true); if(clone.classList) clone.classList.remove('gl-hi');
    var outer=clone.outerHTML||el.textContent||''; var sel=String(window.getSelection()).trim();
    openPop(e.clientX,e.clientY,el,outer,sel); },true);
  document.addEventListener('keydown',function(e){ if(e.key==='Escape'){ closePop(); setPicking(false);} });

  function closePop(){ if(pop){pop.remove(); pop=null;} }
  function openPop(x,y,el,outer,sel){
    closePop();
    pop=document.createElement('div'); pop.id='gl-pop';
    var tag=(el.tagName||'el').toLowerCase()+(el.id?('#'+el.id):'');
    var single=pending.length===0; // one element, nothing queued → Enter sends
    pop.innerHTML='<div class="gl-tag">&lt;'+esc(tag)+'&gt;'+(sel?(' · "'+esc(sel.slice(0,40))+'"'):'')+'</div>'+
      '<textarea placeholder="'+(single?'Describe the change… (Enter sends)':'What about this? (adds to your message)')+'"></textarea>'+
      '<div class="gl-row"><button class="gl-cancel">Cancel</button>'+(single?'<button class="gl-stack" title="pin this and keep adding">+ pin</button>':'')+'<button class="gl-go">'+(single?'Send ⏎':'Attach ⏎')+'</button></div>';
    document.body.appendChild(pop);
    var px=Math.min(x,window.innerWidth-316), py=Math.min(y,window.innerHeight-180);
    pop.style.left=Math.max(8,px)+'px'; pop.style.top=Math.max(8,py)+'px';
    var ta=pop.querySelector('textarea'); ta.focus();
    pop.querySelector('.gl-cancel').onclick=closePop;
    function doAttach(){ var t=ta.value.trim(); if(!t) return false; attach(el,outer,sel,t,tag); closePop(); return true; }
    function doPrimary(){ if(doAttach() && single) send(); } // single: attach + send in one motion
    pop.querySelector('.gl-go').onclick=doPrimary;
    var stackBtn=pop.querySelector('.gl-stack'); if(stackBtn) stackBtn.onclick=doAttach;
    ta.addEventListener('keydown',function(e){ if(e.key==='Enter'&&!e.shiftKey){ e.preventDefault(); doPrimary(); } });
  }

  function attach(el,outer,sel,text,tag){
    var c={id:nextId++, el:el, outer:outer, sel:sel, comment:text, tag:tag};
    pending.push(c); makeBadge(c); renderPending(); showPanel(); refreshSend();
    setPicking(false); // one click = one attach; drop back out of pick mode so the page works again
    input.focus();
  }
  function renderPending(){
    if(!pending.length){ pendEl.innerHTML=''; return; }
    pendEl.innerHTML='<span class="gl-pendlbl">sends with your next message →</span>'+pending.map(function(c){ return '<span class="gl-chip"><span class="gl-chip-n">'+c.id+'</span><span class="gl-chip-t">'+esc(c.comment)+'</span><button data-id="'+c.id+'">×</button></span>'; }).join('');
  }
  pendEl.addEventListener('click',function(e){ var id=e.target.getAttribute&&e.target.getAttribute('data-id'); if(id) removePending(+id); });
  function removePending(id){ var c=pending.filter(function(x){return x.id===id;})[0]; if(c&&c.badge) c.badge.remove(); pending=pending.filter(function(x){return x.id!==id;}); renderPending(); refreshSend(); }

  function renderQueue(items){ if(!items||!items.length){queueEl.innerHTML='';return;} var h='<div class="gl-qi-lbl">next up →</div>'; h+=items.map(function(q,i){ return '<div class="gl-qi" data-id="'+esc(q.id)+'"><span class="gl-qi-n">'+(i+1)+'</span><span class="gl-qi-t">'+esc(q.text)+'</span>'+(i>0?'<button data-mv="-1" title="move earlier">↑</button>':'')+(i<items.length-1?'<button data-mv="1" title="move later">↓</button>':'')+'<button data-cancel="1" title="cancel">×</button></div>'; }).join(''); queueEl.innerHTML=h; }
  queueEl.addEventListener('click',function(e){ var qi=e.target.closest&&e.target.closest('.gl-qi'); if(!qi) return; var id=qi.getAttribute('data-id'); if(e.target.getAttribute('data-cancel')){ fetch('/__galley/queue/cancel',{method:'POST',headers:authHeaders({'content-type':'application/json'}),body:JSON.stringify({id:id})}).catch(function(){}); } else if(e.target.getAttribute('data-mv')){ var mv=+e.target.getAttribute('data-mv'); var all=Array.from(queueEl.querySelectorAll('.gl-qi')); var ids=all.map(function(el){return el.getAttribute('data-id');}); var idx=ids.indexOf(id); var ni=idx+mv; if(ni>=0&&ni<ids.length){ var tmp=ids[idx]; ids[idx]=ids[ni]; ids[ni]=tmp; fetch('/__galley/queue/reorder',{method:'POST',headers:authHeaders({'content-type':'application/json'}),body:JSON.stringify({ids:ids})}).catch(function(){}); } } });

  function makeBadge(c){ var b=document.createElement('div'); b.className='gl-badge'; b.textContent=c.id; document.body.appendChild(b); c.badge=b; positionBadges(); }
  function clearBadges(){ pending.forEach(function(c){ if(c.badge) c.badge.remove(); }); }
  function positionBadges(){ pending.forEach(function(c){ if(!c.badge||!c.el) return; var r=c.el.getBoundingClientRect();
    if(r.width===0&&r.height===0){ c.badge.style.display='none'; return; } c.badge.style.display='block';
    c.badge.style.left=Math.max(2,r.left+window.scrollX-6)+'px'; c.badge.style.top=Math.max(2,r.top+window.scrollY-6)+'px'; }); }
  window.addEventListener('resize',positionBadges);

  // tiny, safe markdown → HTML (escape first, then a handful of inline + block rules)
  function md(src){
    var s=esc(src);
    var blocks=s.split(/\\n{2,}/), out=[];
    for(var i=0;i<blocks.length;i++){
      var b=blocks[i];
      var fence=b.match(/^\`\`\`[^\\n]*\\n([\\s\\S]*?)\`\`\`$/);
      if(fence){ out.push('<pre><code>'+fence[1].replace(/\\n$/,'')+'</code></pre>'); continue; }
      var lines=b.split(/\\n/);
      if(lines.every(function(l){return /^\\s*([-*])\\s+/.test(l);})){
        out.push('<ul>'+lines.map(function(l){return '<li>'+inline(l.replace(/^\\s*[-*]\\s+/,''))+'</li>';}).join('')+'</ul>'); continue;
      }
      if(lines.every(function(l){return /^\\s*\\d+[.)]\\s+/.test(l);})){
        out.push('<ol>'+lines.map(function(l){return '<li>'+inline(l.replace(/^\\s*\\d+[.)]\\s+/,''))+'</li>';}).join('')+'</ol>'); continue;
      }
      var h=b.match(/^(#{1,3})\\s+(.*)$/);
      if(h){ out.push('<h3>'+inline(h[2])+'</h3>'); continue; }
      out.push('<p>'+inline(b).replace(/\\n/g,'<br>')+'</p>');
    }
    return out.join('');
  }
  function inline(t){
    return t.replace(/\`([^\`]+)\`/g,'<code>$1</code>')
            .replace(/\\*\\*([^*]+)\\*\\*/g,'<strong>$1</strong>')
            .replace(/(^|[^*])\\*([^*]+)\\*/g,'$1<em>$2</em>')
            .replace(/\\[([^\\]]+)\\]\\((https?:\\/\\/[^)\\s]+)\\)/g,'<a href="$2" target="_blank" rel="noopener">$1</a>');
  }

  function clearEmpty(){ if(emptyShown){ thread.innerHTML=''; emptyShown=false; } }
  function bubble(role,text){ clearEmpty(); var b=atBottom(); var d=document.createElement('div'); d.className='gl-bubble '+(role==='user'?'gl-user':'gl-asst');
    if(role==='user') d.textContent=text; else d.innerHTML=md(text); thread.appendChild(d); if(b) scroll(); return d; }
  function activity(kind,text){ clearEmpty(); var b=atBottom(); var icon=kind==='tool'?'⚙️':kind==='error'?'✕':'·';
    var d=document.createElement('div'); d.className='gl-act gl-act-'+kind; d.innerHTML='<span>'+icon+'</span><span>'+esc(text)+'</span>'; thread.appendChild(d); if(b) scroll(); }
  function clearActivity(){ Array.prototype.slice.call(thread.querySelectorAll('.gl-act')).forEach(function(n){n.remove();}); }

  // ---- live turn lifecycle (driven by SSE so every tab stays in sync) ----
  var live=null, liveText='', warmEl=null, warmTimer=null, warmStart=0, renderQueued=false;
  function setBusyUI(on){ turnActive=on; sendBtn.classList.toggle('gl-on',false); byId('gl-stop').classList.toggle('gl-on',on);
    bar.classList.toggle('gl-working',on); if(on){bar.classList.remove('gl-error'); setStatus('Claude is working…');} refreshSend(); }
  function showWarm(){ if(warmEl) return; clearEmpty(); warmEl=document.createElement('div'); warmEl.className='gl-warm';
    warmEl.innerHTML='<span class="gl-spin"></span><span>thinking…</span>'; thread.appendChild(warmEl); warmStart=Date.now(); scroll();
    warmTimer=setInterval(function(){ if(!warmEl) return; var s=(Date.now()-warmStart)/1000; var t=s<6?'thinking…':s<14?'working…':'warming up the session that built this — one moment…';
      warmEl.querySelector('span:last-child').textContent=t; },1000); }
  function killWarm(){ if(warmTimer){clearInterval(warmTimer); warmTimer=null;} if(warmEl){warmEl.remove(); warmEl=null;} }
  function renderLive(){ if(!live) return; live.innerHTML=md(liveText); live.classList.add('gl-caret'); }
  function onToken(t){ killWarm(); if(!live){ var b=atBottom(); live=document.createElement('div'); live.className='gl-bubble gl-asst gl-caret'; thread.appendChild(live); if(b) scroll(); }
    liveText+=t; if(!renderQueued){ renderQueued=true; requestAnimationFrame(function(){ renderQueued=false; var b=atBottom(); renderLive(); if(b) scroll(); }); } }
  function endTurn(reply){ killWarm(); clearActivity();
    var hasReply=reply&&String(reply).trim();
    if(live){ live.classList.remove('gl-caret'); if(hasReply) live.innerHTML=md(reply); else live.remove(); live=null; }
    else if(hasReply){ bubble('assistant', reply); }
    liveText=''; setBusyUI(false); setStatus('✓'); }

  function refreshSend(){ sendBtn.disabled = !pending.length && !input.value.trim(); }
  input.addEventListener('input',function(){ input.style.height='auto'; input.style.height=Math.min(130,input.scrollHeight)+'px'; refreshSend(); });
  input.addEventListener('keydown',function(e){ if(e.key==='Enter'&&!e.shiftKey){ e.preventDefault(); send(); } });
  sendBtn.onclick=send;
  byId('gl-stop').onclick=function(){ fetch('/__galley/stop',{method:'POST',headers:authHeaders()}).catch(function(){}); };

  function locator(el){ if(!el) return null; if(el.id) return '#'+(window.CSS&&CSS.escape?CSS.escape(el.id):el.id);
    var p=[], n=el; while(n&&n.nodeType===1&&n!==document.body){ var t=n.tagName.toLowerCase(); var sib=n.parentNode?Array.prototype.filter.call(n.parentNode.children,function(c){return c.tagName===n.tagName;}):[n];
      p.unshift(sib.length>1?t+':nth-of-type('+(sib.indexOf(n)+1)+')':t); n=n.parentNode; } return p.length?p.join('>'):null; }

  function send(){
    var msg=input.value.trim();
    if(!pending.length && !msg) return;
    var batch=pending.slice();
    // The "what changed" readout no longer flashes what you POINTED AT — it flashes
    // what the agent actually CHANGED, fetched by changeId after the reload (below).
    pending=[]; clearBadges(); renderPending(); input.value=''; input.style.height='auto'; showPanel(); refreshSend();
    fetch('/__galley/send',{method:'POST',headers:authHeaders({'content-type':'application/json'}),
      body:JSON.stringify({message:msg, comments:batch.map(function(c){return {comment:c.comment,outerHTML:c.outer,sel:c.sel,tag:c.tag};})})})
      .then(function(r){return r.json();})
      .then(function(d){ if(d&&d.pending){ toast('⏳ '+(d.reply||'waiting for host to approve')); }
        else if(d&&!d.ok){ killWarm(); setBusyUI(false); bar.classList.add('gl-error'); bubble('assistant','⚠ '+(d.reply||'failed')); } })
      .catch(function(e){ killWarm(); setBusyUI(false); bar.classList.add('gl-error'); bubble('assistant','⚠ '+String(e)); });
  }
  var KQ = (GL_ROLE==='guest'&&GL_SHARE)?('?k='+encodeURIComponent(GL_SHARE)):'';
  // Drop the share key from the visible URL (history/bookmarks/Referer) — the
  // overlay already holds it via the server-injected GL_SHARE.
  try{ if(/[?&]k=/.test(location.search)) history.replaceState(null,'',location.pathname+location.hash); }catch(e){}

  undo.onclick=function(){ setStatus('Undoing…'); bar.classList.add('gl-working');
    fetch('/__galley/undo',{method:'POST',headers:authHeaders()}).then(function(r){return r.json();})
      .then(function(d){ bar.classList.remove('gl-working'); setStatus(d.ok?'↩ reverted':'nothing to undo'); })
      .catch(function(){ bar.classList.remove('gl-working'); }); };

  function loadThread(){
    fetch('/__galley/thread'+KQ).then(function(r){return r.json();}).then(function(d){
      thread.innerHTML=''; emptyShown=false; live=null; liveText='';
      if(!d.thread||!d.thread.length){ thread.innerHTML='<div class="gl-empty">Ask Claude about this document, or turn on 💬 Comment to point at something.</div>'; emptyShown=true; }
      else d.thread.forEach(function(t){ if(t.text&&String(t.text).trim()) bubble(t.role, t.text); });
      scroll();
    }).catch(function(){});
  }

  function toast(msg){ var t=byId('gl-toast'); t.textContent=msg; t.classList.add('gl-show'); setTimeout(function(){t.classList.remove('gl-show');},1800); }

  // ---- "what changed" visual locator -------------------------------------------
  // After an edit-driven reload, fetch the faithful change (the agent's own edits),
  // flash the elements that ACTUALLY changed, and show a count chip with a stepper.
  function flashEl(el){ if(!el) return; el.classList.remove('gl-changed'); void el.offsetWidth; el.classList.add('gl-changed'); setTimeout(function(){el.classList.remove('gl-changed');},1700); }
  function flashFrame(){ var d=document.createElement('div'); d.id='gl-frameflash'; document.body.appendChild(d); setTimeout(function(){ if(d.parentNode) d.remove(); },1400); }
  function stripTags(s){ return String(s).replace(/<[^>]*>/g,' ').replace(/\\s+/g,' ').trim(); }
  // Smallest (deepest) on-page element whose text contains the changed fragment.
  function findAnchor(fragText){
    var needle=stripTags(fragText).slice(0,60); if(needle.length<3) return null;
    var all=document.body?document.body.getElementsByTagName('*'):[]; var best=null;
    for(var i=0;i<all.length;i++){ var el=all[i]; if(inUI(el)) continue;
      if((el.textContent||'').indexOf(needle)>=0){ if(!best||best.contains(el)) best=el; } }
    return best;
  }
  var chipEl=null, chipAnchors=[], chipIdx=0, chipTimer=null;
  function dismissChip(){ if(chipTimer){clearTimeout(chipTimer);chipTimer=null;} if(chipEl){chipEl.remove(); chipEl=null;} }
  function stepTo(i){ if(!chipAnchors.length) return; chipIdx=((i%chipAnchors.length)+chipAnchors.length)%chipAnchors.length;
    var el=chipAnchors[chipIdx]; try{ el.scrollIntoView({behavior:'smooth',block:'center'}); }catch(e){ try{el.scrollIntoView();}catch(_){} } flashEl(el);
    if(chipEl){ var ind=chipEl.querySelector('.gl-step-i'); if(ind) ind.textContent=(chipIdx+1)+'/'+chipAnchors.length; if(chipTimer){clearTimeout(chipTimer);chipTimer=null;} } }
  function showChip(label, anchors){
    dismissChip(); chipAnchors=anchors||[]; chipIdx=0;
    chipEl=document.createElement('div'); chipEl.id='gl-change-chip';
    var stepper=chipAnchors.length>1?'<button class="gl-step" data-d="-1" title="previous change">‹</button><span class="gl-step-i">1/'+chipAnchors.length+'</span><button class="gl-step" data-d="1" title="next change">›</button>':'';
    chipEl.innerHTML='<span class="gl-cc-dot"></span><span class="gl-cc-l">'+esc(label)+'</span>'+stepper+'<button class="gl-cc-x" title="dismiss">×</button>';
    document.body.appendChild(chipEl);
    chipEl.querySelector('.gl-cc-x').onclick=dismissChip;
    Array.prototype.forEach.call(chipEl.querySelectorAll('.gl-step'),function(b){ b.onclick=function(){ stepTo(chipIdx+(+b.getAttribute('data-d'))); }; });
    if(chipAnchors.length){ var l=chipEl.querySelector('.gl-cc-l'); l.style.cursor='pointer'; l.title='jump to the change'; l.onclick=function(){ stepTo(chipIdx); }; }
    chipTimer=setTimeout(function(){ if(chipEl){ chipEl.classList.add('gl-fade'); setTimeout(dismissChip,600); } },6000);
  }
  function renderChange(c){
    if(!c||c.kind==='unknown'||c.kind==='none') return;
    if(c.kind==='write'){ flashFrame(); showChip('rewrote the page',[]); return; }
    var anchors=[], styleN=0, scriptN=0, missN=0;
    (c.fragments||[]).slice(0,30).forEach(function(f){
      if(f.type==='style'){ styleN++; return; } if(f.type==='script'){ scriptN++; return; }
      var el=findAnchor(f.text); if(el){ if(anchors.indexOf(el)<0) anchors.push(el); } else { missN++; }
    });
    anchors.forEach(flashEl);
    var label;
    if(anchors.length) label=anchors.length+(anchors.length===1?' change':' changes');
    else if(styleN) label='styles changed';
    else if(scriptN) label='script changed';
    else if(missN) label='changed (no visible element)';
    else label='updated';
    if(!anchors.length&&(styleN||scriptN||missN)) flashFrame(); // never a silent miss: if no element anchored, flash the frame so the change is still surfaced
    showChip(label, anchors);
    if(anchors.length){ var r=anchors[0].getBoundingClientRect(); if(r.bottom<0||r.top>window.innerHeight) stepTo(0); }
  }
  (function(){ var cid; try{ cid=sessionStorage.getItem('gl-change-id'); sessionStorage.removeItem('gl-change-id'); }catch(e){}
    if(!cid) return;
    fetch('/__galley/change?id='+encodeURIComponent(cid)+(GL_ROLE==='guest'&&GL_SHARE?('&k='+encodeURIComponent(GL_SHARE)):''),{headers:authHeaders()})
      .then(function(r){return r.json();}).then(renderChange).catch(function(){}); }());

  // ---- share: role-based UI (guest vs host) ----
  var approvalsBox=null;
  function ensureApprovals(){ if(approvalsBox) return approvalsBox; approvalsBox=document.createElement('div'); approvalsBox.id='gl-approvals'; panel.insertBefore(approvalsBox, byId('gl-thread')); return approvalsBox; }
  function addApproval(id,text){ if(GL_ROLE!=='host') return; var box=ensureApprovals(); showPanel();
    var card=document.createElement('div'); card.className='gl-appr'; card.setAttribute('data-id',id);
    card.innerHTML='<div class="gl-appr-h">👤 guest wants to:</div><div class="gl-appr-t"></div><div class="gl-appr-r"><button class="gl-rej">Reject</button><button class="gl-app">Approve</button></div>';
    card.querySelector('.gl-appr-t').textContent=text; box.appendChild(card);
    card.querySelector('.gl-app').onclick=function(){ fetch('/__galley/approve',{method:'POST',headers:authHeaders({'content-type':'application/json'}),body:JSON.stringify({id:id})}).catch(function(){}); card.remove(); };
    card.querySelector('.gl-rej').onclick=function(){ fetch('/__galley/reject',{method:'POST',headers:authHeaders({'content-type':'application/json'}),body:JSON.stringify({id:id})}).catch(function(){}); card.remove(); }; }
  function clearApproval(id){ if(!approvalsBox) return; var c=approvalsBox.querySelector('[data-id="'+id+'"]'); if(c) c.remove(); }
  function setPresence(h,g){ if(GL_ROLE==='guest'){ setStatus('guest · '+(h?'host online':'host away')); }
    else if(g>0){ setStatus(g+' guest'+(g>1?'s':'')+' connected'); } }

  if(GL_ROLE==='guest'){ undo.style.display='none'; byId('gl-stop').style.display='none'; toggle.textContent='💬 Suggest';
    setStatus('guest'); var gp=document.createElement('div'); gp.className='gl-guestbar'; gp.textContent='You are a guest — your messages are sent to the host to approve.'; panel.insertBefore(gp, byId('gl-thread')); showPanel(); }

  var es=new EventSource('/__galley/events'+KQ);
  es.onmessage=function(ev){ try{ var d=JSON.parse(ev.data);
    if(d.type==='reload'){ try{ if(d.changeId) sessionStorage.setItem('gl-change-id', String(d.changeId)); }catch(e){} location.reload(); }
    else if(d.type==='turn' && d.role==='user'){ bubble('user', d.text); setBusyUI(true); showWarm(); }
    else if(d.type==='token'){ onToken(d.text); }
    else if(d.type==='turn-end'){ endTurn(d.reply); }
    else if(d.type==='activity'){ killWarm(); activity(d.kind, d.text); }
    else if(d.type==='approval'){ addApproval(d.id, d.text); }
    else if(d.type==='approval-clear'){ clearApproval(d.id); }
    else if(d.type==='presence'){ setPresence(d.hosts, d.guests); }
    else if(d.type==='queue'){ renderQueue(d.items); }
  }catch(e){} };

  loadThread();
  fetch('/__galley/queue').then(function(r){return r.json();}).then(function(d){renderQueue(d.items||[]);}).catch(function(){});
  try{ if(sessionStorage.getItem('gl-panel')) showPanel(); }catch(e){} // keep the panel open across edit-reloads
})();
</script>
`;

// ---- server --------------------------------------------------------------------
const MIME = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".svg": "image/svg+xml", ".webp": "image/webp", ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf" };

function serveMainHtml(res, req, key) {
  // The host page (with the CSRF token) is served ONLY to a genuinely local request
  // (loopback socket, no forwarding header). Anything else is a guest and must
  // present a valid share key; it gets a page with only the share token.
  const host = isHostReq(req);
  if (!host && !shareKeyValid(key)) {
    res.writeHead(SHARE ? 403 : 404, { "content-type": "text/plain" });
    res.end(SHARE ? "This galley-lite share link is invalid or expired." : "not found");
    return;
  }
  const auth = host
    ? `var GL_TOKEN=${JSON.stringify(TOKEN)}; var GL_SHARE=""; var GL_ROLE="host";`
    : `var GL_TOKEN=""; var GL_SHARE=${JSON.stringify(SHARE_TOKEN)}; var GL_ROLE="guest";`;
  let html = readFileSync(FILE, "utf8");
  const inject = OVERLAY.replace("__GL_AUTH__", auth);
  const idx = html.toLowerCase().lastIndexOf("</body>");
  html = idx >= 0 ? html.slice(0, idx) + inject + html.slice(idx) : html + inject;
  // no-referrer so the ?k=<share token> in the URL never leaks to third-party
  // subresources (fonts/images/scripts the doc references) via the Referer header.
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" });
  res.end(html);
}

const MAX_BODY = 8 * 1024 * 1024; // cap request bodies (a batch of comments is small)
function readBody(req) {
  return new Promise((res) => {
    let b = "";
    let over = false;
    req.on("data", (d) => {
      if (over) return;
      b += d;
      if (b.length > MAX_BODY) {
        over = true;
        b = "";
        try {
          req.destroy();
        } catch {
          /* ignore */
        }
      }
    });
    req.on("end", () => res(b));
    req.on("error", () => res(""));
  });
}

const server = createServer(async (req, res) => {
  // Reject unexpected Host headers up front → defeats DNS-rebinding (a malicious
  // site resolving to 127.0.0.1 still can't satisfy this).
  if (!validHost(req)) {
    res.writeHead(403, { "content-type": "text/plain" });
    res.end("bad host");
    return;
  }
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = decodeURIComponent(url.pathname);

  // Reads: a genuinely-local host request always; a guest only with a valid share
  // key (header or ?k). isHostReq requires a loopback socket AND no forwarding header.
  const canRead = isHostReq(req) || shareKeyValid(req.headers["x-galley-share"] || url.searchParams.get("k"));

  if (path === "/__galley/events") {
    if (!canRead) { res.writeHead(403); res.end(); return; }
    if (clients.size >= 64) { res.writeHead(503); res.end(); return; } // cap SSE fan-out
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.write(": connected\n\n");
    res._glGuest = isTunnelReq(req);
    clients.add(res);
    sendPresence();
    logEvent("sse_connected", { clients: clients.size, guest: !!res._glGuest });
    req.on("close", () => { clients.delete(res); sendPresence(); logEvent("sse_closed", { clients: clients.size }); });
    return;
  }

  // Read-only: the conversation so far (lets the overlay restore after a reload).
  if (path === "/__galley/thread") {
    if (!canRead) { res.writeHead(403); res.end(JSON.stringify({ thread: [] })); return; }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ thread, share: SHARE ? { expires: SHARE_EXPIRES } : null }));
    return;
  }

  // Read-only: the faithful change payload for one turn (fetched after the reload
  // to drive the "what changed" visual locator).
  if (path === "/__galley/change") {
    if (!canRead) { res.writeHead(403); res.end(JSON.stringify({ kind: "unknown" })); return; }
    const c = changes.get(+(url.searchParams.get("id") || 0));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(c || { kind: "unknown" }));
    return;
  }

  // Role for writes: host = a genuinely-local request carrying the CSRF token;
  // guest = a tunnel request with a valid share token. Anything else is rejected.
  const role = isHostReq(req)
    ? (typeof req.headers["x-galley-token"] === "string" && eq(req.headers["x-galley-token"], TOKEN) ? "host" : "none")
    : (shareValid(req) ? "guest" : "none");

  // Host-only endpoints — guests can never stop, undo, approve, or reject.
  if (["/__galley/stop", "/__galley/undo", "/__galley/approve", "/__galley/reject"].includes(path) && req.method === "POST") {
    if (role !== "host") {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, reply: "host only" }));
      return;
    }
  }

  if (path === "/__galley/stop" && req.method === "POST") {
    agent.close();
    logEvent("turn_stopped", { turnId: currentTurnId });
    broadcast({ type: "activity", kind: "error", text: "stopped by host" });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // A turn: host dispatches directly; a guest's request is QUEUED FOR HOST APPROVAL
  // and never runs until the host reads it and clicks approve.
  if (path === "/__galley/send" && req.method === "POST") {
    if (role === "none") {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, reply: "forbidden" }));
      return;
    }
    const body = safeJson(await readBody(req));
    const comments = Array.isArray(body.comments) ? body.comments : [];
    const message = typeof body.message === "string" ? body.message : "";
    if (!comments.length && !message.trim()) {
      logEvent("send_rejected", { reason: "empty" });
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, reply: "say something" }));
      return;
    }
    const userText = [...comments.map((c, i) => `#${i + 1} <${c.tag || "el"}>: ${c.comment}`), message.trim()].filter(Boolean).join("\n");

    if (role === "guest") {
      if (guestTurns >= SHARE_CAP) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, reply: `guest turn limit reached (${SHARE_CAP})` }));
        return;
      }
      // Store ONLY the text the host will see and approve. Guest-supplied element
      // outerHTML/sel are NOT forwarded to the agent — otherwise a guest could hide
      // an instruction in a field the host never reads (approval bypass).
      const id = randomUUID();
      approvals.set(id, { text: userText });
      audit({ event: "guest_request", id, text: userText });
      process.stdout.write(`\n\x1b[1m\x1b[38;5;179m⏳ guest wants to:\x1b[0m ${userText}\n  approve in the panel, or it won't run.\n`);
      broadcast({ type: "approval", id, text: userText });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, pending: true, reply: "waiting for the host to approve…" }));
      return;
    }
    // host — enqueue and respond immediately; turn result arrives via SSE
    logEvent("turn_sent", { source: comments.length ? "comment" : "chat", comments_n: comments.length, text_len: userText.length, queue_depth: pendingQueue.length });
    const qid = addToQueue(comments, message, userText);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, queued: true, id: qid }));
    return;
  }

  // Host approves a pending guest request → it finally runs (attributed to guest).
  if (path === "/__galley/approve" && req.method === "POST") {
    const { id } = safeJson(await readBody(req));
    const a = approvals.get(id);
    if (!a) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: false })); return; }
    approvals.delete(id);
    guestTurns++;
    audit({ event: "host_approve", id, text: a.text });
    broadcast({ type: "approval-clear", id });
    // Dispatch EXACTLY the approved text — no guest-controlled comment fields reach
    // the agent, so what the host read is what runs.
    enqueueTurn(() => runTurn([], a.text, "👤 guest: " + a.text));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (path === "/__galley/reject" && req.method === "POST") {
    const { id } = safeJson(await readBody(req));
    approvals.delete(id);
    audit({ event: "host_reject", id });
    broadcast({ type: "approval-clear", id, rejected: true });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (path === "/__galley/undo" && req.method === "POST") {
    let ok = false;
    if (undoStack.length) {
      writeFileSync(FILE, undoStack.pop());
      ok = true;
    }
    logEvent("undo", { ok });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok }));
    return;
  }

  // Queue endpoints — inspect (canRead), reorder/cancel (host only).
  if (path === "/__galley/queue" && req.method === "GET") {
    if (!canRead) { res.writeHead(403); res.end(); return; }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ items: pendingQueue.map((q, i) => ({ id: q.id, text: q.userText, position: i })), running: queueRunning }));
    return;
  }

  if (path === "/__galley/queue/reorder" && req.method === "POST") {
    if (role !== "host") { res.writeHead(403); res.end(JSON.stringify({ ok: false, reply: "host only" })); return; }
    const { ids } = safeJson(await readBody(req));
    if (!Array.isArray(ids)) { res.writeHead(400); res.end(JSON.stringify({ ok: false })); return; }
    const qmap = new Map(pendingQueue.map((q) => [q.id, q]));
    const reordered = ids.map((id) => qmap.get(id)).filter(Boolean);
    const rest = pendingQueue.filter((q) => !ids.includes(q.id));
    pendingQueue.length = 0;
    pendingQueue.push(...reordered, ...rest);
    broadcastQueue();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (path === "/__galley/queue/cancel" && req.method === "POST") {
    if (role !== "host") { res.writeHead(403); res.end(JSON.stringify({ ok: false, reply: "host only" })); return; }
    const { id } = safeJson(await readBody(req));
    const idx = pendingQueue.findIndex((q) => q.id === id);
    if (idx >= 0) pendingQueue.splice(idx, 1);
    broadcastQueue();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: idx >= 0 }));
    return;
  }

  // Main document (root or its own name).
  if (path === "/" || path === "/" + NAME) return serveMainHtml(res, req, url.searchParams.get("k"));

  // Static sibling files (assets the HTML references). Confined to DIR (separator
  // boundary), AND gated by canRead so a tunnel guest can't read arbitrary files
  // with no key. Over a share, dotfiles / obvious secrets are blocked outright —
  // a guest never needs them and the host is exposing a whole directory.
  if (!canRead) { res.writeHead(403); res.end("forbidden"); return; }
  const rel = path.replace(/^\/+/, "");
  const target = resolve(DIR, rel);
  const base = basename(target).toLowerCase();
  const sensitive = base.startsWith(".") || /(^|\.)(env|pem|key|secret|credentials)(\.|$)/.test(base) || rel.split("/").some((s) => s === ".git" || s === ".ssh" || s === "node_modules");
  if (SHARE && !isHostReq(req) && sensitive) { res.writeHead(403); res.end("forbidden"); return; }
  if (target.startsWith(DIR + sep) && existsSync(target) && statSync(target).isFile()) {
    res.writeHead(200, { "content-type": MIME[extname(target).toLowerCase()] || "application/octet-stream", "referrer-policy": "no-referrer" });
    createReadStream(target).pipe(res);
    return;
  }

  res.writeHead(404);
  res.end("not found");
});

// Preflight: fail fast and clearly if Claude Code isn't available, rather than
// erroring cryptically inside the first chat turn.
function preflightClaude() {
  let r;
  try {
    r = spawnSync("claude", ["--version"], { encoding: "utf8", timeout: 10_000 });
  } catch {
    r = { error: new Error("spawn failed") };
  }
  if (r.error || (r.status !== 0 && !r.stdout)) {
    console.error("\n  galley-lite needs Claude Code, and it isn't runnable.\n");
    console.error("  Install it:   npm install -g @anthropic-ai/claude-code");
    console.error("  Auth:         export ANTHROPIC_API_KEY=...   (or: run `claude` once to log in)");
    console.error("  Docs:         https://docs.anthropic.com/en/docs/claude-code\n");
    process.exit(1);
  }
}
preflightClaude();

// Loopback only — never expose the agent endpoints on the LAN. If the port is
// taken, try the next few rather than crashing with a raw EADDRINUSE stack trace.
let boundPort = PORT;
server.on("error", (e) => {
  if (e && e.code === "EADDRINUSE" && boundPort < PORT + 20) {
    boundPort++;
    setTimeout(() => server.listen(boundPort, "127.0.0.1"), 40);
  } else {
    console.error(`galley-lite: could not bind a port near ${PORT} — ${e && e.message ? e.message : e}`);
    process.exit(1);
  }
});
server.on("listening", () => {
  const url = `http://localhost:${boundPort}`;
  logEvent("server_start", { port: boundPort, requestedPort: PORT, model: MODEL, linkMode, sessionId, apiKey: !!process.env.ANTHROPIC_API_KEY });
  console.log(`\n  galley-lite → ${url}`);
  console.log(`  editing:   ${FILE}`);
  console.log(`  model:     ${MODEL}`);
  if (process.env.ANTHROPIC_API_KEY) console.log(`  auth:      ANTHROPIC_API_KEY — edits bill the Anthropic API (metered).`);
  else console.log(`  auth:      your local Claude Code login (set ANTHROPIC_API_KEY to bill the API instead).`);
  console.log(`  agent cwd: ${AGENT_CWD}`);
  const linkLabel = { auto: "auto-linked to its build session", marker: "linked via marker", resume: "linked (--resume)", fresh: "" }[linkMode];
  console.log(`  session:   ${sessionId ? sessionId + (linkLabel ? " — " + linkLabel : "") : "fresh per doc (chains forward)"}`);
  console.log(`\n  Click “💬 Comment”, pick an element, describe the change. Undo is in the bar.\n`);
  // Pre-warm the agent so its boot (and, when linked, the build-session load)
  // happens while you read the page — not on your first message.
  agent.start();
  // Open the browser by default; --no-open suppresses it.
  if (!flags["no-open"]) {
    const opener = platform() === "darwin" ? "open" : platform() === "win32" ? "start" : "xdg-open";
    spawn(opener, [url], { stdio: "ignore", detached: true, shell: platform() === "win32" }).on("error", () => {});
  }
  if (SHARE) startShare(boundPort);
});
server.listen(boundPort, "127.0.0.1");

// --share: open a public tunnel and print a guest link. The guest reaches an
// approval-gated, read-mostly page; every guest turn needs the host's OK.
function startShare(port) {
  console.log("\n  ┌─ SHARING ─────────────────────────────────────────────────────────");
  console.log("  │ A guest with the link can ASK Claude to edit files in:");
  console.log(`  │   ${AGENT_CWD}`);
  console.log("  │ Nothing a guest sends runs until YOU approve it in the panel.");
  console.log("  │ Only share with people you'd trust to edit that directory.");
  console.log(`  │ Link expires in ${SHARE_TTL_MIN} min · guest turn cap ${SHARE_CAP} · audit: ${AUDIT}`);
  console.log("  └───────────────────────────────────────────────────────────────────");
  console.log("  establishing a public tunnel via cloudflared…");
  const printLink = (host) => {
    tunnelHost = host; // allow this Host header (validHost) — only after the tunnel is up
    console.log(`\n  ✦ share this link:  https://${host}/?k=${SHARE_TOKEN}\n`);
  };
  // cloudflared is REQUIRED. It stamps cf-connecting-ip on every forwarded request
  // (which a guest can't strip), so host-vs-guest is decided by a header the guest
  // can't forge — not by a self-rolled tunnel that might omit it and leak the host
  // token. If cloudflared is missing, refuse to share rather than hand out a token.
  let cf;
  try {
    cf = spawn("cloudflared", ["tunnel", "--url", `http://localhost:${port}`], { stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    cf = null;
  }
  const refuse = () => {
    console.log("\n  ✕ sharing needs cloudflared, which isn't installed.");
    console.log("    install it:  brew install cloudflared   (or https://github.com/cloudflare/cloudflared)");
    console.log("    then re-run with --share. (Don't tunnel it yourself — that can leak host access.)\n");
  };
  if (!cf) return refuse();
  let found = false;
  const scan = (d) => {
    const m = String(d).match(/https:\/\/([a-z0-9-]+\.trycloudflare\.com)/);
    if (m && !found) { found = true; printLink(m[1]); }
  };
  cf.stdout.on("data", scan);
  cf.stderr.on("data", scan);
  cf.on("error", refuse);
  cf.on("close", () => { if (!found) refuse(); });
  process.on("exit", () => { try { cf.kill(); } catch { /* ignore */ } });
}

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { agent.killSync(); process.exit(0); });
