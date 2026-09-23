// The desktop binary. Everything lives in the library beside it, because iOS and Android
// build an app from a library with a mobile entry point rather than from a `main` — so
// the same code is the Windows, macOS and Linux app and the phone app.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    claude_anywhere_lib::run()
}
