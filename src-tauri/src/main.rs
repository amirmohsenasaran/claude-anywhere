// Claude Anywhere — native Windows shell (Tauri 2, WebView2).
//
// It starts the Node server that talks to the Claude Agent SDK, opens the chat
// in a native window already signed in, lives in the tray, can start with
// Windows, and turns permission requests / finished turns into system
// notifications. The phone keeps talking to the same server.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    fs,
    io::{BufRead, BufReader},
    net::{SocketAddr, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
    thread,
    time::{Duration, Instant},
};

use sha2::{Digest, Sha256};
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt as _};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use tauri_plugin_notification::NotificationExt;

struct ServerState {
    child: Mutex<Option<Child>>,
    port: u16,
    token: String,
    env_file: PathBuf,
    spawn: Option<SpawnCfg>, // how to start the server again (None when we adopted a running one)
}

#[derive(Clone)]
struct SpawnCfg {
    node: PathBuf,
    root: PathBuf,
    data_dir: PathBuf,
    env_file: PathBuf,
    port: u16,
}

// The server exits with this code when the app asked it to restart (POST /api/restart):
// picks up new server code from the repo without touching the window.
const RESTART_CODE: i32 = 75;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec!["--hidden"])))
        .setup(|app| {
            let handle = app.handle().clone();
            let state = start_server(&handle).map_err(|e| {
                // Keep the reason on disk too, for when the dialog is gone.
                if let Ok(dir) = app.path().app_data_dir() {
                    let _ = fs::write(dir.join("startup-error.txt"), format!("{e}\nPATH={}\n", std::env::var("PATH").unwrap_or_default()));
                }
                app.dialog().message(format!("{e}")).title("Claude Anywhere could not start").kind(MessageDialogKind::Error).blocking_show();
                std::process::exit(1);
                #[allow(unreachable_code)]
                e
            })?;
            let url = format!("http://127.0.0.1:{}/?auto={}", state.port, state.token);
            app.manage(state);

            let hidden = std::env::args().any(|a| a == "--hidden");
            let win = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url.parse()?))
                .title("Claude")
                .inner_size(1200.0, 820.0)
                .min_inner_size(380.0, 600.0)
                // No Windows caption bar: the page draws the title bar and the
                // minimise / maximise / close buttons itself, as Claude Desktop does.
                .decorations(false)
                .shadow(true)
                .visible(!hidden)
                .build()?;
            let _ = win.set_title("Claude");

            build_tray(&handle)?;
            spawn_notifier(handle.clone());
            supervise_server(handle.clone());
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window keeps the server (and the phone) alive; Quit is in the tray.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                stop_server(app);
            }
        });
}

// ---------- the Node server ----------

