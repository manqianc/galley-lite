# galley-lite

Work with the agent that built your page by pointing at the result, not by typing at a terminal.

galley-lite is not an HTML editor. It's a visual way to work with the agent that built your page: open the file, point at any element or just talk, and it changes in place and live-reloads. Instead of reading a diff in a transcript, you watch the page update. Under the hood it reconnects to the Claude Code session that built the file, so edits inherit the intent, sources, and reasoning behind it, not just the rendered HTML. Local, private, and bring-your-own-key: set `ANTHROPIC_API_KEY` and edits run on the Anthropic API.

![galley-lite: point at any element and Claude edits the real file](https://raw.githubusercontent.com/manqianc/galley-lite/main/docs/promo-feature.gif)

▶ **[Watch the feature showcase (58s)](https://github.com/manqianc/galley-lite/raw/main/docs/promo-showcase.mp4)** — six clear steps: point → edit → chat → batch → what changed → queue → `npx galley-lite`

Turn on Comment, point at **any** element — the headline, a button, a paragraph — and galley-lite auto-detects it (shown as its tag, e.g. `<h1#headline>`). Say what you want, and it edits the real file in place:

![How it works: point at any element, it detects it, then edits the file](https://raw.githubusercontent.com/manqianc/galley-lite/main/docs/feature-examples.png)

▶ **[Watch the full feature tour (41s)](https://github.com/manqianc/galley-lite/raw/main/docs/promo-features.mp4)** — extended cut with session-resume CTA.

▶ **[Real dogfood session (45s)](https://github.com/manqianc/galley-lite/raw/main/docs/promo-dogfood.mp4)** — unscripted long-article edit with queue backlog (messier, but authentic).

### A real example: a wall of text → a visual explainer

Not staged — this is one actual galley edit. A plain text-only page ([`example-before.html`](docs/example-before.html)) became a dark, diagrammed explainer ([`example-after.html`](docs/example-after.html)) — a color-coded request-lifecycle flow and a real inline-SVG TLS handshake sequence diagram — from a single request: *"turn this wall of text into a visual explainer with diagrams."*

| Before | After |
|---|---|
| ![before: wall of text](https://raw.githubusercontent.com/manqianc/galley-lite/main/docs/example-before.png) | ![after: diagrams + SVG](https://raw.githubusercontent.com/manqianc/galley-lite/main/docs/example-after.png) |

## What it does

- **Reconnects to the build session.** On startup it scans `~/.claude/projects` for the Claude Code session that did a `Write`/`Edit` to this exact file, and resumes it. Edits inherit *how and why* the file was built — its sources, data, and reasoning — not just the rendered HTML.
- **Click to comment, or just chat.** Open the page, turn on Comment, click any element to attach an anchored note, or type in the side panel. Batch several comments and send once — or queue multiple messages while Claude is working and reorder/cancel them in the "next up →" list.
- **Edits the file in place + live-reloads.** A warm `claude` session edits the file on disk; the page reloads itself and flashes the elements that changed.
- **Streams the reply.** Token-by-token, rendered as markdown, with live tool activity ("Reading report.html", "Editing report.html").
- **Undo and Stop.** Undo reverts the last turn (50 deep). Stop kills the in-flight turn.
- **Bring your own key.** It shells out to the official `claude` CLI. If `ANTHROPIC_API_KEY` is set, edits bill the Anthropic API (metered). If it isn't, `claude` uses whatever auth you've already configured locally.

## Requirements

- **Claude Code installed** (`claude` on your `PATH`).
- **An Anthropic API key** — `export ANTHROPIC_API_KEY=...` and edits run on the metered API. (If you don't set one, `claude` falls back to whatever auth you've already configured locally.)
- Node 18+ (zero npm dependencies — it's a single file using only Node built-ins).

## Install

Pick any surface:

```bash
# npm — no install
npx galley-lite report.html

# npm — global
npm install -g galley-lite

# Homebrew
brew install manqianc/galley-lite/galley-lite

# Claude Code plugin (adds /galley and /galley-stop)
/plugin marketplace add manqianc/galley-lite
/plugin install galley-lite
```

## Quick start

```bash
galley-lite report.html
```

This opens `http://localhost:4321` in your browser. Click **💬 Comment**, pick an element, describe the change — or just type in the **Chat** panel. The original build session is pre-warmed while you read the page, so your first edit lands fast.

## How it works

galley-lite runs a tiny loopback HTTP server that serves your HTML with an overlay injected before `</body>`. Behind it sits one persistent, warm `claude` process per document.

- **Warm session.** The process boots once (resuming the build session if found) and keeps the document and conversation in context. The first turn pays the boot + read; every follow-up skips both, so later turns are fast.
- **Auto-link.** Before booting, it finds the session that built the file and resumes it — so edits are made by the agent that already knows the file's history, with no flags.
- **Auth pass-through.** galley-lite doesn't touch credentials. If `ANTHROPIC_API_KEY` is in your environment, the `claude` child inherits it and bills the Anthropic API; if not, `claude` uses your existing local login. The startup banner prints which one is active.

A pure question doesn't reload the page; an edit reloads it once when the turn finishes. The conversation lives server-side, so it survives reloads.

## Session continuity (the auto-link)

This is the point of the tool. A hosted doc editor or a generic browser agent only sees the rendered HTML. galley-lite resumes the *actual* Claude Code session that produced it.

By default, `galley-lite <file>` does this automatically:

1. If you passed `--resume <id>`, it uses that session.
2. Otherwise, if the HTML contains `<!-- galley-session: <id> -->`, it uses that marker.
3. Otherwise, it scans the 80 most-recent transcripts in `~/.claude/projects` for a `Write`/`Edit`/`MultiEdit` to this exact absolute path, and resumes the first match — recovering that session's working directory too (a resumed session has to run from its original project dir).

Overrides:

| Override | Effect |
|---|---|
| `--fresh` | Skip auto-link; start a clean session that just chains forward. |
| `--resume <id>` | Force a specific session id. |
| `<!-- galley-session: <id> -->` | Explicit marker baked into the HTML (wins over auto-detect). |

Linking to a large build session means each turn reloads its context first, so replies can be slower. Use `--fresh` when you want speed over provenance.

## Flags

```
galley-lite <file.html> [flags]
```

| Flag | Default | Meaning |
|---|---|---|
| `--port <n>` | `4321` | Server port. If taken, auto-falls-back to the next free port (up to +20). |
| `--model <id>` | `sonnet` | `sonnet` / `opus` / `haiku`, or a full model id. |
| `--resume <id>` | — | Force edits to resume this Claude session (full context). |
| `--cwd <dir>` | auto | Directory the agent runs in. Defaults to the build session's dir, else the file's dir. |
| `--fresh` | off | Skip auto-link; start a clean session. |
| `--no-open` | off | Don't open the browser on start. |
| `--help` | — | Print usage and exit. |

## Security

galley-lite gives an agent write access to a directory on your machine, so it's built to be safe by default and to run only for you.

- **Loopback only.** The server binds to `127.0.0.1` — never the LAN.
- **Per-run CSRF token + Host-header check.** State-changing endpoints require a per-run secret embedded only in the same-origin overlay (the custom header forces a CORS preflight that's never approved), and the server rejects unexpected `Host` headers — so neither a cross-origin page nor a DNS-rebinding site can read the conversation, read local files, or drive edits.
- **Path-traversal-safe, auth-gated static serving.** Sibling assets are served only from the file's directory; over a share they require the share key, and dotfiles/secrets are blocked.
- **Agent deny-list.** The `claude` process can't read `~/.ssh`, `~/.aws`, `.env` files, keys/credentials, or write shell rc files / git hooks — limiting the blast radius even if something tries to misuse it.
- **Writes confined to the document's directory.** The agent runs in Claude's default permission mode with a directory-scoped allow-list, so it can only `Edit`/`Write` files under the folder of the document you opened — not elsewhere on disk. (If your own `~/.claude/settings.json` broadly allows writes, e.g. `Write(*)`, that global setting overrides this — so still point galley at a working directory, not `~`.)

> **Trust boundary — only open HTML you trust.** galley-lite injects its UI into the document you open, in the *same browser origin*. A malicious HTML file could try to drive the agent. The deny-list above limits what it could reach, but the safe rule is: don't `galley-lite` an HTML file from someone you don't trust, and point it at a working directory, not `~` or a secrets folder.

## Sharing (trusted-pair collaboration)

`galley-lite report.html --share` opens a public tunnel (via `cloudflared`) and prints a guest link. A guest can open the page, read the live conversation, and *suggest* edits — but **nothing a guest sends runs until you approve it.**

- **Owner-gated.** A guest's message becomes a pending request in your panel. You read the literal prompt and click Approve or Reject. Only on approval does it run, attributed to the guest. Guests can't undo, stop, or approve.
- **No host access for guests.** The guest page never contains your local CSRF token — only a separate, expiring share token. The host (you) is always on loopback; guests always arrive through the tunnel, and the two can't cross over.
- **Bounded.** `--share-ttl <min>` (default 120) sets link expiry; `--share-cap <n>` (default 40) caps total guest turns. Every guest request and your decision are appended to `~/.galley-lite-audit.jsonl`.
- **This is for people you trust** (a teammate you'd pair with), not public sharing. The agent still edits files in your directory when you approve — approve only what you'd run yourself. For hands-off multiplayer, use the hosted galley instead.

Requires `cloudflared` (`brew install cloudflared`). It's mandatory on purpose: cloudflared stamps an unforgeable header on guest requests, which is how the host/guest boundary holds. galley-lite won't hand out a link any other way (a self-rolled tunnel could leak host access).

## FAQ

**Does it cost money?**
galley-lite is free and open source. Token usage is billed by Anthropic: set `ANTHROPIC_API_KEY` and edits run on the metered Anthropic API, billed to your key. galley-lite never handles or stores your credentials — it shells out to the official `claude` CLI, which reads them from your environment.

**Is my code or my file sent anywhere?**
Only to Claude, the same way any Claude Code session sends context to Anthropic. galley-lite itself is local: a loopback server, no telemetry, no third-party services, no account. Your file is edited in place on disk.

**What models can I use?**
`--model sonnet` (default), `opus`, or `haiku`, or any full model id your subscription supports.

**Do I have to use the click-to-comment flow?**
No. You can just chat in the side panel. Ask a question ("why are these numbers stale?") and it answers without touching the file; say "ok, fix them" and it edits. Comments are an optional way to anchor a request to a specific element.

**What if port 4321 is busy?**
It automatically tries the next port (up to +20) and prints the URL it actually bound.

**Does it work if the file wasn't built by Claude Code?**
Yes. If there's no build session to link, it runs a fresh session that just chains forward turn to turn. You lose the provenance, not the editing.
