# runtime/

The Node binary the installer carries, so nobody has to install Node to run the app.
It is not committed: `node scripts/fetch-node.mjs` downloads it here (the release
workflow does this before bundling), and `bundle.resources` ships this folder as
`server/runtime/` next to the server.

The desktop shell runs `server/runtime/node` (`node.exe` on Windows) when it is there,
and falls back to a Node on `PATH` when it is not — which is how `cargo tauri dev` still
works without running the script first.
