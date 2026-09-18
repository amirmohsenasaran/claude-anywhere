# Architecture

Four pieces, none of them clever:

```
  browser / phone / Mac ──┐
                          ├─ http ─► server.mjs ─► lib/runs.mjs ─► Claude Agent SDK ─► Claude Code
  native window (Tauri) ──┘             │                                                  │
                                        ├─ lib/tail.mjs ──────────────────┐                │
                                        └─ data/ (prefs, attention, auth) │                │
                                                                          ▼                ▼
                                                            ~/.claude/projects/<project>/<id>.jsonl
```

## `server.mjs`

An Express app on port 7777. It serves `public/`, exposes the session API, and
holds nothing in memory that matters except the live runs.

Every `/api` route needs the bearer token, which is
`sha256("claude-remote:" + (password || "open"))` — so with no password
configured, anything that can reach the port is authorised. That is deliberate
(see [SECURITY.md](../SECURITY.md)) and why the default bind is localhost.

Two routes accept the token in the query string instead of a header, because
`EventSource` cannot send headers: the per-session event stream and `/notify`.

## `lib/runs.mjs` — one process per live turn

`startRun()` opens a `query()` from the Agent SDK with a **streaming input**
prompt, which is what makes the app behave like the CLI:

- A message typed while Claude works is yielded into that stream immediately.
  The CLI folds it into the running turn at the next tool boundary. Holding it
  back until `result` — the obvious implementation — is what made an earlier
  version feel wrong.
- `perTaskStopAffordance: true` tells the CLI that this client renders a stop
  control per task, so an interrupt ends only the turn and leaves background
  agents and commands running. Without it the SDK fails closed and kills them.
- Task lifecycle arrives as `system` messages (`task_started`, `task_progress`,
  `task_updated`, `task_notification`) plus `background_tasks_changed`, which
  carries the whole live set and should replace your copy rather than being
  merged edge by edge.
- The in-process MCP server that provides `SendUserFile` is **built per run**.
  One instance binds to one transport, so sharing it makes the second live
  session report the connector as failed.

Events are pushed into a per-run buffer and fanned out over SSE, so a phone
that drops off and comes back replays what it missed by id.

## `lib/tail.mjs` — following someone else's window

When a session has no live run here, the event stream tails its `.jsonl`
instead. Claude Code appends one JSON line per finished block, so what the app
shows is exactly what the other window has already shown. A file written to in
the last 45 seconds counts as "working elsewhere".

## `public/` — the client

No build step and no framework: `index.html`, two stylesheets and `app.js`.
`style.css` is the structure; `theme-desktop.css` is the Claude Desktop look,
appended in versioned blocks (`/* ---------- v23: ... */`) so the history of
how it got there stays readable.

The client keeps per-device preferences in `localStorage` (the last folder, the
default model and mode) and everything shared on the server, because the phone
and the desktop have to agree: pins, sidebar order, per-session settings,
unread marks.

## `src-tauri/` — the native shell

A Tauri 2 app on WebView2. It:

- starts the Node server as a child process, or **adopts** one that is already
  listening and answers to the same token;
- passes `CLAUDE_REMOTE_PARENT_PID` so the server can exit when the app is
  gone — unless a turn is still running, in which case it stays up and the next
  app instance adopts it. That is why *Rebuild app* does not interrupt a chat;
- loads `http://127.0.0.1:<port>`, which counts as a **remote origin**: the
  window commands used by the title bar are granted to it explicitly in
  `capabilities/window-controls.json`, and nothing else is.

## Data

| File | What |
|---|---|
| `data/prefs.json` | pins, sidebar order, per-session model/mode/effort, disabled MCP servers |
| `data/attention.json` | unread / failed marks |
| `data/auth.json` | the pasted token, if any |
| `data/limits.json` | last known plan usage, so the banner is right on the first screen |

All git-ignored. `CLAUDE_REMOTE_DATA_DIR` moves them, which is how the native
app keeps its own set under `%APPDATA%`.

## Things that will bite you

- **The server has no watcher.** Restart it after every change to `server.mjs`
  or `lib/`.
- **WebView2 caches hard.** Static files are served `Cache-Control: no-cache`
  for that reason; without it the window keeps showing the page it first
  loaded, and a restart looks like it did nothing.
- **A running app locks files in `target/release`**, so a rebuild cannot
  overlap with it — the window has to close for the compile.
- **Two writers, one transcript.** Never continue a session here while another
  window is mid-turn on it.
