// claude-remote — a small self-hosted bridge between the Claude Agent SDK and a
// Claude-styled web client, so local Claude Code sessions can be listed,
// continued and started from another device. Everything runs on this machine;
// the browser only ever talks to this process.
//
// Nothing here touches ~/.claude/settings.json or the Claude Desktop app. The
// SDK reads the same session transcripts Claude Code writes.
//
// By default it listens on localhost only. To reach it from a phone, expose it
// through Tailscale (`tailscale serve 7777`) or set HOST=0.0.0.0 in .env for
// your own LAN. It is protected by the shared password in .env.

import express from 'express';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listSessions, getSessionMessages, getSessionInfo } from '@anthropic-ai/claude-agent-sdk';
import { runs, pendingPermissions, isLive, startRun, answerPermission, bus } from './lib/runs.mjs';
import { tailSession, isWorkingElsewhere, WORKING_WINDOW_MS } from './lib/tail.mjs';
import { getAuth, activeAccount, setActive, setToken, clearToken, classifyToken, envFor, localSource, verifyEnv, candidateEnv } from './lib/auth.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

// ---------- config (.env is optional; real env vars win) ----------
function loadDotEnv() {
  const p = process.env.CLAUDE_REMOTE_ENV_FILE || path.join(here, '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}
loadDotEnv();

const PORT = Number(process.env.PORT || 7777);
const HOST = process.env.HOST || '127.0.0.1';
// An app password is optional (REMOTE_PASSWORD in .env). Without one, anybody who
// can reach the port can use Claude on this PC, so keep the server on localhost,
// Tailscale, or a network you trust.
const PASSWORD = (process.env.REMOTE_PASSWORD || '').trim() === 'change-me' ? '' : (process.env.REMOTE_PASSWORD || '').trim();
const PASSWORD_REQUIRED = PASSWORD.length > 0;
const USER_NAME = process.env.USER_NAME || 'there';
const TOKEN = createHash('sha256').update('claude-remote:' + (PASSWORD || 'open')).digest('hex');

// ---------- http ----------
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '60mb' })); // attachments travel as base64

// Attachments: images are sent to Claude as image blocks; any other file is saved on
// this PC and referenced from the prompt by path, the way Remote Control does it.
const UPLOAD_DIR = path.join(os.tmpdir(), 'claude-remote-uploads');
function parseAttachments(body) {
  const images = (Array.isArray(body?.attachments) ? body.attachments : [])
    .filter((a) => a && typeof a.data === 'string' && /^image\/(png|jpeg|webp|gif)$/.test(a.media_type || ''))
    .slice(0, 10)
    .map((a) => ({ media_type: a.media_type, data: a.data }));
  const paths = [];
  for (const f of (Array.isArray(body?.files) ? body.files : []).slice(0, 10)) {
    if (!f || typeof f.data !== 'string') continue;
    const safe = String(f.name || 'file').replace(/[^\w.\- ()]/g, '_').slice(0, 120);
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    const p = path.join(UPLOAD_DIR, `${Date.now().toString(36)}-${safe}`);
    fs.writeFileSync(p, Buffer.from(f.data, 'base64'));
    paths.push(p);
  }
  let text = String(body?.text || '').trim();
  if (paths.length) text += (text ? '\n\n' : '') + 'Attached file' + (paths.length > 1 ? 's' : '') + ':\n' + paths.map((p) => '- ' + p).join('\n');
  return { text, images };
}

app.use('/vendor/marked.js', express.static(path.join(here, 'node_modules/marked/lib/marked.umd.js')));
app.use('/vendor/purify.js', express.static(path.join(here, 'node_modules/dompurify/dist/purify.min.js')));
app.use(express.static(path.join(here, 'public'), { extensions: ['html'] }));

app.get('/api/config', (_req, res) => res.json({ passwordRequired: PASSWORD_REQUIRED, userName: USER_NAME }));

// Sign in. With no app password configured this simply hands out the session token.
app.post('/api/login', (req, res) => {
  if (PASSWORD_REQUIRED && (typeof req.body?.password !== 'string' || req.body.password !== PASSWORD)) return res.status(401).json({ error: 'Wrong password' });
  res.json({ token: TOKEN, userName: USER_NAME });
});

