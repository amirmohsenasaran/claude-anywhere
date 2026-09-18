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

// A page served at /preview/5173/ that links to `/about` would navigate the frame to
// our own origin's /about. The referer rescues the first hop, but the page that lands
// there is no longer under the prefix, so the hop after it has nothing to go on and
// the frame fills with this app instead of the project.
//
// So every HTML page gets two things: a <base> so relative URLs resolve inside the
// prefix, and a small script that puts the prefix back on root-relative navigation.
// Sub-resources still ride on the referer, which now always names a preview.
const injection = (port) => `<base href="/preview/${port}/"><script>(function(){
var P='/preview/${port}';
function fix(u){return (typeof u==='string'&&u.charAt(0)==='/'&&u.indexOf(P+'/')!==0&&u!==P)?P+u:u;}
document.addEventListener('click',function(e){
  if(e.defaultPrevented||e.button!==0||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey)return;
  var a=e.target&&e.target.closest&&e.target.closest('a[href]');
  if(!a||a.target&&a.target!=='_self'||a.hasAttribute('download'))return;
  var h=a.getAttribute('href');
  if(h&&h.charAt(0)==='/'&&fix(h)!==h){e.preventDefault();location.href=fix(h);}
},true);
document.addEventListener('submit',function(e){
  var f=e.target;if(!f||!f.getAttribute)return;
  var a=f.getAttribute('action');if(a&&fix(a)!==a)f.setAttribute('action',fix(a));
},true);
var ps=history.pushState,rs=history.replaceState;
history.pushState=function(s,t,u){return ps.call(this,s,t,fix(u));};
history.replaceState=function(s,t,u){return rs.call(this,s,t,fix(u));};
// Hot reload opens a socket at a root-relative path of its own, which would arrive
// with no preview in it and be refused. Put the prefix back on the way out.
var W=window.WebSocket;
if(W){var S=function(u,p){
  try{var x=new URL(u,location.href);
    // A relative socket path resolves against the document, so it arrives as http:
    // here even though the browser will open it as ws:.
    var sec=(x.protocol==='https:'||x.protocol==='wss:');
    var isWs=(x.protocol==='ws:'||x.protocol==='wss:'||x.protocol==='http:'||x.protocol==='https:');
    if(isWs&&x.host===location.host&&x.pathname.indexOf(P+'/')!==0){
      u=(sec?'wss://':'ws://')+x.host+P+x.pathname+x.search;
    }
  }catch(e){}
  return arguments.length>1?new W(u,p):new W(u);};
S.prototype=W.prototype;S.CONNECTING=W.CONNECTING;S.OPEN=W.OPEN;S.CLOSING=W.CLOSING;S.CLOSED=W.CLOSED;
window.WebSocket=S;}
})();</script>`;

// Sub-resources ride on the referer — unless the page says not to send one. Mailpit
// does exactly that, and then `/dist/app.js` came back as this app's own index.html
// and the panel stayed blank. So the prefix is written into the markup as well, where
// nothing can strip it. Only attributes are touched: the pattern runs over matched
// tags, never over the text between them, so script bodies are left alone.
const URL_ATTR = /(\s(?:src|href|action|formaction|poster|data-src)\s*=\s*)("([^"]*)"|'([^']*)'|([^\s">]+))/gi;
const SRCSET_ATTR = /(\ssrcset\s*=\s*)("([^"]*)"|'([^']*)')/gi;
// `/x` belongs to the dev server; `//host/x` is another origin and is left to fail on its own.
const needsPrefix = (u, p) => typeof u === 'string' && u.startsWith('/') && !u.startsWith('//') && !u.startsWith(p + '/') && u !== p;

function rewriteHtmlUrls(html, port) {
  const p = PREVIEW_PREFIX.replace(/\/$/, '') + '/' + port;
  return html.replace(/<[a-zA-Z][^>]*>/g, (tag) => {
    if (/^<base\b/i.test(tag)) return tag;
    return tag
      .replace(URL_ATTR, (m, lead, raw, dq, sq, uq) => {
        const val = dq ?? sq ?? uq ?? '';
        if (!needsPrefix(val, p)) return m;
        const quote = dq !== undefined ? '"' : sq !== undefined ? "'" : '';
        return lead + quote + p + val + quote;
      })
      .replace(SRCSET_ATTR, (m, lead, raw, dq, sq) => {
        const val = dq ?? sq ?? '';
        const quote = dq !== undefined ? '"' : "'";
        const out = val.split(',').map((part) => {
          const t = part.trim();
          if (!t) return part;
          const [url, ...rest] = t.split(/\s+/);
          return (needsPrefix(url, p) ? p + url : url) + (rest.length ? ' ' + rest.join(' ') : '');
        }).join(', ');
        return lead + quote + out + quote;
      });
  });
}

