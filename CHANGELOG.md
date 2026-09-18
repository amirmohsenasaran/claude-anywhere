# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) — while the major is
0, a minor bump may change behaviour.

## [Unreleased]

### Added

- **Preview panel.** Whatever the project's dev server is serving, shown inside
  the app and therefore on your phone, which cannot reach the PC's localhost by
  itself. Ports are discovered with the process behind them; everything is
  proxied through the app's own origin so relative and absolute URLs, redirects
  and the hot-reload socket keep working, and frame-busting headers are dropped.
  Localhost only, by construction.

### Fixed

- **Images in a session open full size again.** They called `window.open`,
  which does nothing inside the app's WebView, so tapping one left it sitting
  there; markdown images had no handler at all. All of them now open in a
  lightbox that scales a small image up to fit (never past 3x), shows it at its
  own size on a second tap, and closes on Escape or a tap outside.
- **Rebuild app never started anything.** The server spawned its script with
  `detached: true`, and a detached PowerShell child on Windows gets no console
  and exits immediately, silently — so the panel sat on an empty log, which the
  client rendered as "Waiting…". It is now started through a short-lived
  launcher that hands the script to `Start-Process`, so it both starts and
  outlives the window it closes.
- The App panel says when a rebuild log is from, instead of showing a finished
  log from an hour ago as if it had just happened.
- **Rebuild now waits for the window to actually exit** before compiling, and
  starts whatever binary the build produced instead of a hard-coded name — the
  rename made that name wrong, so a failed build left no window at all. A build
  that fails on a locked file (os error 32, a leftover from the compile before
  it) clears that crate's build directory and goes again once.
- **Restart server queues instead of refusing** while Claude is working: the
  server exits the moment the last turn ends and the window reloads itself. It
  used to answer 409 and leave the update banner up with nothing to press.
- The page retries for 45 seconds while the server is coming back, instead of
  showing "fetch failed" until the whole app was closed and reopened.

## [0.3.0] — 2026-09-18

First public release. The project is called **Claude Anywhere** from this
version; it was `claude-remote` while it was a personal tool. An installation
from before the rename keeps working: the server still accepts the old
`CLAUDE_REMOTE_*` variables and the token they produced, and the app copies its
settings across.

### Added

- **Tasks panel.** Every command, subagent and workflow a turn runs is listed
  with its elapsed time, tool uses, tokens, live output and its own Stop. A
  foreground task can be sent to the background (the CLI's Ctrl+B), and the
  session's process stays alive until background work finishes.
- **Changes panel.** Every file that differs from `HEAD` in the session's
  folder, with per-file counts and a diff with old and new line numbers.
- **Rewind to here** on any earlier message: a fork of the session up to just
  before it, with that message back in the composer.
- **Attention dots** in the sidebar — waiting for approval, failed, or finished
  while you were elsewhere — with *Mark as read* / *Mark as unread*. The unread
  mark survives a restart.
- **A sidebar order that stays put**, changed only by drag and drop (or *Move
  up* / *Move down* on a phone) and shared across devices.
- **The app's own title bar**: no Windows frame, minimise / maximise / close
  drawn by the page, the header row drags the window.

### Changed

- A message typed while Claude works is handed to Claude Code immediately, so
  it is read at the next tool boundary instead of after the whole turn.
- Connectors and plugins moved from the header into the composer's **+** menu,
  where Claude Desktop keeps them.
- *Rebuild app* closes the window, compiles, and opens it again, instead of
  waiting for Claude to be idle first — which never happened when the person
  pressing the button was mid-turn in the app itself. The chat keeps running
  throughout, because the server is a separate process.

### Fixed

- The in-process MCP server is built per run; sharing one instance made the
  second live session report the `claude-anywhere` connector as failed.
- Static files are served `Cache-Control: no-cache`; WebView2 was serving the
  page it first loaded, so restarts looked like they had done nothing.
- Opening a session created a second earlier returned 404 before its transcript
  existed on disk.
- Header icons no longer stack when the window is narrow.
- Untracked files counted one line too many in the diff totals.

## [0.2.0] — 2026-09-17

### Added

- Native Windows shell (Tauri 2 + WebView2) replacing an Electron prototype:
  tray icon, start with Windows, system notifications, a phone-connection
  dialog.
- Account switching between this computer's `claude login` and a pasted token.
- Connectors & plugins panel with per-server switches, and plan usage.
- Model, permission mode and effort remembered per session and changeable
  mid-turn.
- Update banner with *Restart server* and *Rebuild app*, both usable from a
  phone.
- Images: attach, paste and drop; media in answers plays inline; `SendUserFile`
  cards.
- Phone layout: one-row top bar, long-press menus as sheets, Add to Home
  Screen.

### Fixed

- Restarts no longer kill a running turn: a busy server stays up and the next
  app instance adopts it.

## [0.1.0] — 2026-09-17

- First working version: list, read and continue local Claude Code sessions
  from a browser, with live streaming, permission prompts and a new-session
  flow.

[Unreleased]: https://github.com/aryasadeghy/claude-anywhere/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/aryasadeghy/claude-anywhere/releases/tag/v0.3.0
[0.2.0]: https://github.com/aryasadeghy/claude-anywhere/releases/tag/v0.2.0
[0.1.0]: https://github.com/aryasadeghy/claude-anywhere/releases/tag/v0.1.0
