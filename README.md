# claude-remote

A small self-hosted web app, styled like claude.ai, that lists, continues and
starts the **Claude Code sessions on this PC** from any device (phone included).

It is built on the official Claude Agent SDK, so it reads the same session
transcripts Claude Code writes (`~/.claude/projects/...`) and continuing a
session is exactly `claude --resume`. It never touches `~/.claude/settings.json`
or the Claude Desktop app.

## Run

```
npm install
copy .env.example .env      # optional: REMOTE_PASSWORD, USER_NAME
npm start                   # http://127.0.0.1:7777
```

There is no password unless you set one in `.env`. The first time a device
opens the app it asks which Claude account to use.

## Reach it from the phone

By default the server listens on localhost only. Pick one:

- **Tailscale (recommended):** `tailscale serve --bg 7777`, then open the
  machine's Tailscale URL on the phone. Add the page to the home screen; it is a
  PWA.
- **Own LAN / Tailscale IP directly:** set `HOST=0.0.0.0` in `.env` and open
  `http://<pc-ip>:7777`.
- **Cloudflare Tunnel:** `cloudflared tunnel --url http://127.0.0.1:7777`.

The PC has to be awake: the sessions, files and tools live here.

## What it does

- Sidebar lists every session across projects, grouped by folder, newest first
  (includes sessions started in the VS Code extension and the terminal).
- Open a session to read it: text, thinking, tool calls with input and result.
- Send a message to continue it (streams live). Tool permission prompts show up
  as a card with Allow / Allow always / Deny, answered from the phone.
- New chat: choose a folder, type, go. It becomes a normal Claude Code session
  that `claude --resume` in a terminal can pick up as well.
- A turn keeps running if the phone screen turns off; reopening the chat
  replays what was missed.

## Caveats

- Do not continue a session from here while it is open and mid-turn in VS Code
  or a terminal; two processes would append to the same transcript. Reading is
  always safe.
- One live turn per session at a time.
- Everything is served over plain HTTP; keep it behind Tailscale or a tunnel.

## Watching other windows

Open a session that VS Code, a terminal or Claude Desktop is working on and the
app follows its transcript file: each finished block (text, tool call, result)
appears as the other window writes it, the header says "Working in another
window", and the composer stays locked until that turn ends. Sessions written
to in the last 45 seconds carry a dot in the sidebar.

## Accounts

Two accounts are available and you switch between them any time from the
sidebar (click your name, or "Switch"):

- **This computer's login**: whatever `claude login` signed into on this PC.
- **Token**: a token from `claude setup-token` (or a Console API key) pasted
  in the app. It is proven with one small Haiku request, then kept in
  `data/auth.json`. Remove it from the same dialog.

Whatever you send is billed to the active account; the sessions themselves
stay on this computer either way. The account line at the bottom of the
sidebar comes from `claude auth status`, run on the active account.

## Desktop app (Windows, Rust + WebView2)

```
npm run desktop    # cargo tauri dev: run it as a native window from this folder
npm run dist       # cargo tauri build: src-tauri/target/release/bundle/nsis/Claude Remote_x.y.z_x64-setup.exe
```

The shell is a small Tauri (Rust) app on the WebView2 that Windows already
has, so it is a few megabytes and light on memory. It starts the same Node
server inside itself (Node 20+ must be installed and on PATH), opens the chat
in its own window already signed in, lives in the tray (closing the window
hides it), can start with Windows, and shows a system notification when
Claude asks for a permission or finishes a turn while the window is not in
front. It listens on all interfaces so the phone can reach it: tray → "Phone
connection…" shows the address (Tailscale first) and the password. Its
settings live in `%APPDATA%\com.arya.claude-remote\.env`, pins and the
optional token in `%APPDATA%\com.arya.claude-remote\data\`, and the server log
next to them.

Building needs the Rust toolchain (`rustup`; the GNU toolchain works) and the
Tauri CLI (`cargo install tauri-cli --version ^2`). The Agent SDK brings its
own Claude Code binary (`@anthropic-ai/claude-agent-sdk-win32-x64`), so the
installer is about 250 MB and does not depend on the `claude` CLI.

## While Claude works

- A status line under the last message shows what is happening ("Thinking…",
  "Running Bash…", "Waiting for your approval"), seconds elapsed and output
  tokens; thinking streams open and collapses to "Thought for 4s".
- Messages typed while Claude works are handed to Claude Code at once; it reads
  them after the current step (the next tool boundary), not after the whole
  turn, exactly as the CLI and Desktop do. The bubble is dashed until the turn
  takes it up. Esc or the stop button interrupts.
- Permission mode (Manual / Edit automatically / Plan / Auto), model and effort
  can be changed mid-turn; Shift+Tab cycles the mode like the CLI.
- **Tasks.** Every command and subagent the turn runs is a task. A bar above
  the composer ("2 tasks running · 1 command · 1 agent") opens a panel on the
  right (a full-screen sheet on the phone) with each task: what it is, how long
  it has run, tool uses and tokens for agents, a one-line progress summary, its
  live output, and its own **Stop**. A foreground command or agent can be sent
  to the background ("Run in background", the CLI's Ctrl+B) so Claude carries
  on. The stop button in the composer ends the turn only; background tasks keep
  running until they finish or you stop them, and the session process stays up
  until then. Finished tasks stay listed with their result until cleared.

## The window

The app window has no Windows title bar, like Claude Desktop's. The page draws
its own: the header row (and the top of the sidebar) is the drag handle,
double-clicking it maximises, and minimise / maximise / close sit at the top
right. They only appear inside the app; in a browser the page looks unchanged.

The buttons talk to the window through Tauri, and the page is served over http,
which counts as a remote origin, so the window commands are granted to it in
`src-tauri/capabilities/window-controls.json` — nothing else is. Closing still
only hides the window; the server, and the phone, keep running.

## Sidebar dots, Changes, Rewind

- **Dots.** A session that is waiting for your approval gets a pulsing dot;
  one whose last turn failed a red one; one that finished while you were not
  looking at it a blue one (Desktop's unread dot). Opening the session clears
  it; the long-press / right-click menu has *Mark as unread* / *Mark as read*.
  Unread survives a restart (`data/attention.json`).
- **Changes.** The `+n −m` in the bar above the composer (and *Changes* in the
  session menu) opens a panel on the right listing every file that differs
  from `HEAD` in the session's folder, modified / added / deleted / renamed,
  with per-file counts; tap a file for its diff with old/new line numbers.
  Untracked files show as fully added. Refreshes when a turn ends.
- **Rewind to here** under any earlier message of yours: a new session that is
  this one up to just before that message, with the message back in the
  composer to change and send again. The original session is untouched.

## Updating from the phone

Open Connectors & plugins (plug icon at the top) → **App**:

- **Restart server** — picks up new server and page code (`server.mjs`, `lib/`,
  `public/`) from the checkout the app runs from, and reloads the window. The
  app refuses while Claude is mid-turn. Set `CLAUDE_REMOTE_SERVER_DIR` in the
  app's `.env` (`%APPDATA%\com.arya.claude-remote\.env`) to the repo folder so
  the app serves the working copy directly.
- **Rebuild app** — only when the Rust shell (`src-tauri/`) changed. A detached
  script (`scripts/rebuild.ps1`) waits until nothing is running, closes the app,
  runs `cargo tauri build` and relaunches it; the log streams into the panel.

Restarts never kill a running turn: a busy server stays up until it is idle,
and the next app instance adopts it.