function injectInto(html, port) {
  // A page that asks for no referer would break the fallback for anything built in JS.
  let out = html.replace(/<meta[^>]+name\s*=\s*["']?referrer["']?[^>]*>/gi, '');
  out = rewriteHtmlUrls(out, port);
  const tag = injection(port);
  const head = /<head[^>]*>/i.exec(out);
  if (head) return out.slice(0, head.index + head[0].length) + tag + out.slice(head.index + head[0].length);
  const htmlTag = /<html[^>]*>/i.exec(out);
  if (htmlTag) return out.slice(0, htmlTag.index + htmlTag[0].length) + tag + out.slice(htmlTag.index + htmlTag[0].length);
  return tag + out;
}

/** Pipe one request through to 127.0.0.1:port and back. */
export function proxyRequest(req, res, port, rest) {
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (HOP.has(k) || k === 'host' || k === 'cookie') continue; // our cookie is ours, not the dev server's
    headers[k] = v;
  }
  // Ask for plain text: the page is rewritten on the way back, and a local hop is not
  // where compression earns its keep.
  delete headers['accept-encoding'];
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
    // Only HTML is read and rewritten; everything else streams straight through.
    if (!/text\/html/i.test(String(r.headers['content-type'] || ''))) {
      res.writeHead(r.statusCode || 502, out);
      return r.pipe(res);
    }
    const chunks = [];
    let size = 0;
    r.on('data', (c) => { chunks.push(c); size += c.length; });
    r.on('end', () => {
      // A document big enough to be a download rather than a page goes through untouched.
      let body = Buffer.concat(chunks);
      if (size <= 8 * 1024 * 1024) body = Buffer.from(injectInto(body.toString('utf8'), port), 'utf8');
      delete out['content-length'];
      delete out['Content-Length'];
      // Whatever the page would have set, the referer still has to name the preview:
      // it is what answers anything the page builds a URL for at runtime.
      res.writeHead(r.statusCode || 502, { ...out, 'content-length': body.length, 'referrer-policy': 'same-origin' });
      res.end(body);
    });
    r.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
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
// A listening port is not a web server. A normal Windows machine has thirty of
// them — RPC, printer spooling, a keyboard's lighting daemon — and offering that
// list means the panel opens on a GPU monitor and the person has to guess.
//
// So every candidate is asked, once, whether it speaks HTTP, and only the ones
// that answer are offered. The page's own <title> comes back with it, which is a
// far better label than the name of the executable behind the socket.
const NAMES = { node: 'Node', 'node.exe': 'Node', python: 'Python', 'python.exe': 'Python', 'ruby.exe': 'Ruby', 'java.exe': 'Java', 'dotnet.exe': '.NET', 'caddy.exe': 'Caddy', 'nginx.exe': 'nginx', 'docker.exe': 'Docker', 'com.docker.backend.exe': 'Docker', bun: 'Bun', 'bun.exe': 'Bun', deno: 'Deno', 'deno.exe': 'Deno', 'php.exe': 'PHP', 'go.exe': 'Go' };

const titleOf = (html) => {
  const m = /<title[^>]*>([^<]{1,90})/i.exec(html || '');
  return m ? m[1].replace(/\s+/g, ' ').trim() : '';
};

/**
 * One GET to 127.0.0.1:port. Resolves { http, status, server, title } — `http` is
 * false for anything that is not an HTTP server, including one that never answers.
 */
function probeHttp(port, timeout = 700) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const req = http.request(
      { host: '127.0.0.1', port, path: '/', method: 'GET', timeout, headers: { host: '127.0.0.1:' + port, accept: 'text/html,*/*', 'user-agent': 'claude-anywhere-preview' } },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          body += c;
          if (body.length > 8192) { done({ http: true, status: res.statusCode, server: res.headers.server || '', title: titleOf(body) }); req.destroy(); }
        });
        const end = () => done({ http: true, status: res.statusCode, server: res.headers.server || '', title: titleOf(body) });
        res.on('end', end); res.on('close', end); res.on('aborted', end);
      },
    );
    req.on('error', () => done({ http: false }));
    req.on('timeout', () => { req.destroy(); done({ http: false }); });
    req.end();
  });
}

// Rescanning on every open would mean a second of netstat and thirty probes each time.
let portCache = { at: 0, value: [] };

export async function listLocalPorts({ self = 0, maxAge = 4000 } = {}) {
  if (Date.now() - portCache.at < maxAge) return portCache.value;
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
    const ports = [...seen.keys()];
    const probes = await Promise.all(ports.map((p) => probeHttp(p)));
    ports.forEach((port, i) => {
      const pid = seen.get(port);
      const proc = names.get(pid) || '';
      const r = probes[i];
      // Answering HTTP is not the same as having something to show: a printer service
      // that says 503, or a launcher that says 400, is not a page anyone wants framed.
      const serves = !!r.http && (r.status || 0) < 400;
      rows.push({
        port, pid, process: proc, label: NAMES[proc.toLowerCase()] || proc,
        http: !!r.http, status: r.status || 0, server: r.server || '', title: r.title || '',
        serves,
        // What a project's own dev server looks like: a development runtime, serving
        // something, on a port people actually use for it.
        dev: serves && DEV_RUNTIMES.has(proc.toLowerCase()) && port >= 1024,
      });
    });
  } catch {}
  const rank = (p) => (p.dev ? 0 : p.serves ? 1 : p.http ? 2 : 3);
  const inRange = (p) => (p.port >= 3000 && p.port <= 9999 ? 0 : 1);
  const value = rows.sort((a, b) => rank(a) - rank(b) || inRange(a) - inRange(b) || a.port - b.port).slice(0, 60);
  portCache = { at: Date.now(), value };
  return value;
}

// Something a project is served by, as opposed to something the machine came with.
const DEV_RUNTIMES = new Set(['node', 'node.exe', 'python', 'python.exe', 'python3', 'python3.exe', 'pythonw.exe', 'ruby', 'ruby.exe', 'java', 'java.exe', 'dotnet', 'dotnet.exe', 'bun', 'bun.exe', 'deno', 'deno.exe', 'php', 'php.exe', 'go', 'go.exe', 'caddy', 'caddy.exe', 'nginx', 'nginx.exe', 'docker', 'docker.exe', 'com.docker.backend.exe', 'rails', 'puma', 'gunicorn', 'uvicorn', 'flask', 'cargo', 'cargo.exe']);

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
