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
import { runs, pendingPermissions, isLive, startRun, answerPermission } from './lib/runs.mjs';
import { tailSession, isWorkingElsewhere, WORKING_WINDOW_MS } from './lib/tail.mjs';
import { getAuth, setAuth, classifyToken, authEnv, authSource, verifyEnv } from './lib/auth.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

// ---------- config (.env is optional; real env vars win) ----------
function loadDotEnv() {
  const p = path.join(here, '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}
loadDotEnv();

const PORT = Number(process.env.PORT || 7777);
const HOST = process.env.HOST || '127.0.0.1';
const PASSWORD = process.env.REMOTE_PASSWORD || '';
const USER_NAME = process.env.USER_NAME || 'there';
if (!PASSWORD || PASSWORD === 'change-me') {
  console.error('Set REMOTE_PASSWORD in .env before starting (copy .env.example).');
  process.exit(1);
}
const TOKEN = createHash('sha256').update('claude-remote:' + PASSWORD).digest('hex');

// ---------- http ----------
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));

app.use('/vendor/marked.js', express.static(path.join(here, 'node_modules/marked/lib/marked.umd.js')));
app.use('/vendor/purify.js', express.static(path.join(here, 'node_modules/dompurify/dist/purify.min.js')));
app.use(express.static(path.join(here, 'public'), { extensions: ['html'] }));

// Sign in with the shared password. Optionally hand over a Claude token to run
// on a different account than the machine's own `claude login`; it is proven
// with one tiny request before it is kept.
app.post('/api/login', async (req, res) => {
  if (typeof req.body?.password !== 'string' || req.body.password !== PASSWORD) return res.status(401).json({ error: 'Wrong password' });
  const claudeToken = typeof req.body.claudeToken === 'string' ? req.body.claudeToken.trim() : '';
  if (claudeToken) {
    const kind = classifyToken(claudeToken);
    const candidate = { ...process.env };
    delete candidate.CLAUDE_CODE_OAUTH_TOKEN; delete candidate.ANTHROPIC_API_KEY;
    candidate[kind === 'apikey' ? 'ANTHROPIC_API_KEY' : 'CLAUDE_CODE_OAUTH_TOKEN'] = claudeToken;
    const check = await verifyEnv(candidate);
    if (!check.ok) return res.status(400).json({ error: 'Claude rejected that token: ' + check.error });
    setAuth({ kind, token: claudeToken, since: Date.now() });
    whoCache = { at: 0, value: null };
  }
  res.json({ token: TOKEN, userName: USER_NAME });
});

app.use('/api', (req, res, next) => {
  const auth = req.get('authorization') || '';
  // EventSource cannot send headers, so the live-events stream may carry the token in the query string.
  const viaQuery = req.method === 'GET' && /^\/sessions\/[0-9a-f-]+\/events$/i.test(req.path) && req.query.token === TOKEN;
  if (auth !== 'Bearer ' + TOKEN && !viaQuery) return res.status(401).json({ error: 'Unauthorized' });
  next();
});

// ---------- small preferences file: pinned sessions (shared by every device) ----------
const PREFS_PATH = path.join(here, 'data', 'prefs.json');
function readPrefs() {
  try { return { pinned: [], ...JSON.parse(fs.readFileSync(PREFS_PATH, 'utf8')) }; } catch { return { pinned: [] }; }
}
function writePrefs(p) {
  fs.mkdirSync(path.dirname(PREFS_PATH), { recursive: true });
  fs.writeFileSync(PREFS_PATH, JSON.stringify(p, null, 2));
}

// Which Claude account the CLI on this machine is signed in as. Read from the
// same files Claude Code keeps its login in; nothing secret leaves this function.
let whoCache = { at: 0, value: null };
function whoAmI() {
  if (Date.now() - whoCache.at < 60000 && whoCache.value) return whoCache.value;
  // Preferred: ask the CLI itself, with this process's env, so a token set in .env
  // (CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY) is reported the way it will be used.
  try {
    const raw = execFileSync('claude', ['auth', 'status', '--json'], { encoding: 'utf8', timeout: 15000, windowsHide: true, env: authEnv() });
    const j = JSON.parse(raw);
    const value = {
      email: j.email || '', name: '', org: j.orgName || '', plan: j.subscriptionType || '',
      auth: j.authMethod || (j.loggedIn ? 'unknown' : 'none'), loggedIn: !!j.loggedIn,
      source: authSource(), tokenKind: getAuth()?.kind || '',
      projectsDir: j.projectsDirectory || '',
    };
    whoCache = { at: Date.now(), value };
    return value;
  } catch {}
  return whoAmIFromFiles();
}
function whoAmIFromFiles() {
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const out = { email: '', name: '', org: '', plan: '', source: authSource(), tokenKind: getAuth()?.kind || '' };
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

app.post('/api/auth/clear', (_req, res) => { setAuth(null); whoCache = { at: 0, value: null }; res.json({ ok: true }); });

app.get('/api/me', (_req, res) => res.json({ userName: USER_NAME, host: process.env.COMPUTERNAME || process.env.HOSTNAME || 'this machine', account: whoAmI() }));

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
    const prompt = String(req.body?.text || '').trim();
    if (!prompt) return res.status(400).json({ error: 'Empty message' });
    if (isLive(id)) return res.status(409).json({ error: 'Claude is still working on this chat.' });
    const info = await getSessionInfo(id);
    if (!info) return res.status(404).json({ error: 'Session not found' });
    const { model, permissionMode, effort } = req.body || {};
    const { run } = startRun({ sessionId: id, cwd: info.cwd, prompt, model, permissionMode, effort });
    res.json({ runId: run.id, sessionId: id });
  } catch (e) { next(e); }
});

app.post('/api/sessions', async (req, res) => {
  const prompt = String(req.body?.text || '').trim();
  const cwd = String(req.body?.cwd || '').trim();
  if (!prompt) return res.status(400).json({ error: 'Empty message' });
  if (!cwd || !fs.existsSync(cwd)) return res.status(400).json({ error: 'Pick a folder that exists on this machine.' });
  const { model, permissionMode, effort } = req.body || {};
  const { run, ready } = startRun({ cwd, prompt, model, permissionMode, effort });
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
  if (run && !run.done) run.abort.abort();
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
  res.write(`data: ${JSON.stringify({ t: 'tail', working: isWorkingElsewhere(id) })}\n\n`);
  const stop = tailSession(id, (ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`));
  req.on('close', () => { clearInterval(ping); if (stop) stop(); });
});

app.post('/api/permissions/:reqId', (req, res) => {
  const { behavior, always } = req.body || {};
  if (!answerPermission(req.params.reqId, behavior, !!always)) return res.status(404).json({ error: 'No such request (it may have expired).' });
  res.json({ ok: true });
});

app.get('/api/runs', (_req, res) => {
  res.json([...runs.values()].filter((r) => !r.done).map((r) => ({ sessionId: r.sessionId, startedAt: r.startedAt, waiting: [...pendingPermissions.values()].some((p) => p.run === r) })));
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: String(err?.message || err) });
});

app.listen(PORT, HOST, () => {
  console.log(`claude-remote listening on http://${HOST}:${PORT}`);
});