app.use('/api', (req, res, next) => {
  const auth = req.get('authorization') || '';
  // EventSource cannot send headers, so the live-events stream may carry the token in the query string.
  const viaQuery = req.method === 'GET' && (/^\/sessions\/[0-9a-f-]+\/events$/i.test(req.path) || req.path === '/notify') && req.query.token === TOKEN;
  if (auth !== 'Bearer ' + TOKEN && !viaQuery) return res.status(401).json({ error: 'Unauthorized' });
  next();
});

// ---------- small preferences file: pinned sessions (shared by every device) ----------
const DATA_DIR = process.env.CLAUDE_REMOTE_DATA_DIR || path.join(here, 'data');
const PREFS_PATH = path.join(DATA_DIR, 'prefs.json');
function readPrefs() {
  try { return { pinned: [], ...JSON.parse(fs.readFileSync(PREFS_PATH, 'utf8')) }; } catch { return { pinned: [] }; }
}
function writePrefs(p) {
  fs.mkdirSync(path.dirname(PREFS_PATH), { recursive: true });
  fs.writeFileSync(PREFS_PATH, JSON.stringify(p, null, 2));
}

// Who a given account ('local' = this computer's `claude login`, 'token' = the pasted
// token) is, as reported by the CLI itself. Nothing secret leaves this function.
const whoCache = new Map(); // which -> { at, value }
function whoAmI(which = activeAccount()) {
  const hit = whoCache.get(which);
  if (hit && Date.now() - hit.at < 60000) return hit.value;
  const cli = process.env.CLAUDE_REMOTE_CLI || 'claude';
  try {
    const raw = execFileSync(cli, ['auth', 'status', '--json'], { encoding: 'utf8', timeout: 15000, windowsHide: true, env: envFor(which) });
    const j = JSON.parse(raw);
    const a = getAuth();
    const value = {
      which,
      email: j.email || '', name: '', org: j.orgName || '', plan: j.subscriptionType || '',
      auth: j.authMethod || (j.loggedIn ? 'unknown' : 'none'), loggedIn: !!j.loggedIn,
      source: which === 'token' ? 'token entered in the app' : localSource(), tokenKind: which === 'token' ? a.tokenKind : '',
      projectsDir: j.projectsDirectory || '',
    };
    whoCache.set(which, { at: Date.now(), value });
    return value;
  } catch {}
  return which === 'local' ? whoAmIFromFiles() : { which, email: '', plan: '', auth: 'oauth_token', loggedIn: true, source: 'token entered in the app', tokenKind: getAuth().tokenKind };
}
function whoAmIFromFiles() {
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const out = { which: 'local', email: '', name: '', org: '', plan: '', source: localSource(), tokenKind: '' };
  try {
    const j = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8'));
    const a = j.oauthAccount || {};
    out.email = a.emailAddress || ''; out.name = a.displayName || a.fullName || ''; out.org = a.organizationName || '';
    out.plan = a.organizationType ? a.organizationType.replace(/^claude_/, '') : '';
  } catch {}
  try {
    const c = JSON.parse(fs.readFileSync(path.join(dir, '.credentials.json'), 'utf8'));
    if (c.claudeAiOauth?.subscriptionType) out.plan = c.claudeAiOauth.subscriptionType;
    out.auth = c.claudeAiOauth ? 'claude.ai' : 'api-key';
  } catch { out.auth = process.env.ANTHROPIC_API_KEY ? 'api-key' : 'unknown'; }
  return out;
}

const shape = (s, pinned) => ({
  id: s.sessionId,
  title: s.customTitle || s.summary || s.firstPrompt || 'Untitled',
  cwd: s.cwd || '',
  project: s.cwd ? path.basename(s.cwd) : '',
  branch: s.gitBranch || '',
  lastModified: s.lastModified,
  createdAt: s.createdAt,
  live: isLive(s.sessionId),
  runStartedAt: isLive(s.sessionId) ? runs.get(s.sessionId).startedAt : null,
  working: isLive(s.sessionId) || Date.now() - s.lastModified < WORKING_WINDOW_MS,
  pinned: !!pinned?.has(s.sessionId),
});

app.get('/api/me', (_req, res) => res.json({ userName: USER_NAME, host: process.env.COMPUTERNAME || process.env.HOSTNAME || 'this machine', account: whoAmI(), active: activeAccount(), hasToken: getAuth().hasToken }));

