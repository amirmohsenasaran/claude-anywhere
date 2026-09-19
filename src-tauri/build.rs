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

    tauri_build::build()
}
