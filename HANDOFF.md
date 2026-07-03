# galley-lite — Cursor handoff

Single-file Node HTTP server (`galley-lite.mjs`) that injects an overlay into any local HTML file, lets you click elements and leave comments, and runs a persistent `claude` CLI child process that edits the file in place with live-reload.

## How to run

```bash
node galley-lite.mjs <file.html> [--port 4321] [--model sonnet] [--fresh]
```

Opens the file in your browser. `--fresh` skips session auto-linking. The `ANTHROPIC_API_KEY` env var routes to the metered API; without it, falls back to your local `claude` login.

```bash
# Tests (no real claude needed — uses GALLEY_MOCK_AGENT)
node --test galley-lite.test.mjs
```

## Known bugs — fixed in 0.2.3

1. **Badge scroll drift** — badges are now `position:absolute` with document-relative coords; scroll listener removed.
2. **Panel width / content shift** — `showPanel()` reads `--gl-panel-width` from CSS instead of `offsetWidth` before paint.
3. **Empty assistant bubbles** — edit-only queued turns no longer leave blank bubbles in the conversation thread.

## Architecture

Everything lives in `galley-lite.mjs` (~1500 lines). Sections in order:

| Lines | Purpose |
|-------|---------|
| 1–55 | CLI arg parsing |
| 57–130 | Session auto-link (scan `~/.claude/projects/*.jsonl` for the file's build session) |
| 131–260 | `--share` tunnel mode (cloudflared, per-turn host approval) |
| 263–310 | `buildTurnPrompt()` — assembles the prompt from element comments + free-text |
| 328–500 | `ClaudeAgent` — persistent `claude -p --stream-json` child, warm between turns |
| 495–515 | Undo stack (bounded by count + bytes) |
| 517–565 | SSE broadcast + live-reload file watcher |
| 580–670 | `computeChange()` — pure function, derives the "what changed" readout from before/after HTML |
| 671–700 | **Turn queue** — `pendingQueue`, `drainQueue()`, `addToQueue()` (recently added) |
| 702–720 | `runTurn()` — one serialized agent turn (snapshot → send → diff → reload → broadcast) |
| 723–1110 | `OVERLAY` — the injected CSS + HTML + JS (embedded template literal) |
| 1110–1440 | HTTP server: SSE, `/send`, `/queue/*`, `/undo`, `/stop`, `/approve`, `/reject`, static files |

### Key data flows

```
User clicks element → overlay captures click → openPop() shows popover
User types → clicks Send → fetch POST /__galley/send
  → addToQueue(comments, message, userText)         // returns id immediately
  → drainQueue() → runTurn() → agent.send(prompt)  // serialized, one at a time
  → claude edits FILE in place
  → SSE broadcast: token* → turn-end + (reload if changed)
  → browser reloads; overlay re-fetches thread + queue
```

### Queue (new, just added)

```
pendingQueue = [{ id, comments, message, userText }, ...]
queueRunning = bool

addToQueue(comments, message, userText) → id   // sync, triggers drainQueue
drainQueue()                                    // pops head, runs runTurn, recurses on finish
```

**Endpoints:**
- `GET  /__galley/queue` — returns `{ items: [{id, text, position}], running: bool }`
- `POST /__galley/queue/reorder` — body `{ ids: [...] }`, reorders pending items
- `POST /__galley/queue/cancel`  — body `{ id }`, removes item (no-op if already running)

All three broadcast `{ type: "queue", items }` via SSE; the overlay renders a "next up →" list with ↑/↓/× controls.

### Mock agent (for tests / dev)

Set `GALLEY_MOCK_AGENT=<ms>` to skip spawning `claude` — turns resolve after `<ms>` milliseconds with a `[mock] ...` reply. Used by `galley-lite.test.mjs`.

### SSE event types

| type | payload | meaning |
|------|---------|---------|
| `turn` | `{role,text}` | user turn started |
| `token` | `{text}` | streaming reply fragment |
| `turn-end` | `{reply}` | turn complete |
| `activity` | `{kind,text}` | tool call / queued notice |
| `reload` | `{changed,changeId}` | file changed, browser should reload |
| `queue` | `{items}` | pending queue changed |
| `approval` | `{id,text}` | guest request waiting for host (share mode) |
| `presence` | `{hosts,guests}` | share mode connection counts |

### Auth model

- **Host**: loopback socket (`127.0.0.1`) + no forwarding headers + `x-galley-token: <TOKEN>` header (per-run UUID embedded in the served HTML)
- **Guest** (share mode): arrives through cloudflared tunnel + `x-galley-share: <SHARE_TOKEN>` header
- CSRF: the token is in a custom header (not a cookie), which forces a CORS preflight that galley never approves, defeating cross-site requests

### File permissions (agent sandbox)

The agent is allowed to `Read` anywhere (minus secret paths) but can only `Edit`/`Write` inside `DIR` (the directory containing the HTML file). Set via `--settings <json>` passed to `claude -p`.

## Pending ideas / next steps

- **Streaming tokens in real time** — already implemented (`--include-partial-messages`), tokens arrive via SSE `token` events and render live in the panel
- **Tunnel collab (--share)** — already working; guests need host approval per turn
- **npm publish** as `galley-lite` for `npx galley-lite <file>` usage
- **Stop mid-turn** — Stop button exists and calls `agent.close()`; works but kills the warm child (next turn respawns cold)

## File layout

```
galley-lite/
  galley-lite.mjs         # everything (server + overlay)
  galley-lite.test.mjs    # queue integration tests (node:test)
  package.json            # bin: galley-lite
  docs/                   # README-linked assets only (see docs/README.md)
  examples/sample.html

~/Documents/personal/galley-lite/   # marketing & launch (outside code/)
  launch/                 # HN, PH, Reddit kits
  gallery/product-hunt/   # PH gallery images
  promos/                 # demo clips
  thumbnails/             # PH thumbnails
```
