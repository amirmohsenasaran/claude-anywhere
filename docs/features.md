# What it does

## Sessions

- The sidebar lists every session across every project, grouped by folder,
  including the ones started in the VS Code extension or a terminal.
- **The order is yours.** A new project goes to the bottom once, a new session
  to the top of its project once, and after that only you move them: drag and
  drop on a desktop, *Move up* / *Move down* from the long-press menu on a
  phone. Nothing re-sorts because a session was written to. The order lives on
  the server, so every device sees the same one.
- Pin a session to keep it in its own group at the top.
- The row menu (right-click, or long-press on a phone) has Open, Move up/down,
  Mark as read/unread, Pin, Rename, Fork, Archive, Delete.
- **Dots.** A pulsing dot means the session is waiting for your approval; red
  means its last turn failed; blue means it finished while you were looking
  somewhere else. Opening it clears the dot, and the unread mark survives a
  restart (`data/attention.json`).

## Reading and continuing

- Open a session to read it: text, thinking, tool calls with input and result,
  images and video the assistant produced.
- Send a message to continue it; the reply streams. It is the same session on
  disk, so `claude --resume` in a terminal picks it up afterwards.
- A turn keeps running when the phone screen goes off. Reopening the chat
  replays what was missed.
- **Rewind to here** under any earlier message of yours: a new session that is
  this one up to just before that message, with the message back in the
  composer to change and send again. The original is untouched.

## While Claude works

- A status line under the last message says what is happening ("Thinking…",
  "Running Bash…", "Waiting for your approval"), with seconds elapsed and
  output tokens. Thinking streams live and collapses to "Thought for 4s".
- **Messages typed mid-turn are handed over at once** and Claude reads them
  after the current step, at the next tool boundary — not after the whole turn.
  The bubble stays dashed until the turn takes it up.
- Permission mode (Manual / Accept edits / Plan / Auto / Bypass), model and
  effort can all be changed mid-turn. Shift+Tab cycles the mode like the CLI,
  1–5 pick one directly.
- Permission prompts appear as a card with **Allow**, **Allow always** and
  **Deny**, answerable from the phone.
- The composer's stop button ends the turn. Background work is not killed by
  it — each task has its own Stop.

## Tasks

Every command, subagent and workflow a turn runs is a task. A bar above the
composer says how many are running; it opens a panel on the right, or a
full-screen sheet on a phone:

- what it is (Command, Agent · explore, Workflow · spec), how long it has run,
  tool uses and tokens for agents, and a one-line progress summary;
- its **live output**, tailed while it runs;
- its own **Stop**;
- **Run in background** on a foreground command or agent — the CLI's Ctrl+B —
  so Claude carries on without waiting for it.

The session's process stays alive until background work finishes, and each
finished task stays listed with its result until you clear it.

## Changes

The `+n −m` in the bar above the composer (and *Changes* in the session menu)
opens a panel listing every file that differs from `HEAD` in the session's
folder — modified, added, deleted, renamed — with per-file line counts. Tap a
file for its diff with old and new line numbers; untracked files show as fully
added. It refreshes when a turn ends.

## Watching your other windows

Open a session that VS Code, a terminal or Claude Desktop is working on and the
app follows its transcript file: each finished block appears as the other
window writes it, the header says "Working in another window", and the composer
stays locked until that turn ends. Sessions written to in the last 45 seconds
carry a dot.

> Do not *continue* a session from here while it is mid-turn somewhere else —
> two processes would append to the same transcript. Reading is always safe.

## Accounts

Two accounts, switchable at any time from the bottom of the sidebar:

- **This computer's login** — whatever `claude login` signed into.
- **A token** — from `claude setup-token`, or a Console API key, pasted into
  the app. It is proven with one small request and then kept in
  `data/auth.json`. Remove it from the same dialog.

Whatever you send is billed to the active account; the sessions stay on this
computer either way. Plan usage (5-hour and weekly) is shown for an account
signed in on this machine; a `setup-token` account cannot read it, because that
token is not allowed to.

## Connectors and plugins

The **+** menu in the composer opens *Connectors & plugins*: the MCP servers
from this computer's Claude Code config (user, project and `.mcp.json`) with a
switch each — off applies to the next turn, or immediately in a running one —
and the plugins from `~/.claude/settings.json`.

## The native window

The Windows app is a small Tauri (Rust) shell on the WebView2 that Windows
already has: a few megabytes, light on memory. It starts the same Node server
inside itself, opens the chat already signed in, lives in the tray (closing the
window hides it), can start with Windows, and raises a system notification when
Claude asks for a permission or finishes a turn while the window is not in
front.

It has **no Windows title bar**. The page draws its own: the header row and the
top of the sidebar drag the window, double-clicking maximises, and minimise,
maximise and close sit at the top right. In a browser those buttons do not
appear.

Its settings live in `%APPDATA%\com.arya.claude-anywhere\.env`, its data (pins,
order, attention marks, an optional token) next to them. Point
`CLAUDE_ANYWHERE_SERVER_DIR` at a checkout and the app serves that working copy,
which is what makes the next section work.

## Updating without going to the PC

From *Connectors & plugins* → **App**:

- **Restart server** reloads `server.mjs`, `lib/` and `public/` from the
  checkout and reloads the window. It refuses while Claude is mid-turn, since
  that would kill the turn.
- **Rebuild app** is for changes to the Rust shell. It closes the window,
  runs `cargo tauri build` (1–3 minutes) and opens it again; the log streams
  into the panel. The chat does not stop — the server is a separate process, so
  a turn in flight keeps running and the phone keeps working.

A banner appears by itself when the files on disk are newer than what is
running, and says which one you need.

## Not there yet

Honest gaps against Claude Desktop's Code tab, roughly in the order they are
worth doing:

- Sidebar filters (group by date/state, show archived, sort).
- A file browser and search inside transcripts.
- Keyboard shortcuts and a command palette.
- Fast mode and a default effort setting.
- The PR bar's monitoring (CI failures, review comments, auto-merge).
- Per-session git worktrees.
- Keep computer awake.
- Terminal, browser and preview panes; split view.
- macOS and Linux shells (the web client already works everywhere; only the
  native window is Windows-only).

And one that is further out than the rest: **other providers** — adding an
OpenAI or Google account next to your Claude one and continuing the same
session on GPT or Gemini. The transcript and the tool protocol are Claude
Code's, so it needs a translation layer; see the roadmap in the README.
