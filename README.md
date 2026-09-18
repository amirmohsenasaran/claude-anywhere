<div align="center">

# Claude Anywhere

**Your Claude Code sessions, on every screen.**

A self-hosted desktop app and web client for the Claude Code sessions already
on your computer — open them from your phone, your Mac, or a native Windows
window, and keep working where you left off.

[![License: MIT](https://img.shields.io/badge/License-MIT-black.svg)](LICENSE)
[![Windows](https://img.shields.io/badge/Windows-10%2F11-black.svg)](#install)
[![Built on the Claude Agent SDK](https://img.shields.io/badge/built%20on-Claude%20Agent%20SDK-d97757.svg)](https://docs.anthropic.com/en/docs/claude-code/sdk)

![The app on Windows](docs/images/hero.png)

</div>

## What it is

Claude Code keeps every session as a transcript on your machine. This reads
those transcripts with the official [Claude Agent SDK][sdk], shows them in a
Claude-styled interface, and lets you continue any of them — which is exactly
what `claude --resume` does, so a session you start on your phone is the same
session your terminal picks up later.

Nothing is relayed through a server of ours, because there is no server of
ours. The app is a small Node process on your machine plus a native window; the
phone talks straight to your PC over Tailscale or your own network.

**It is for you if** you leave Claude Code working on something, walk away from
the desk, and want to answer its permission prompt, read what it did, or send
the next instruction from the sofa — with the same interface you already know.

## Highlights

- **Every session, every project** in one sidebar, in an order you set by drag
  and drop and that nothing re-sorts behind your back.
- **Live turns**: streaming text and thinking, tool calls with their input and
  result, a status line, queued messages that reach Claude at the next tool
  boundary rather than at the end of the turn.
- **Permission prompts from the phone** — Allow, Allow always, Deny.
- **Tasks panel**: every command, subagent and workflow the turn is running,
  with elapsed time, live output and its own Stop; send one to the background
  and let Claude carry on.
- **Changes panel**: every file that differs from `HEAD`, with per-file diffs.
- **Rewind to here** on any earlier message: a fork of the session up to just
  before it, with the message back in the composer to change and resend.
- **Watches your other windows**: a session being worked on in VS Code, a
  terminal or Claude Desktop streams in here as that window writes it.
- **Native Windows app**: WebView2, a few megabytes, tray icon, start with
  Windows, system notifications, its own title bar.
- **Two accounts**: this computer's `claude login`, or a token you paste, and a
  switch between them.

See [docs/features.md](docs/features.md) for the whole list with the detail.

## Install

### From a release (Windows 10/11)

Download the installer from [Releases][releases] and run it. It brings its own
Claude Code binary, so the `claude` CLI is not required — but [Node.js][node]
20 or newer must be installed and on `PATH`, because the app runs the server
with it.

### From source

```bash
git clone https://github.com/aryasadeghy/claude-anywhere
cd claude-anywhere
npm install
npm start                    # http://127.0.0.1:7777
```

That is the web app on its own — enough for a phone, a Mac, or another browser
on the same machine. For the native Windows window you also need the
[Rust toolchain][rust] and the Tauri CLI
(`cargo install tauri-cli --version "^2"`):

```bash
npm run desktop              # run it as a native window
npm run dist                 # build the installer into src-tauri/target/release/bundle/nsis
```

New here? [docs/getting-started.md](docs/getting-started.md) walks the whole
thing, including the phone.

## From your phone

<img src="docs/images/phone.png" alt="The sidebar on a phone" width="260" align="right">

The server listens on `127.0.0.1` by default, so start by giving your devices a
private path to it. **Tailscale is the recommended one**:

```bash
tailscale serve --bg 7777
```

Then open the machine's Tailscale URL on the phone and add it to the home
screen — it is a PWA, so it gets its own icon and window.

> [!WARNING]
> This app runs Claude Code as you, on your machine. Anything that can reach it
> can read your files and run commands. Do not put it on the open internet, and
> set `REMOTE_PASSWORD` before binding it to a network you do not control.
> [SECURITY.md](SECURITY.md) has the short version of the threat model.

## How it works

```
  phone / Mac / browser ─┐
                         ├── http ──► server.mjs (Express, your machine)
  native window (Tauri) ─┘                 │
                                           ├── @anthropic-ai/claude-agent-sdk
                                           │      └── Claude Code ──► Anthropic
                                           └── ~/.claude/projects/*.jsonl
                                                  (the same transcripts the CLI writes)
```

- `server.mjs` — HTTP API, session list, live event streams.
- `lib/runs.mjs` — one Claude Code process per live turn, streaming input so a
  message typed mid-turn is folded in at the next tool boundary.
- `lib/tail.mjs` — follows transcripts other windows are writing.
- `public/` — the client. No build step, no framework: HTML, CSS and one JS
  file you can read.
- `src-tauri/` — the native shell (Rust): window, tray, notifications.

[docs/architecture.md](docs/architecture.md) goes deeper, including the SDK
behaviours that are easy to get wrong.

## Contributing

Issues and pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md)
for how to run it, what the house style is, and what a PR needs (a screenshot,
if it changes anything you can see). [CLAUDE.md](CLAUDE.md) is the same set of
rules written for Claude Code itself, so an agent working in this repo starts
out knowing them.

## Not affiliated with Anthropic

This is a community project. It is not made, endorsed or supported by
Anthropic. "Claude" and "Claude Code" are Anthropic's trademarks, used here
only to say what this tool works with. Your use of Claude through it is your
own Claude account, under Anthropic's terms.

## Licence

[MIT](LICENSE) © Arya Sadeghi

[sdk]: https://docs.anthropic.com/en/docs/claude-code/sdk
[releases]: https://github.com/aryasadeghy/claude-anywhere/releases
[node]: https://nodejs.org/
[rust]: https://rustup.rs/
