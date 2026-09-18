# claude-anywhere — house rules

Everything an agent needs to work in this repo. The same rules a human
contributor gets are in [CONTRIBUTING.md](CONTRIBUTING.md); this file is the
short, operational version.

## Running and checking

```bash
npm install
npm start                                  # http://127.0.0.1:7777
PORT=7779 CLAUDE_ANYWHERE_DATA_DIR=/tmp/cr node server.mjs   # a second copy, own data
npm run desktop                            # native window (needs Rust + tauri-cli)
```

- **The client has no build step.** Edit `public/`, reload the page.
- **The server has no watcher.** Restart it after touching `server.mjs` or
  `lib/`. A stale process serving old code is the first thing to suspect when
  a change "does nothing".
- Before committing: `node --check` on every `.mjs`/`app.js` you touched, and
  `cargo check` in `src-tauri/` if you touched Rust. CI runs both.

## Proving a change works

Screenshots, not assertions. Drive the app with Playwright against a dev
server, do the thing a person would do, and keep the screenshot:

```js
const { chromium } = require('playwright');
const b = await chromium.launch({ channel: 'chrome', headless: true });
const page = await b.newPage({ viewport: { width: 1380, height: 860 } });
await page.goto('http://127.0.0.1:7779/');
```

- Check the phone width (390 px) for anything visual, and WebKit when layout
  changed — this app is used from Safari on a Mac too.
- Real turns are cheap with `model: 'claude-haiku-4-5-20251001'` and a prompt
  that does one small thing.
- For the native window: it renders through WebView2, so take the shot with a
  DPI-aware script (`SetProcessDPIAware`) or the right-hand side is cut off and
  you will chase a bug that is not there.

## Style

- Comments explain **why**, never what. The reason is usually an SDK behaviour,
  a Windows detail, or a bug that came back — write that.
- Match the file you are in. Long one-line handlers are normal here.
- No new dependencies without a reason that survives being said out loud.
- Interface copy uses Claude Desktop's own words where an equivalent exists,
  and plain sentences everywhere else.
- `theme-desktop.css` grows in versioned blocks at the end
  (`/* ---------- v24: ... */`); do not reorganise the file.

## Traps that already cost a day

- **One `createSdkMcpServer` instance binds to one transport.** Build a fresh
  one per run or the second live session reports the connector as failed.
- **A message typed mid-turn must be yielded into the streaming input at once**;
  the CLI folds it in at the next tool boundary. Do not hold it until `result`.
- **`perTaskStopAffordance: true`** is what keeps a Stop from killing
  background agents. Absence fails closed.
- **`background_tasks_changed` replaces the set**; do not merge it edge by edge.
- **WebView2 caches hard** — static files go out `Cache-Control: no-cache`.
- **The running app locks `target/release`**: a rebuild closes the window
  first. Never wait for "no live runs" before building — the person pressing
  Rebuild is usually mid-turn in this very app, and that waits for itself.
- **Windows paths in heredocs**: `\U`, `\a` and friends get mangled. Write a
  file with the Write tool or a PowerShell here-string instead.

## Git

- Branch, then a pull request. Commit subjects are lower case, no trailing
  period, and say what now happens.
- Never commit `.env`, `data/`, or anything under `src-tauri/target/`.
- Check `git status --short` and the staged diffstat before every commit: the
  file count must be the change you meant to make.
