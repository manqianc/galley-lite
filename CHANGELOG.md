# Changelog

## 0.2.3 — 2026-07-03

UI polish + turn queue for batch edits.

- **Turn queue.** Send multiple messages while Claude is busy; inspect, reorder (↑/↓), or
  cancel pending items in the "next up →" list. Serialized execution, SSE-synced across tabs.
- **Badge scroll fix.** Comment pins use document-relative positioning — no more lag/jump on scroll.
- **Panel layout fix.** Content shift uses the CSS panel width instead of measuring before paint.
- **Empty reply cleanup.** Edit-only turns no longer leave blank assistant bubbles in the thread.
- **Tests.** Queue integration tests (`galley-lite.test.mjs`) + fixed change-computation test.

## 0.2.2 — 2026-06-29

Docs: the README now leads with the point-to-edit demo (the actual differentiator) instead of the chat-box clip, via an absolute image URL that renders on both GitHub and npm, plus a link to the full feature tour. No code changes.

## 0.2.1 — 2026-06-29

Security: confine the agent's writes to the document's directory.

- The `claude` child now runs with `--permission-mode default` and a dir-scoped
  allow-list (`Edit(//<doc-dir>/**)` / `Write(//<doc-dir>/**)`), and `Edit`/`Write`
  are no longer in the bare `--allowedTools` (a bare grant overrode the scope). Net:
  a malicious or untrusted document can no longer drive the agent to write files
  **outside the document's own directory**. In-dir edits are unaffected.
- Caveat: if your user-level `~/.claude/settings.json` broadly allows writes (e.g.
  `Write(*)`), Claude Code unions that in and it overrides this scoping — galley
  can't un-grant your own global allow. Point galley at a working directory, not
  `~` or a secrets folder (see README → Security).
- README now embeds a live demo and documents the trust boundary.

## 0.2.0 — 2026-06-29

API-key-first + the "what changed" visual locator.

- **Bring your own key.** galley-lite no longer strips `ANTHROPIC_API_KEY` — it
  shells out to the official `claude` CLI and the key (if set) bills the metered
  Anthropic API; if unset, `claude` uses your existing local auth. This is the
  ToS-clean path (running third-party harnesses on a Pro/Max subscription token
  is what Anthropic enforced against in Jan 2026).
- **"What changed" visual locator.** After an edit, the changed element flashes
  and a count chip + prev/next stepper appears — sourced from the agent's own
  Edit fragments (content-compared, not mtime), so it shows what actually
  changed, not what you clicked. Never a silent miss: if no element anchors, the
  frame flashes so the change is always surfaced.
- **One-Enter steer.** The element popover's primary action is Send for a single
  pin (Enter sends), with "+ pin" to batch more.
- **Deterministic event log** (opt-in via `GALLEY_EVENTS` / `GALLEY_EVENTS_LOG`)
  for journey/metrics verification, plus a Playwright journey harness
  (`test/journeys.mjs`), a readout check, and a locator dogfood.

## 0.1.2 — 2026-06-25

Pre-publish DX pass (cold-install + CLI stress test):

- `galley-lite --help` now exits 0 (was exit 1 — the code tied the exit code to
  whether a file was given, so an explicit `--help` reported failure). No-file
  and bad-file still exit 1.

## 0.1.1 — 2026-06-25

Security hardening (pre-launch adversarial review):

- Reject unexpected `Host` headers → defeats DNS-rebinding (a malicious site
  resolving to 127.0.0.1 can no longer read the conversation or local files).
- Host vs guest is now decided by a verified loopback socket (+ no forwarding
  header), not spoofable proxy headers. `--share` requires cloudflared (which
  stamps an unforgeable header); the "tunnel it yourself" path is removed so the
  host token can't leak to a remote visitor.
- Static file serving is gated by the same auth as the page — a tunnel guest can
  no longer read arbitrary files in the directory, and dotfiles/secrets are blocked.
- The agent runs with a deny-list (`--settings`): it can't read `~/.ssh`, `~/.aws`,
  `.env`, keys/credentials, or write shell rc files / git hooks — limiting the
  blast radius if a malicious document or a tricked approval drives it.
- Timing-safe token comparison; SSE-client and conversation-length caps (DoS).

## 0.1.0 — 2026-06-25

First public release.

- Open any local HTML in the browser with an overlay; comment on elements or chat.
- A persistent warm Claude Code session edits the file in place and live-reloads it,
  on your own Claude subscription ($0 metered).
- **Auto-link:** resumes the Claude Code session that built the file (scans
  `~/.claude/projects` for a `Write`/`Edit` to that path) so edits inherit its context.
- Token-by-token streaming replies, markdown rendering, warming indicator, Stop, Undo,
  and a flash on the elements that changed.
- `--share`: opt-in, owner-gated trusted-pair collaboration over a cloudflared tunnel
  (every guest turn needs host approval; guest never receives the host token; expiry +
  turn cap + audit log).
- Ships as an npm CLI (`npx galley-lite <file>`) and a Claude Code plugin (`/galley`).

Security: loopback-only bind, per-run CSRF token, path-traversal-safe static serving,
the agent scoped to the file's directory.
