<div align="center">

# Claude Anywhere

**One set of sessions. Any of your Claude accounts. Your machine, not a relay.**

A self-hosted desktop app and web client for the Claude Code sessions already on
your computer. Switch which account answers — this machine's login, or a token
you paste from another — without leaving the session, and reach all of it from
your phone over your own network.

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

## Why this exists

Claude Desktop is good, and it can already reach your machine from elsewhere
through Remote Control. Three things sent me here anyway.

**One session, whichever account you like.** Desktop is signed in as one
account. Here there are two, side by side: this computer's `claude login`, and a
token you paste — `claude setup-token` output from any other account, or a
Console key. You switch between them from the sidebar at any moment, and the
sessions do not care: the same conversation, the same files, answered by
whichever account you picked, billed to that account's plan. If you have a
personal subscription and a work one, or someone hands you a token for an
afternoon, this is the difference between one tool and two.

**No relay in the middle.** Desktop's Remote Control goes through
`claude.ai/code`, and an organisation policy can switch it off. Here your phone
opens a port on your own machine over Tailscale or your LAN. Nothing passes
through anyone else's service, there is no extra sign-in, and it keeps working
on a network that cannot reach a hosted one.

**It is yours.** MIT, no build step, one JavaScript file for the whole client.
When something is wrong for the way you work, you change it — and several things
in here exist because Desktop does not do them: a sidebar that never re-sorts
itself, per-task Stop for background commands and subagents, Rewind on any
earlier message, and a dev-server preview that reaches your phone.

| | Claude Desktop | Claude Anywhere |
|---|---|---|
| Accounts | one, signed in | two at once: this machine's login and a pasted token, switchable mid-session |
| Reaching your machine | Remote Control, through `claude.ai/code` | direct, over Tailscale or your own LAN |
| Turned off by an org policy | possible | nothing to turn off |
| Where your code goes | stays on the machine | stays on the machine, and there is no server of ours |
| Source | closed | MIT, ~4,000 lines you can read and change |
| Sidebar order | sorts itself | yours, by drag and drop |
| Preview of your dev server | yes, on that machine | yes, and on your phone |
| Panes: terminal, browser, worktrees | yes | not yet |
| macOS and Linux app | yes | web client only; the native window is Windows |
| Support | Anthropic | an issue tracker and me |

**They are not rivals.** This reads and writes the same transcripts as
`claude --resume`, the VS Code extension and Desktop itself, so a session you
start in one you can pick up in another — and while another window is mid-turn
on a session, this one follows along and shows what it is doing.

## Highlights

- **Two accounts, one set of sessions**: this computer's `claude login` and a
  token you paste, switched from the sidebar whenever you like. Plan usage is
  shown for whichever one is answering.
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
- **Preview**: the project's dev server inside the app, proxied so your phone
  can see a server that only listens on the PC — hot reload included.
- **Rewind to here** on any earlier message: a fork of the session up to just
  before it, with the message back in the composer to change and resend.
- **Watches your other windows**: a session being worked on in VS Code, a
  terminal or Claude Desktop streams in here as that window writes it.
- **Native Windows app**: WebView2, a few megabytes, tray icon, start with
  Windows, system notifications, its own title bar.

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

## Roadmap

Near term, in the order they are likely to happen:

- [ ] Sidebar filters: group by date or state, show archived, sort.
- [ ] Preview tools for Claude: the previewed page's console, network errors
      and DOM, so it can fix what it is looking at.
- [ ] A file browser, and search inside transcripts.
- [ ] Keyboard shortcuts and a command palette (⌘K), for the Mac browser.
- [ ] The PR bar's monitoring: CI failures, review comments, auto-merge.
- [ ] Per-session git worktrees, and *Keep computer awake*.
- [ ] A macOS shell, so the native window is not Windows-only.

Bigger, and deliberately further out:

- [ ] **Other providers.** Keep one conversation and change who answers it:
      add an OpenAI or Google account alongside your Claude one and continue
      the same session on GPT or Gemini, with the same files and the same
      tools. The transcript format and the tool protocol are Claude Code's, so
      this needs a translation layer rather than a switch — it is an intention,
      not a promise, and it will land behind a flag first.
- [ ] Shared sessions: a link that lets a teammate watch a run without
      touching your machine.

Ideas and arguments about the order belong in
[Discussions](https://github.com/aryasadeghy/claude-anywhere/discussions).

## Contributing

Issues and pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md)
for how to run it, what the house style is, and what a PR needs (a screenshot,
if it changes anything you can see). [CLAUDE.md](CLAUDE.md) is the same set of
rules written for Claude Code itself, so an agent working in this repo starts
out knowing them.

## Star history

<a href="https://star-history.com/#aryasadeghy/claude-anywhere&Date">
  <img src="https://api.star-history.com/svg?repos=aryasadeghy/claude-anywhere&type=Date" alt="Star history chart" width="600">
</a>

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