// ---------- accounts: this computer's login, and an optional token; switch any time ----------
app.get('/api/accounts', (_req, res) => {
  const a = getAuth();
  res.json({ active: activeAccount(), local: whoAmI('local'), token: a.hasToken ? whoAmI('token') : null });
});
app.post('/api/accounts/active', (req, res) => {
  const which = req.body?.which === 'token' ? 'token' : 'local';
  if (which === 'token' && !getAuth().hasToken) return res.status(400).json({ error: 'No token has been added yet.' });
  res.json({ active: setActive(which) });
});
// Add or replace the token; it is proven with one tiny request before it is kept.
app.post('/api/accounts/token', async (req, res) => {
  const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
  const kind = classifyToken(token);
  if (!kind) return res.status(400).json({ error: 'Paste a token first.' });
  const check = await verifyEnv(candidateEnv(token, kind));
  if (!check.ok) return res.status(400).json({ error: 'Claude rejected that token: ' + check.error });
  setToken(token, kind);
  whoCache.delete('token');
  res.json({ active: 'token', token: whoAmI('token') });
});
app.delete('/api/accounts/token', (_req, res) => { clearToken(); whoCache.delete('token'); res.json({ active: 'local' }); });

app.post('/api/sessions/:id/pin', (req, res) => {
  const p = readPrefs();
  const set = new Set(p.pinned);
  if (req.body?.pinned) set.add(req.params.id); else set.delete(req.params.id);
  p.pinned = [...set]; writePrefs(p);
  res.json({ pinned: set.has(req.params.id) });
});

app.get('/api/sessions', async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const offset = Number(req.query.offset) || 0;
    const pinned = new Set(readPrefs().pinned);
    res.json((await listSessions({ limit, offset })).map((s) => shape(s, pinned)));
  } catch (e) { next(e); }
});

app.get('/api/projects', async (_req, res, next) => {
  try {
    const seen = new Map();
    for (const s of await listSessions({ limit: 500 })) if (s.cwd && !seen.has(s.cwd)) seen.set(s.cwd, { cwd: s.cwd, name: path.basename(s.cwd), lastModified: s.lastModified });
    res.json([...seen.values()].sort((a, b) => b.lastModified - a.lastModified));
  } catch (e) { next(e); }
});

app.get('/api/sessions/:id', async (req, res, next) => {
  try {
    const s = await getSessionInfo(req.params.id);
    if (!s) return res.status(404).json({ error: 'Not found' });
    res.json(shape(s, new Set(readPrefs().pinned)));
  } catch (e) { next(e); }
});

app.get('/api/sessions/:id/messages', async (req, res, next) => {
  try {
    const out = [];
    // `before` (ms): leave out lines written by a turn that is still running here,
    // because the live stream will replay that turn from its start.
    const before = Number(req.query.before) || 0;
    for (const m of await getSessionMessages(req.params.id)) {
      if (m.parent_tool_use_id) continue; // subagent traffic
      if (before && m.timestamp && Date.parse(m.timestamp) >= before - 1500) continue;
      const c = m.message?.content;
      const content = Array.isArray(c) ? c : [{ type: 'text', text: String(c ?? '') }];
      out.push({ role: m.type, uuid: m.uuid, timestamp: m.timestamp, content });
    }
    res.json(out);
  } catch (e) { next(e); }
});

app.post('/api/sessions/:id/send', async (req, res, next) => {
  try {
    const id = req.params.id;
    const { text: prompt, images } = parseAttachments(req.body);
    if (!prompt && !images.length) return res.status(400).json({ error: 'Empty message' });
    // Claude is mid-turn here: hand the message over, it runs right after (Desktop behaviour).
    if (isLive(id)) { const qid = runs.get(id).enqueue(prompt, images); if (qid) return res.json({ queued: true, id: qid, sessionId: id }); }
    const info = await getSessionInfo(id);
    if (!info) return res.status(404).json({ error: 'Session not found' });
    const { model, permissionMode, effort } = req.body || {};
    const { run } = startRun({ sessionId: id, cwd: info.cwd, prompt, images, model, permissionMode, effort });
    res.json({ runId: run.id, sessionId: id });
  } catch (e) { next(e); }
});

// Change permission mode / model / effort while Claude is working; takes effect
// for the next tool call or model request.
app.post('/api/sessions/:id/controls', async (req, res, next) => {
  try {
    const run = runs.get(req.params.id);
    if (!run || run.done) return res.json({ applied: {}, live: false });
    const { permissionMode, model, effort } = req.body || {};
    res.json({ applied: await run.setControls({ permissionMode, model, effort }), live: true });
  } catch (e) { next(e); }
});