fn server_dir(app: &AppHandle, env_file: &Path) -> PathBuf {
    // CLAUDE_ANYWHERE_SERVER_DIR in the app's .env: run the server straight from a checkout,
    // so edits (and "Restart server" from the phone) take effect without a rebuild.
    if let Ok(text) = fs::read_to_string(env_file) {
        for line in text.lines() {
            // The old name is still in .env files written before 0.3.0.
            if let Some(v) = line.strip_prefix("CLAUDE_ANYWHERE_SERVER_DIR=").or_else(|| line.strip_prefix("CLAUDE_REMOTE_SERVER_DIR=")) {
                let p = PathBuf::from(v.trim());
                if p.join("server.mjs").exists() {
                    return p;
                }
            }
        }
    }
    // Packaged: resources/server. Development: the repository root next to src-tauri.
    if let Ok(res) = app.path().resource_dir() {
        let packaged = res.join("server");
        if packaged.join("server.mjs").exists() {
            return packaged;
        }
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..")
}

fn ensure_env_file(env_file: &Path, server_root: &Path) -> std::io::Result<()> {
    if env_file.exists() {
        return Ok(());
    }
    if let Some(dir) = env_file.parent() {
        fs::create_dir_all(dir)?;
    }
    let dev = server_root.join(".env");
    if dev.exists() {
        fs::copy(&dev, env_file)?;
        return Ok(());
    }
    let user = std::env::var("USERNAME").unwrap_or_else(|_| "there".into());
    fs::write(
        env_file,
        format!("# Optional app password. Empty = no password (keep the PC on a network you trust).\nREMOTE_PASSWORD=\nHOST=0.0.0.0\nPORT=7777\nUSER_NAME={user}\n"),
    )
}

fn read_env(env_file: &Path) -> (String, u16) {
    let text = fs::read_to_string(env_file).unwrap_or_default();
    let mut password = String::new();
    let mut port = 7777u16;
    for line in text.lines() {
        if let Some(v) = line.strip_prefix("REMOTE_PASSWORD=") {
            password = v.trim().to_string();
        } else if let Some(v) = line.strip_prefix("PORT=") {
            port = v.trim().parse().unwrap_or(7777);
        }
    }
    (password, port)
}

fn start_server(app: &AppHandle) -> Result<ServerState, Box<dyn std::error::Error>> {
    let data_dir = app.path().app_data_dir()?;
    fs::create_dir_all(&data_dir)?;
    let env_file = data_dir.join(".env");
    let root = server_dir(app, &env_file);
    ensure_env_file(&env_file, &root)?;
    let (password, port) = read_env(&env_file);
    let password = if password == "change-me" { String::new() } else { password };
    // Same derivation as server.mjs: no password means the fixed word "open".
    let token = hex::encode(Sha256::digest(format!("claude-anywhere:{}", if password.is_empty() { "open" } else { &password })));

    // Already running with our password (the server of a previous app instance that is
    // still finishing a turn, another copy, or `npm start`)? Adopt it and carry on.
    // Something else on that port (a dev server with a different password)? Pick a free one.
    let mut port = port;
    if port_open(port) {
        if server_accepts(port, &token) {
            let _ = ureq::post(&format!("http://127.0.0.1:{port}/api/adopt"))
                .set("Authorization", &format!("Bearer {token}"))
                .set("Content-Type", "application/json")
                .timeout(Duration::from_secs(3))
                .send_string(&format!("{{\"pid\":{}}}", std::process::id()));
            return Ok(ServerState { child: Mutex::new(None), port, token, env_file, spawn: None });
        }
        port = (port + 1..port + 20).find(|p| !port_open(*p)).ok_or("No free port near the configured one")?;
    }

    let node = find_node().ok_or("Node.js was not found on PATH. Install Node 20 or newer from nodejs.org and start Claude Anywhere again.")?;
    let root = root.canonicalize().unwrap_or(root);
    let root = PathBuf::from(root.to_string_lossy().trim_start_matches(r"\\?\"));
    let cfg = SpawnCfg { node, root, data_dir: data_dir.clone(), env_file: env_file.clone(), port };
    let child = spawn_server(&cfg)?;
    let _ = fs::remove_file(data_dir.join("startup-error.txt"));
    Ok(ServerState { child: Mutex::new(Some(child)), port, token, env_file, spawn: Some(cfg) })
}

fn spawn_server(cfg: &SpawnCfg) -> Result<Child, Box<dyn std::error::Error>> {
    let SpawnCfg { node, root, data_dir, env_file, port } = cfg;
    let port = *port;
    let mut log = fs::OpenOptions::new().create(true).append(true).open(data_dir.join("server.log")).ok();
    if let Some(f) = log.as_mut() {
        use std::io::Write;
        let _ = writeln!(f, "[claude-anywhere] node={} root={} port={port}", node.display(), root.display());
    }
    let log_err = log.as_ref().and_then(|f| f.try_clone().ok());
    let mut cmd = Command::new(node);
    cmd.arg(root.join("server.mjs"))
        .current_dir(root)
        .env("CLAUDE_ANYWHERE_DATA_DIR", data_dir.join("data"))
        .env("CLAUDE_ANYWHERE_ENV_FILE", env_file)
        .env("CLAUDE_ANYWHERE_APP_EXE", std::env::current_exe().map(|p| p.to_string_lossy().to_string()).unwrap_or_default())
        .env("HOST", "0.0.0.0")
        .env("PORT", port.to_string())
        .env("CLAUDE_ANYWHERE_PARENT_PID", std::process::id().to_string())
        .stdin(Stdio::null())
        .stdout(log.map(Stdio::from).unwrap_or_else(Stdio::null))
        .stderr(log_err.map(Stdio::from).unwrap_or_else(Stdio::null));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = cmd.spawn().map_err(|e| format!("Could not start Node (is it installed and on PATH?): {e}"))?;

    let deadline = Instant::now() + Duration::from_secs(30);
    while !port_open(port) {
        if let Ok(Some(status)) = child.try_wait() {
            return Err(format!("Node exited right away ({status}). See {}", data_dir.join("server.log").display()).into());
        }
        if Instant::now() > deadline {
            return Err(format!("The server did not come up on port {port}. See {}", data_dir.join("server.log").display()).into());
        }
        thread::sleep(Duration::from_millis(200));
    }
    Ok(child)
}

// Watches the server we started. Exit code 75 means "restart me" (new code from the
// repo): spawn it again and reload the window. Anything else is a crash: restart too,
// but say so.
fn supervise_server(app: AppHandle) {
    thread::spawn(move || loop {
        thread::sleep(Duration::from_millis(700));
        let Some(state) = app.try_state::<ServerState>() else { continue };
        let Some(cfg) = state.spawn.clone() else { return };
        let exited = {
            let mut guard = match state.child.lock() { Ok(g) => g, Err(_) => continue };
            match guard.as_mut().map(|c| c.try_wait()) {
                Some(Ok(Some(status))) => { *guard = None; Some(status.code()) }
                _ => None,
            }
        };
        let Some(code) = exited else { continue };
        if code != Some(RESTART_CODE) {
            let _ = app.notification().builder().title("Claude Anywhere server stopped").body("Restarting it.").show();
        }
        match spawn_server(&cfg) {
            Ok(child) => {
                if let Ok(mut guard) = state.child.lock() { *guard = Some(child); }
                if let Some(w) = app.get_webview_window("main") { let _ = w.eval("setTimeout(() => location.reload(), 300)"); }
            }
            Err(e) => {
                let _ = app.notification().builder().title("Claude Anywhere server did not come back").body(format!("{e}")).show();
                thread::sleep(Duration::from_secs(5));
            }
        }
    });
}

// node.exe from PATH, or the usual install folder; resolved here so the log says which one ran.
fn find_node() -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).map(|d| d.join("node.exe")).collect())
        .unwrap_or_default();
    if let Ok(pf) = std::env::var("ProgramFiles") {
        candidates.push(Path::new(&pf).join("nodejs").join("node.exe"));
    }
    if let Ok(la) = std::env::var("LOCALAPPDATA") {
        candidates.push(Path::new(&la).join("Programs").join("nodejs").join("node.exe"));
    }
    candidates.into_iter().find(|p| p.is_file())
}

