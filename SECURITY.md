# Security

## What this app is, in security terms

The server runs **Claude Code on your machine, as you**. Anything that can
reach it can read your files, run commands and spend your Claude usage. There
is no sandbox between a request and your shell — that is the whole point of the
product, and it is also the whole risk.

Two settings decide who can reach it:

| Setting | Default | What it means |
|---|---|---|
| `HOST` | `127.0.0.1` | Only this computer can connect. |
| `REMOTE_PASSWORD` | empty | No password is asked for. |

The defaults are safe **together**: nothing outside the machine can connect.
The desktop app ships with `HOST=0.0.0.0` so a phone can reach it, which moves
the boundary to your network — read the next section before using it that way.

## Reaching it from another device, safely

In order of preference:

1. **Tailscale** (or another WireGuard mesh): `tailscale serve --bg 7777`.
   Only your own devices can connect, and the traffic is encrypted. Keep
   `HOST=127.0.0.1`.
2. **A tunnel with authentication** in front — Cloudflare Access, an
   authenticating reverse proxy, anything that asks for an identity.
3. **Your own LAN** (`HOST=0.0.0.0`): everyone on that network can use Claude
   on your PC. Set `REMOTE_PASSWORD` as well, and never do this on café,
   hotel, airport or conference Wi-Fi.

Never put the port straight on the public internet. Plain HTTP carries the
session token, so anything between you and the server can take it.

## What is stored, and where

| What | Where | Notes |
|---|---|---|
| Session transcripts | `~/.claude/projects/` | Claude Code's own files; this app only reads and appends to them. |
| Pins, order, per-session settings | `data/prefs.json` | |
| Unread / failed marks | `data/attention.json` | |
| A pasted token | `data/auth.json` | Plain text, readable by your user. Remove it from the account dialog. |
| App password | `.env` | Plain text. |

`data/` and `.env` are git-ignored. Nothing is sent anywhere except to
Anthropic, by Claude Code itself.

## Reporting a vulnerability

Please **do not open a public issue**. Use GitHub's private reporting:
*Security* → *Report a vulnerability* on this repository. Include what you did,
what happened, and how bad you think it is. You will get a first reply within
a few days.

Fixes for anything that lets an unauthenticated request reach the machine will
be released as soon as they are ready, and credited unless you ask otherwise.
