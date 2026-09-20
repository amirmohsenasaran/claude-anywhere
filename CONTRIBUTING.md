# Contributing

Thanks for looking. This is a small project with strong opinions about how it
reads and behaves; the rules below are what keeps it that way.

## Running it

```bash
npm install
npm start                 # http://127.0.0.1:7777
```

There is **no build step for the client**. `public/` is plain HTML, CSS and one
JavaScript file; reload the page and your change is there. The server has no
watcher either — restart `npm start` after editing `server.mjs` or `lib/`.

For the native window you need [Rust](https://rustup.rs/) and
`cargo install tauri-cli --version "^2"`, then `npm run desktop`.

Run a second copy on another port while your own is running:

```bash
PORT=7779 CLAUDE_ANYWHERE_DATA_DIR=/tmp/cr-dev node server.mjs
```

## Checks before a pull request

There is no test runner yet. What is expected instead:

1. `node --check` on every file you touched (`server.mjs`, `lib/*.mjs`,
   `public/app.js`). CI does this for all of them.
2. `cargo check` in `src-tauri/` if you touched Rust. CI does this too.
3. **Walk the change in a browser.** Playwright against a dev server is how
   every feature in here was checked — open the app, do the thing, and put the
   screenshot in the pull request. A UI change without a screenshot will be
   asked for one.
4. Check the phone width (390 px) and, if you touched layout, WebKit — the app
   is used from Safari on a Mac as well as Chrome.

## Style

- **Comments say why, not what.** If a line is surprising, the comment explains
  the reason it has to be that way — usually an SDK behaviour, a Windows
  detail, or a bug that came back. Do not narrate the code.
- **Match the surrounding code.** Long single-line handlers are normal here;
  so is `const` everywhere and early return.
- **No dependencies unless there is no other way.** The client has two
  (`marked`, `dompurify`) and no framework.
- **Words are part of the design.** Labels are what Claude Desktop calls the
  same thing where an equivalent exists, and sentences in the interface are
  written for a person, not for the system's internals.
- **British-ish spelling in prose, US in code identifiers** — match what is
  already there rather than converting a file.

## Commits and pull requests

- One subject per commit, lower case, no trailing period, in the imperative or
  as a statement of what now happens: `tasks: stop a single background task`.
  Say the *why* in the body when the change is not obvious.
- **Do not rewrite a branch that is already pushed.** When `main` has moved and a
  pull request conflicts, pull `main`, start a fresh branch from it and apply the
  work there — history you can trust beats history that is tidy. Check the PR is
  still open before adding to its branch: `main` releases on every green run, so a
  commit pushed after the merge is orphaned and misses the build.
- A pull request explains what changed, how you checked it, and carries a
  screenshot if anything visible moved.

## Releases

Nobody publishes from a laptop. A pull request merges into `main`, CI goes green,
and the **Release** workflow does the rest: it works out the next version, writes
it into `package.json`, `tauri.conf.json`, `Cargo.toml` and the lockfile, moves the
changelog's *Unreleased* section under that version, commits, tags, builds the
Windows, macOS and Linux installers on their own runners, and publishes the release
with the changelog section as its notes. Running apps notice it within the hour.

What decides the number:

- an `### Added` block in *Unreleased* makes it a **minor** bump, anything else a
  **patch** — while the major is 0, that is the promise the changelog makes;
- a `package.json` already ahead of the last tag is taken at its word, which is how
  `1.0.0` will happen;
- a merge that touched only docs, the changelog or the workflows is not a release,
  and `[skip release]` in the merged commit's subject stops one outright;
- Actions → *Release* → *Run workflow* forces a version by hand, and *dry run*
  shows what it would do without pushing anything.

So: write the changelog entry in the pull request that earns it. It is what the
release page will say, and it is what decides the version.

## Where to start

- Issues labelled `good first issue`.
- The gap list in [docs/features.md](docs/features.md) under *Not there yet* —
  those are real, wanted, and each is small enough to do alone.

## Reporting a security problem

Do not open an issue. See [SECURITY.md](SECURITY.md).
