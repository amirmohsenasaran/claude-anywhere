# Getting started

From nothing to answering Claude from your phone. Fifteen minutes, most of it
downloads.

## 1. What you need

| | Why |
|---|---|
| **Windows 10 or 11** | For the native app. The web client works on any OS. |
| **[Node.js][node] 20+** on `PATH` | The server runs on it. `node -v` should print v20 or newer. |
| **A Claude account** | Max, Pro or a Console key. Claude Code itself comes with the app. |
| *(from source)* [Rust][rust] + `cargo install tauri-cli --version "^2"` | Only to build the native window yourself. |

You do **not** need the `claude` CLI installed: the Agent SDK brings its own
Claude Code binary. If you already use Claude Code, this app picks up every
session you have.

## 2. Install

**From a release:** download the installer from [Releases][releases], run it,
and skip to step 3.

**From source:**

```bash
git clone https://github.com/aryasadeghy/claude-anywhere
cd claude-anywhere
npm install
npm start
```

Open <http://127.0.0.1:7777>. That is the whole web app; the native window is
`npm run desktop`.

## 3. Sign in

The first time a device opens the app it asks which Claude account to use:

- **This computer** — whatever `claude login` signed into on this machine. If
  you have never signed in, run `claude login` once (the app cannot do the
  browser flow for you).
- **A token** — run `claude setup-token` on any machine and paste what it
  prints. The app proves it with one small request before keeping it.

You can switch at any time from the bottom of the sidebar.

## 4. Start a session

Press **New**, pick a folder with the folder chip, type what you want, send.
That is a normal Claude Code session in that folder — the same one
`claude --resume` will offer you in a terminal later.

If you already use Claude Code, your existing sessions are in the sidebar
already, grouped by project.

## 5. Get it on your phone

The server only listens to your own computer until you do something about it.
The safest way is [Tailscale][tailscale] — a private network between your own
devices:

1. Install Tailscale on the PC and on the phone, signed into the same account.
2. On the PC: `tailscale serve --bg 7777`.
3. On the phone, open the URL Tailscale prints (something like
   `https://your-pc.tail1234.ts.net`).
4. Share → **Add to Home Screen**. It gets an icon and opens without browser
   chrome.

Other ways, and what each one costs you, are in [SECURITY.md](../SECURITY.md).

> The PC has to be awake. The sessions, the files and the tools are on it; the
> phone is only a screen.

## 6. Live with it

- Leave a long task running and close the phone. Come back and it is still
  going, with the output it produced.
- When Claude asks for permission, the phone raises a notification (in the
  native app) and the card is in the chat.
- Press the **+** in the composer for connectors, plugins and the App panel,
  where you can restart the server or rebuild the app after pulling changes.

## Trouble

**"Claude Code did not start in time"** — usually Node is not on `PATH` for the
app, or the account has no valid credentials. Try `npm start` in a terminal and
read the error there.

**The phone cannot reach it** — check `HOST` in `.env`. With Tailscale serve it
should stay `127.0.0.1`; with a direct LAN address it must be `0.0.0.0`, and
then set `REMOTE_PASSWORD` too.

**A change to the code did nothing** — the server has no watcher. Restart it
(`npm start`, or *Restart server* in the App panel).

**Anything else** — open an [issue][issues] with what you did and what
happened; the log the server prints is the useful part.

[node]: https://nodejs.org/
[rust]: https://rustup.rs/
[tailscale]: https://tailscale.com/
[releases]: https://github.com/aryasadeghy/claude-anywhere/releases
[issues]: https://github.com/aryasadeghy/claude-anywhere/issues
