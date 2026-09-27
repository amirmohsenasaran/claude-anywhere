// What the Browser tests stand on: a dev server with everything the old /preview/<port>/
// proxy got wrong, a project folder Claude might have written into, a session whose answer
// links to it, and the app itself, started on its own data so nothing real is touched.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function freePort() {
  return new Promise((resolve, reject) => {
    const s = http.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

// A router that reads location.pathname, CSS at an absolute path, a sign-in cookie with
// Domain=localhost; Secure; SameSite=None, a redirect to http://localhost:<port>/..., and a
// hot-reload socket whose first message rides in the same write as its 101 - the way a busy
// dev server sends it, and the way the old proxy lost it.
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Test app</title><link rel="stylesheet" href="/assets/app.css"></head>
<body><nav><a href="/" data-link id="to-home">Home</a> · <a href="/about" data-link id="to-about">About</a> · <a href="/go" id="to-go">Redirect</a> · <button id="sign-in" onclick="signIn()">Sign in</button></nav>
<h1 id="page"></h1><p id="login">…</p><p id="ws">socket: connecting</p><p id="token"></p>
<script type="module" src="/assets/app.js"></script></body></html>`;
const SCRIPT = `const routes = { '/': 'Home', '/about': 'About page' };
function render() { const t = routes[location.pathname]; document.getElementById('page').textContent = t || 'Not found: ' + location.pathname; document.title = 'Test app · ' + (t || '404'); }
document.addEventListener('click', (e) => { const a = e.target.closest('a[data-link]'); if (!a) return; e.preventDefault(); history.pushState({}, '', a.getAttribute('href')); render(); });
addEventListener('popstate', render);
render();
fetch('/api/me').then((r) => r.json()).then((j) => { document.getElementById('login').textContent = j.user ? 'Signed in as ' + j.user : 'Signed out'; });
window.signIn = () => fetch('/api/login', { method: 'POST' }).then(() => location.reload());
let seen = 'none'; try { const t = localStorage.getItem('cr.token'); seen = t ? t.slice(0, 8) + '… (the app\\'s sign-in token)' : 'none'; } catch (e) { seen = 'blocked'; }
document.getElementById('token').textContent = 'app token visible here: ' + seen + ' · cookies: ' + (document.cookie || '(none)');
const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/hmr');
ws.onmessage = (e) => { document.getElementById('ws').textContent = 'socket: ' + e.data; };
ws.onerror = () => { document.getElementById('ws').textContent = 'socket: error'; };`;
const frame = (text) => { const b = Buffer.from(text); return Buffer.concat([Buffer.from([0x81, b.length]), b]); };

export function startDevServer(port = 0) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/assets/app.css') { res.writeHead(200, { 'content-type': 'text/css' }); return res.end('body{font:15px system-ui;background:#eef3ff;margin:16px} h1{color:rgb(10,120,10)}'); }
    if (url.pathname === '/assets/app.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(SCRIPT); }
    if (url.pathname === '/api/me') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ user: /(?:^|;\s*)sess=ok/.test(req.headers.cookie || '') ? 'arya' : null })); }
    // What the dev server was actually asked: the tests read the path, host, origin and cookies here.
    if (url.pathname === '/api/echo') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ url: req.url, host: req.headers.host, origin: req.headers.origin || null, cookie: req.headers.cookie || '' })); }
    if (url.pathname === '/api/login' && req.method === 'POST') { res.writeHead(200, { 'set-cookie': 'sess=ok; Path=/; Domain=localhost; HttpOnly; SameSite=None; Secure', 'content-type': 'application/json' }); return res.end('{"ok":true}'); }
    if (url.pathname === '/go') { res.writeHead(302, { location: `http://localhost:${server.address().port}/about` }); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'x-frame-options': 'DENY', 'content-security-policy': "frame-ancestors 'none'" });
    res.end(PAGE);
  });
  // Upgraded sockets are no longer the HTTP server's to close, and close() waits for them.
  const sockets = new Set();
  server.on('upgrade', (req, socket) => {
    if (!req.url.startsWith('/hmr')) return socket.destroy();
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.on('error', () => {});
    socket.write(Buffer.concat([Buffer.from(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`), frame('live')]));
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ port: server.address().port, close: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.closeAllConnections?.(); server.close(() => r()); }) })));
}

// Two pages, by hand: objects, then a cross-reference table with their byte offsets.
function pdf(pages) {
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${pages.map((_, i) => `${3 + i * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`];
  pages.forEach((text, i) => {
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${4 + i * 2} 0 R /Resources << /Font << /F1 ${3 + pages.length * 2} 0 R >> >> >>`);
    const stream = `BT /F1 28 Tf 72 700 Td (${text}) Tj ET`;
    objs.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  let out = '%PDF-1.4\n'; const offs = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  return out + `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
}

// A page with its own CSS, script (which keeps a count in localStorage) and picture, a
// second page it links to, and a two-page PDF.
export function makeProject(dir) {
  const site = path.join(dir, 'site');
  fs.mkdirSync(site, { recursive: true });
  fs.writeFileSync(path.join(site, 'index.html'), `<!doctype html><html><head><meta charset="utf-8"><title>Quarterly report</title><link rel="stylesheet" href="style.css"></head>
<body><h1 id="h">Quarterly report</h1><img id="img" src="chart.svg" width="160" height="96" alt="chart"><p id="count"></p><p><a id="next" href="page2.html">Next page</a></p><script src="app.js"></script></body></html>`);
  fs.writeFileSync(path.join(site, 'page2.html'), `<!doctype html><html><head><meta charset="utf-8"><title>Page two</title><link rel="stylesheet" href="style.css"></head><body><h1>Second page</h1><a id="back" href="index.html">Back to the report</a></body></html>`);
  fs.writeFileSync(path.join(site, 'style.css'), 'body{font:15px system-ui;margin:20px} h1{color:rgb(200,30,30)}');
  fs.writeFileSync(path.join(site, 'app.js'), `var n = 0; try { n = Number(localStorage.getItem('visits') || 0) + 1; localStorage.setItem('visits', n); document.getElementById('count').textContent = 'Visits: ' + n; } catch (e) { document.getElementById('count').textContent = 'Storage: ' + e.name; }`);
  fs.writeFileSync(path.join(site, 'chart.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="96" viewBox="0 0 160 96"><rect width="160" height="96" rx="10" fill="#f4efe6"/><rect x="20" y="52" width="24" height="30" fill="#d97757"/><rect x="56" y="36" width="24" height="46" fill="#d97757"/><rect x="92" y="22" width="24" height="60" fill="#d97757"/><rect x="128" y="12" width="14" height="70" fill="#b85c3e"/></svg>');
  fs.writeFileSync(path.join(site, 'report.pdf'), pdf(['Page one of the report', 'Page two of the report']), 'latin1');
  return { dir, site };
}

// A session in that project whose answer links to the page by a relative path and to the
// PDF by an absolute one, as Claude writes both. Claude Code keeps a project's transcripts
// in a folder named after its path, every other character turned into a dash.
export function makeSession(configDir, cwd, id = 'cccccccc-1111-2222-3333-444444444444') {
  const dir = path.join(configDir, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  const at = (s) => new Date(Date.now() - s * 1000).toISOString();
  const lines = [
    { type: 'user', uuid: id + '-u', timestamp: at(60), cwd, customTitle: 'Report and PDF', message: { role: 'user', content: [{ type: 'text', text: 'Make me a small report page and a PDF of it.' }] } },
    { type: 'assistant', uuid: id + '-a', timestamp: at(55), cwd, message: { role: 'assistant', model: 'claude-haiku-4-5-20251001', content: [{ type: 'text', text: `Done. The page is [site/index.html](site/index.html) and the PDF is [report.pdf](${path.join(cwd, 'site', 'report.pdf')}).` }] } },
  ];
  const file = path.join(dir, id + '.jsonl');
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  // A transcript written this second reads as "working in another window" to the app.
  const then = new Date(Date.now() - 10 * 60 * 1000); fs.utimesSync(file, then, then);
  return id;
}

// The app, on its own port and data, with no app password: this computer only, and the
// open token for whoever signs in from it.
export async function startApp({ port, dataDir, configDir }) {
  const env = { ...process.env, PORT: String(port), HOST: '127.0.0.1', CLAUDE_ANYWHERE_DATA_DIR: dataDir, CLAUDE_CONFIG_DIR: configDir };
  delete env.REMOTE_PASSWORD; delete env.CLAUDE_ANYWHERE_REMOTE_PASSWORD;
  const child = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(base + '/api/config'); if (r.ok) break; } catch {}
    if (child.exitCode !== null) throw new Error('the app exited:\n' + log);
    await new Promise((r) => setTimeout(r, 150));
  }
  const { token } = await (await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: '' }) })).json();
  return { base, token, log: () => log, stop: () => new Promise((r) => { if (child.exitCode !== null) return r(); child.once('exit', () => r()); child.kill(); }) };
}