fn port_open(port: u16) -> bool {
    let addr: SocketAddr = ([127, 0, 0, 1], port).into();
    TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok()
}

fn server_accepts(port: u16, token: &str) -> bool {
    ureq::get(&format!("http://127.0.0.1:{port}/api/me"))
        .set("Authorization", &format!("Bearer {token}"))
        .timeout(Duration::from_secs(3))
        .call()
        .is_ok()
}

fn stop_server(app: &AppHandle) {
    if let Some(state) = app.try_state::<ServerState>() {
        // Claude mid-turn? Leave the server alone: it finishes the work on its own and
        // exits when idle, and the next app instance adopts it.
        let busy = ureq::get(&format!("http://127.0.0.1:{}/api/runs", state.port))
            .set("Authorization", &format!("Bearer {}", state.token))
            .timeout(Duration::from_secs(2))
            .call()
            .ok()
            .and_then(|r| r.into_json::<serde_json::Value>().ok())
            .map(|v| v.as_array().map(|a| !a.is_empty()).unwrap_or(false))
            .unwrap_or(false);
        if let Ok(mut guard) = state.child.lock() {
            if let Some(mut child) = guard.take() {
                if busy {
                    return;
                }
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

// ---------- window, tray, dialogs ----------

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open Claude", true, None::<&str>)?;
    let phone = MenuItem::with_id(app, "phone", "Phone connection…", true, None::<&str>)?;
    let autostart_on = app.autolaunch().is_enabled().unwrap_or(false);
    let autostart = CheckMenuItem::with_id(app, "autostart", "Start with Windows", true, autostart_on, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &PredefinedMenuItem::separator(app)?, &phone, &autostart, &PredefinedMenuItem::separator(app)?, &quit])?;

    let icon = app.default_window_icon().cloned().expect("window icon");
    TrayIconBuilder::with_id("main")
        .icon(icon)
        .tooltip("Claude Anywhere")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "open" => show_main(app),
            "phone" => show_phone_info(app),
            "autostart" => {
                let on = app.autolaunch().is_enabled().unwrap_or(false);
                let _ = if on { app.autolaunch().disable() } else { app.autolaunch().enable() };
                let _ = autostart.set_checked(!on);
            }
            "quit" => {
                stop_server(app);
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_main(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

fn show_phone_info(app: &AppHandle) {
    let Some(state) = app.try_state::<ServerState>() else { return };
    let (password, port) = read_env(&state.env_file);
    let mut lines = Vec::new();
    let url = format!("http://127.0.0.1:{}/api/addresses", port);
    if let Ok(resp) = ureq::get(&url).set("Authorization", &format!("Bearer {}", state.token)).call() {
        if let Ok(json) = resp.into_json::<serde_json::Value>() {
            for a in json.as_array().cloned().unwrap_or_default() {
                let addr = a["address"].as_str().unwrap_or("");
                let name = a["name"].as_str().unwrap_or("");
                let ts = a["tailscale"].as_bool().unwrap_or(false);
                lines.push(format!("http://{addr}:{port}   ({})", if ts { "Tailscale" } else { name }));
            }
        }
    }
    if lines.is_empty() {
        lines.push("(no network address found)".into());
    }
    let password_line = if password.is_empty() || password == "change-me" {
        "No app password is set: anyone who can open this address can use Claude on this PC. Use Tailscale, or set REMOTE_PASSWORD in the settings file.".to_string()
    } else {
        format!("Password: {password}")
    };
    let text = format!(
        "Open one of these on your phone:\n\n{}\n\n{}\n\nOn the phone use \"Add to Home Screen\" to install it.\nSettings file: {}",
        lines.join("\n"),
        password_line,
        state.env_file.display()
    );
    app.dialog().message(text).title("Claude on your phone").kind(MessageDialogKind::Info).show(|_| {});
}

// Follows the server's notification stream and raises a system notification
// when the window is not in front: a permission to answer, or a finished turn.
fn spawn_notifier(app: AppHandle) {
    thread::spawn(move || loop {
        let Some(state) = app.try_state::<ServerState>() else {
            thread::sleep(Duration::from_secs(1));
            continue;
        };
        let url = format!("http://127.0.0.1:{}/api/notify?token={}", state.port, state.token);
        match ureq::get(&url).call() {
            Ok(resp) => {
                let reader = BufReader::new(resp.into_reader());
                for line in reader.lines() {
                    let Ok(line) = line else { break };
                    let Some(json) = line.strip_prefix("data: ") else { continue };
                    let Ok(ev) = serde_json::from_str::<serde_json::Value>(json) else { continue };
                    let focused = app.get_webview_window("main").map(|w| w.is_focused().unwrap_or(false) && w.is_visible().unwrap_or(false)).unwrap_or(false);
                    if focused {
                        continue;
                    }
                    let (title, body) = match ev["t"].as_str() {
                        Some("permission") => (
                            format!("Claude wants to use {}", ev["tool"].as_str().unwrap_or("a tool")),
                            ev["summary"].as_str().unwrap_or("Open the app to review").to_string(),
                        ),
                        Some("turn_done") => (
                            if ev["isError"].as_bool().unwrap_or(false) { "Claude hit an error".to_string() } else { "Claude finished".to_string() },
                            ev["text"].as_str().unwrap_or("Open the app to read the answer").to_string(),
                        ),
                        _ => continue,
                    };
                    let _ = app.notification().builder().title(title).body(body).show();
                }
            }
            Err(_) => thread::sleep(Duration::from_secs(3)),
        }
    });
}