app.post('/api/sessions', async (req, res) => {
  const { text: prompt, images } = parseAttachments(req.body);
  const cwd = String(req.body?.cwd || '').trim();
  if (!prompt && !images.length) return res.status(400).json({ error: 'Empty message' });
  if (!cwd || !fs.existsSync(cwd)) return res.status(400).json({ error: 'Pick a folder that exists on this machine.' });
  const { model, permissionMode, effort } = req.body || {};
  const { run, ready } = startRun({ cwd, prompt, images, model, permissionMode, effort });
  try {
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('Claude Code did not start in time')), 60000));
    const sessionId = await Promise.race([ready, timeout]);
    res.json({ runId: run.id, sessionId });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.post('/api/sessions/:id/stop', (req, res) => {
  const run = runs.get(req.params.id);
  if (run && !run.done) run.stop();
  res.json({ ok: true });
});

// Server-sent events for one session. While a turn started here is running,
// it streams that turn (replaying what the client missed via Last-Event-ID).
// Otherwise it follows the transcript file, so work done in VS Code, a
// terminal or Claude Desktop shows up here as it happens.
app.get('/api/sessions/:id/events', (req, res) => {
  const id = req.params.id;
  const run = runs.get(id);
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  const ping = setInterval(() => res.write(': ping\n\n'), 20000);
  if (run && !run.done) {
    const since = Number(req.get('last-event-id') ?? req.query.since ?? -1);
    for (const ev of run.events) if (ev.i > since) res.write(`id: ${ev.i}\ndata: ${JSON.stringify(ev)}\n\n`);
    run.listeners.add(res);
    req.on('close', () => { clearInterval(ping); run.listeners.delete(res); });
    return;
  }
  // A turn that just finished here also touched the file; that is not "another window".
  const quietUntil = run?.finishedAt || 0;
  res.write(`data: ${JSON.stringify({ t: 'tail', working: isWorkingElsewhere(id, quietUntil) })}\n\n`);
  const stop = tailSession(id, (ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`), { quietUntil });
  req.on('close', () => { clearInterval(ping); if (stop) stop(); });
});

app.post('/api/permissions/:reqId', (req, res) => {
  const { behavior, always } = req.body || {};
  if (!answerPermission(req.params.reqId, behavior, !!always)) return res.status(404).json({ error: 'No such request (it may have expired).' });
  res.json({ ok: true });
});

// Notification stream for the desktop shell: permission requests and finished turns.
app.get('/api/notify', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const send = (t) => (payload) => res.write(`data: ${JSON.stringify({ t, ...payload })}\n\n`);
  const onPerm = send('permission'), onDone = send('turn_done');
  bus.on('permission', onPerm); bus.on('turn_done', onDone);
  const ping = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => { clearInterval(ping); bus.off('permission', onPerm); bus.off('turn_done', onDone); });
});

// LAN / Tailscale addresses of this PC, for the "Phone connection" dialog.
app.get('/api/addresses', (_req, res) => {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) if (a.family === 'IPv4' && !a.internal) out.push({ name, address: a.address, tailscale: /tailscale/i.test(name) || a.address.startsWith('100.') });
  }
  res.json(out.sort((a, b) => Number(b.tailscale) - Number(a.tailscale)));
});

app.get('/api/runs', (_req, res) => {
  res.json([...runs.values()].filter((r) => !r.done).map((r) => ({ sessionId: r.sessionId, startedAt: r.startedAt, waiting: [...pendingPermissions.values()].some((p) => p.run === r) })));
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: String(err?.message || err) });
});

export { TOKEN, PASSWORD, PASSWORD_REQUIRED, HOST, PORT, bus };
export function startServer({ host = HOST, port = PORT } = {}) {
  return new Promise((resolve) => {
    const server = app.listen(port, host, () => {
      console.log(`claude-remote listening on http://${host}:${port}`);
      resolve({ server, url: `http://${host}:${port}` });
    });
  });
}

// Run directly (`node server.mjs`): listen. When imported as a module, the importer calls startServer().
const isMain = process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === path.resolve(fileURLToPath(import.meta.url)).toLowerCase();
console.log(`[claude-remote] node ${process.version} argv1=${process.argv[1]} main=${isMain} cwd=${process.cwd()}`);
if (isMain) startServer();

// Started by the desktop app: leave when it leaves, even if it was killed.
const parentPid = Number(process.env.CLAUDE_REMOTE_PARENT_PID);
if (parentPid) setInterval(() => { try { process.kill(parentPid, 0); } catch { console.log('[claude-remote] desktop app is gone, exiting'); process.exit(0); } }, 2000).unref();
