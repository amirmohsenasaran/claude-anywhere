use std::process::Command;

fn main() {
    // An installed app has no repository to ask what it is, so the answer is compiled
    // in: the release workflow passes the commit it checked out, and a build on
    // someone's own machine asks git. Without either it stays empty and the About
    // line simply says the version — never a commit that is a guess.
    let commit = std::env::var("CLAUDE_ANYWHERE_COMMIT")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| {
            Command::new("git")
                .args(["rev-parse", "HEAD"])
                .output()
                .ok()
                .filter(|o| o.status.success())
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        })
        .unwrap_or_default();
    println!("cargo:rustc-env=CA_COMMIT={commit}");
    println!("cargo:rerun-if-env-changed=CLAUDE_ANYWHERE_COMMIT");
    println!("cargo:rerun-if-changed=../.git/HEAD");

    // The library is also built as a cdylib, which only a phone needs — Android loads the
    // app from it. With the GNU toolchain on Windows the linker then exports every global
    // symbol of every dependency, 129,717 of them against the 65,535 a DLL can hold, and
    // the desktop build fails ("export ordinal too large"). Nothing loads that DLL on a
    // desktop, so there it exports nothing; the executable and the phone are unaffected.
    if std::env::var("TARGET").is_ok_and(|t| t.ends_with("windows-gnu")) {
        println!("cargo:rustc-cdylib-link-arg=-Wl,--exclude-all-symbols");
    }

    tauri_build::build()
}
