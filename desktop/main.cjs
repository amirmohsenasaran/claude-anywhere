// Claude Remote — desktop shell. Runs the same server in-process, opens it in
// its own window, lives in the tray, starts with Windows if asked, and turns
// permission requests / finished turns into system notifications. The phone
// keeps talking to the same server (see the tray menu for the address).

const { app, BrowserWindow, Tray, Menu, Notification, nativeImage, shell, clipboard, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');

const isPackaged = app.isPackaged;
const root = isPackaged ? path.join(process.resourcesPath, 'app') : path.join(__dirname, '..');
const userData = app.getPath('userData');

// (Children spawned by the Agent SDK get ELECTRON_RUN_AS_NODE from lib/auth.mjs.)
// Writable state lives in the user's profile, never inside the install folder.
process.env.CLAUDE_REMOTE_DATA_DIR = path.join(userData, 'data');
process.env.CLAUDE_REMOTE_ENV_FILE = path.join(userData, '.env');
if (!process.env.HOST) process.env.HOST = '0.0.0.0'; // the whole point of the desktop app is the phone reaching it

function ensureEnvFile() {
  const p = process.env.CLAUDE_REMOTE_ENV_FILE;
  if (fs.existsSync(p)) return;
  const dev = path.join(root, '.env');
  if (fs.existsSync(dev)) { fs.copyFileSync(dev, p); return; }
  const password = crypto.randomBytes(6).toString('base64url');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `REMOTE_PASSWORD=${password}\nHOST=0.0.0.0\nPORT=7777\nUSER_NAME=${os.userInfo().username}\n`);
}

function lanAddresses() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) if (a.family === 'IPv4' && !a.internal) out.push({ name, address: a.address, tailscale: /tailscale/i.test(name) || a.address.startsWith('100.') });
  }
  return out.sort((a, b) => Number(b.tailscale) - Number(a.tailscale));
}

let win = null, tray = null, server = null;

if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });

async function main() {
  ensureEnvFile();
  server = await import(path.join(root, 'server.mjs').replace(/\\/g, '/').replace(/^([A-Za-z]):/, 'file:///$1:'));
  const { url } = await server.startServer();
  const localUrl = `http://127.0.0.1:${server.PORT}`;

  const icon = nativeImage.createFromPath(path.join(root, 'build', 'icon.png'));
  win = new BrowserWindow({
    width: 1200, height: 820, minWidth: 380, minHeight: 600,
    title: 'Claude', icon, backgroundColor: '#F9F8F4', autoHideMenuBar: true, show: false,
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  win.once('ready-to-show', () => win.show());
  win.loadURL(`${localUrl}/?auto=${server.TOKEN}`);
  win.webContents.setWindowOpenHandler(({ url: u }) => { shell.openExternal(u); return { action: 'deny' }; });
  win.on('close', (e) => { if (!app.quitting) { e.preventDefault(); win.hide(); } });

  tray = new Tray(icon.resize({ width: 16, height: 16 }));
  tray.setToolTip('Claude Remote');
  const buildMenu = () => Menu.buildFromTemplate([
    { label: 'Open Claude', click: () => { win.show(); win.focus(); } },
    { type: 'separator' },
    { label: 'Phone connection…', click: showConnectionInfo },
    { label: 'Start with Windows', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin, click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked, args: ['--hidden'] }) },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.quitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(buildMenu());
  tray.on('click', () => { win.show(); win.focus(); });

  function showConnectionInfo() {
    const env = fs.readFileSync(process.env.CLAUDE_REMOTE_ENV_FILE, 'utf8');
    const password = (env.match(/^REMOTE_PASSWORD=(.*)$/m) || [])[1] || '';
    const addrs = lanAddresses();
    const lines = addrs.map((a) => `http://${a.address}:${server.PORT}${a.tailscale ? '  (Tailscale)' : '  (' + a.name + ')'}`);
    const text = `Open one of these on your phone:\n\n${lines.join('\n') || '(no network address found)'}\n\nPassword: ${password}\n\nOn the phone, use "Add to Home Screen" to install it. Settings file: ${process.env.CLAUDE_REMOTE_ENV_FILE}`;
    dialog.showMessageBox(win, { type: 'info', title: 'Phone connection', message: 'Claude on your phone', detail: text, buttons: ['Copy', 'Close'], defaultId: 1 })
      .then(({ response }) => { if (response === 0) clipboard.writeText(`${lines[0] || ''}\nPassword: ${password}`); });
  }

  // Notifications, like the Desktop app: a permission to answer, or a turn that finished while you were away.
  const notify = (title, body, sessionId) => {
    if (!Notification.isSupported() || (win.isVisible() && win.isFocused())) return;
    const n = new Notification({ title, body, icon });
    n.on('click', () => { win.show(); win.focus(); if (sessionId) win.webContents.executeJavaScript(`location.hash = '#/s/${sessionId}'`).catch(() => {}); });
    n.show();
  };
  server.bus.on('permission', ({ sessionId, tool, summary }) => notify(`Claude wants to use ${tool}`, summary || 'Tap to review', sessionId));
  server.bus.on('turn_done', ({ sessionId, text, isError }) => notify(isError ? 'Claude hit an error' : 'Claude finished', text || 'Tap to open the chat', sessionId));

  if (process.env.CR_SHOT) { // used by the automated check: save a screenshot and quit
    win.once('ready-to-show', () => setTimeout(async () => {
      const img = await win.webContents.capturePage();
      fs.writeFileSync(process.env.CR_SHOT, img.toPNG());
      app.quitting = true; app.quit();
    }, 2500));
  }
}

app.whenReady().then(main).catch((e) => { dialog.showErrorBox('Claude Remote could not start', String(e?.stack || e)); app.quit(); });
app.on('window-all-closed', () => { /* stay in the tray */ });
app.on('before-quit', () => { app.quitting = true; });
