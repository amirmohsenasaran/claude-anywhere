// The preview: whatever the project's dev server is serving, shown inside the
// app — and therefore on your phone, which cannot reach the PC's localhost by
// itself. Everything goes through this proxy on the app's own origin, so the
// page's relative URLs, its absolute ones, and its hot-reload socket all keep
// working, and the browser is willing to put it in a frame.
//
// Claude Desktop calls the same idea a preview pane, and refuses anything that
// is not localhost. So do we: this proxy is a window onto processes already
// running on this machine, never a way to fetch the internet through it.

import http from 'node:http';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

export const PREVIEW_PREFIX = '/preview/';
const okPort = (p) => Number.isInteger(p) && p > 0 && p < 65536;

// Headers that belong to one hop and must not be forwarded.
const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
// Frame-busting and CSP would stop the page appearing in the panel at all.
const DROP_BACK = new Set(['x-frame-options', 'content-security-policy', 'content-security-policy-report-only', 'cross-origin-opener-policy', 'cross-origin-embedder-policy']);

/** `/preview/5173/some/path?q` -> { port: 5173, rest: '/some/path?q' } */
export function parsePreviewUrl(url) {
  const m = /^\/preview\/(\d+)(\/[^\s]*)?$/.exec(url || '');
  if (!m) return null;
  const port = Number(m[1]);
  return okPort(port) ? { port, rest: m[2] || '/' } : null;
}

// A page loaded at /preview/5173/ asks for /assets/app.js — an absolute path on
// our origin. The referer says which preview it came from, so it can still be
// answered from the right dev server.
export function portFromReferer(referer) {
  try {
    const p = parsePreviewUrl(new URL(referer).pathname + '');
    return p ? p.port : null;
  } catch { return null; }
}

/** Pipe one request through to 127.0.0.1:port and back. */
export function proxyRequest(req, res, port, rest) {
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (HOP.has(k) || k === 'host' || k === 'cookie') continue; // our cookie is ours, not the dev server's
    headers[k] = v;
  }
  headers.host = '127.0.0.1:' + port;
  // Dev servers check this to decide whether a request is same-origin.
  if (headers.origin) headers.origin = 'http://127.0.0.1:' + port;
  if (headers.referer) headers.referer = headers.referer.replace(/^https?:\/\/[^/]+\/preview\/\d+/, 'http://127.0.0.1:' + port);

  const up = http.request({ host: '127.0.0.1', port, path: rest, method: req.method, headers }, (r) => {
    const out = {};
    for (const [k, v] of Object.entries(r.headers)) {
      const lower = k.toLowerCase();
      if (HOP.has(lower) || DROP_BACK.has(lower)) continue;
      // A redirect to the dev server's own origin has to stay inside the panel.
      if (lower === 'location' && typeof v === 'string') { out[k] = rewriteLocation(v, port); continue; }
      out[k] = v;
    }
    res.writeHead(r.statusCode || 502, out);
    r.pipe(res);
  });
  up.on('error', (e) => {
    if (res.headersSent) return res.end();
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`Nothing is answering on port ${port} (${e.code || e.message}).\n\nStart the dev server, or pick another port.`);
  });
  req.pipe(up);
}

function rewriteLocation(loc, port) {
  if (loc.startsWith('/')) return PREVIEW_PREFIX + port + loc;
  try {
    const u = new URL(loc);
    if (u.hostname === '127.0.0.1' || u.hostname === 'localhost') return PREVIEW_PREFIX + (u.port || port) + u.pathname + u.search;
  } catch {}
  return loc;
}

/** Hot reload runs over a WebSocket; tunnel the upgrade straight through. */
export function proxyUpgrade(req, socket, head, port, rest) {
  const up = http.request({ host: '127.0.0.1', port, path: rest, method: 'GET', headers: { ...req.headers, host: '127.0.0.1:' + port } });
  up.end();
  up.on('upgrade', (upRes, upSocket, upHead) => {
    const lines = [`HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage}`];
    for (const [k, v] of Object.entries(upRes.headers)) lines.push(`${k}: ${v}`);
    socket.write(lines.join('\r\n') + '\r\n\r\n');
    if (upHead && upHead.length) socket.unshift(upHead);
    upSocket.pipe(socket);
    socket.pipe(upSocket);
    const bye = () => { try { upSocket.destroy(); } catch {} try { socket.destroy(); } catch {} };
    upSocket.on('error', bye); socket.on('error', bye);
    upSocket.on('close', bye); socket.on('close', bye);
  });
  up.on('response', () => socket.destroy());
  up.on('error', () => socket.destroy());
  if (head && head.length) socket.unshift(head);
}

// ---------- what is worth previewing ----------
// Every port something is listening on locally, with the process behind it, so
// the panel can offer "vite on 5173" instead of asking the person to remember.
const NAMES = { node: 'Node', 'node.exe': 'Node', python: 'Python', 'python.exe': 'Python', 'ruby.exe': 'Ruby', 'java.exe': 'Java', 'dotnet.exe': '.NET', 'caddy.exe': 'Caddy', 'nginx.exe': 'nginx', 'docker.exe': 'Docker', 'com.docker.backend.exe': 'Docker' };

export async function listLocalPorts({ self = 0 } = {}) {
  const rows = [];
  try {
    const { stdout } = await execFileP('netstat', ['-ano', '-p', 'TCP'], { timeout: 8000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
    const seen = new Map();
    for (const line of stdout.split('\n')) {
      const m = /^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/.exec(line);
      if (!m) continue;
      const [, host, portStr, pidStr] = m;
      if (!/^(127\.0\.0\.1|0\.0\.0\.0|\[::\]|\[::1\])$/.test(host)) continue;
      const port = Number(portStr);
      if (port === self || port < 80 || port > 65000) continue;
      if (!seen.has(port)) seen.set(port, Number(pidStr));
    }
    const pids = [...new Set(seen.values())];
    const names = await pidNames(pids);
    for (const [port, pid] of seen) rows.push({ port, pid, process: names.get(pid) || '', label: NAMES[(names.get(pid) || '').toLowerCase()] || names.get(pid) || '' });
  } catch {}
  // A dev server is far more likely to be high-numbered than 445 or 135.
  const dev = (p) => (p.port >= 3000 && p.port <= 9999 ? 0 : 1);
  return rows.sort((a, b) => dev(a) - dev(b) || a.port - b.port).slice(0, 60);
}

async function pidNames(pids) {
  const out = new Map();
  if (!pids.length) return out;
  try {
    const { stdout } = await execFileP('tasklist', ['/FO', 'CSV', '/NH'], { timeout: 8000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
    for (const line of stdout.split('\n')) {
      const m = /^"([^"]+)","(\d+)"/.exec(line.trim());
      if (m && pids.includes(Number(m[2]))) out.set(Number(m[2]), m[1]);
    }
  } catch {}
  return out;
}
