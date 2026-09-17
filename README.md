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
copy .env.example .env      # set REMOTE_PASSWORD (and USER_NAME)
npm start                   # http://127.0.0.1:7777
```

Sign in with the password from `.env`.

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

The account line at the bottom of the sidebar comes from `claude auth status`,
run with the same environment the app uses for Claude. By default that is the
machine's own `claude login`. To run on another account, open "Use a different
Claude account" on the login page and paste a token from `claude setup-token`
(or a Console API key); it is proven with one small Haiku request, stored in
`data/auth.json`, and forgotten on Log out.

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
- Messages typed while Claude works are queued and run right after the current
  turn (dashed bubble until then). Esc or the stop button interrupts.
- Permission mode (Manual / Edit automatically / Plan / Auto), model and effort
  can be changed mid-turn; Shift+Tab cycles the mode like the CLI.
