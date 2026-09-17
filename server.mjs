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
import { execFile, spawn } from 'node:child_process';
const SERVER_STARTED_AT = Date.now();
import { promisify } from 'node:util';
import { listSessions, getSessionMessages, getSessionInfo, renameSession, forkSession, deleteSession, tagSession } from '@anthropic-ai/claude-agent-sdk';
import { runs, pendingPermissions, isLive, startRun, answerPermission, bus, contextBySession, lastLimits } from './lib/runs.mjs';
import * as runsMod from './lib/runs.mjs';
const execFileP = promisify(execFile);
import { tailSession, isWorkingElsewhere, WORKING_WINDOW_MS, sessionFile } from './lib/tail.mjs';
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
  const viaQuery = req.method === 'GET' && (/^\/sessions\/[0-9a-f-]+\/events$/i.test(req.path) || req.path === '/notify' || req.path === '/file') && req.query.token === TOKEN;
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
  tag: s.tag || '',
  archived: s.tag === 'archived',
  context: contextBySession.get(s.sessionId) || null,
});

// ---------- session menu: rename, fork, archive, delete (the Desktop ⋮ menu) ----------
app.post('/api/sessions/:id/rename', async (req, res, next) => {
  try { const title = String(req.body?.title || '').trim().slice(0, 200); if (!title) return res.status(400).json({ error: 'Empty title' }); await renameSession(req.params.id, title); res.json({ ok: true, title }); } catch (e) { next(e); }
});
app.post('/api/sessions/:id/fork', async (req, res, next) => {
  try { const r = await forkSession(req.params.id, req.body?.title ? { title: String(req.body.title).slice(0, 200) } : {}); res.json({ sessionId: r.sessionId }); } catch (e) { next(e); }
});
app.post('/api/sessions/:id/archive', async (req, res, next) => {
  try { await tagSession(req.params.id, req.body?.archived ? 'archived' : null); res.json({ ok: true, archived: !!req.body?.archived }); } catch (e) { next(e); }
});
app.delete('/api/sessions/:id', async (req, res, next) => {
  try { if (isLive(req.params.id)) return res.status(409).json({ error: 'Stop the running turn first.' }); await deleteSession(req.params.id); res.json({ ok: true }); } catch (e) { next(e); }
});

// Lines the session wrote so far (Write / Edit / NotebookEdit inputs), what Desktop's
// "+19,770 −0" in the session bar counts. Cached by transcript size.
const lineStatsCache = new Map();
async function sessionLineStats(id) {
  let key = 0; try { const f = sessionFile(id); key = f ? fs.statSync(f).size : 0; } catch {}
  const hit = lineStatsCache.get(id); if (hit && hit.key === key) return hit.value;
  const count = (s) => (s ? String(s).split('\n').length : 0);
  let added = 0, removed = 0;
  try {
    for (const m of await getSessionMessages(id)) {
      if (m.type !== 'assistant' || !Array.isArray(m.message?.content)) continue;
      for (const b of m.message.content) {
        if (b.type !== 'tool_use') continue;
        const i = b.input || {};
        if (b.name === 'Write') added += count(i.content);
        else if (b.name === 'Edit') { added += count(i.new_string); removed += count(i.old_string); }
        else if (b.name === 'NotebookEdit') added += count(i.new_source);
      }
    }
  } catch {}
  const value = { added, removed }; lineStatsCache.set(id, { key, value }); return value;
}

// Branch and uncommitted diff of the session's folder, for the bar above the composer.
app.get('/api/sessions/:id/git', async (req, res) => {
  try {
    const s = await getSessionInfo(req.params.id);
    if (!s?.cwd || !fs.existsSync(s.cwd)) return res.json({ git: false });
    const run = (args) => execFileP('git', ['-C', s.cwd, ...args], { timeout: 6000, windowsHide: true }).then((r) => r.stdout.trim()).catch(() => null);
    const branch = await run(['rev-parse', '--abbrev-ref', 'HEAD']);
    if (branch === null) return res.json({ git: false });
    const stat = (await run(['diff', '--shortstat', 'HEAD'])) || '';
    const untrackedFiles = ((await run(['ls-files', '--others', '--exclude-standard'])) || '').split('\n').filter(Boolean);
    let added = Number((stat.match(/(\d+) insertion/) || [])[1] || 0), removed = Number((stat.match(/(\d+) deletion/) || [])[1] || 0);
    const files = Number((stat.match(/(\d+) files? changed/) || [])[1] || 0);
    // New files are part of the work too: count their lines (text files up to 2 MB), as Desktop does.
    for (const rel of untrackedFiles.slice(0, 400)) {
      try { const p = path.join(s.cwd, rel); const st = fs.statSync(p); if (st.size > 2 * 1024 * 1024 || /\.(png|jpe?g|gif|webp|mp4|mp3|wav|zip|pdf|woff2?|ico|exe|dll)$/i.test(rel)) continue; const buf = fs.readFileSync(p); if (buf.includes(0)) continue; added += buf.toString('utf8').split('\n').length - 1; } catch {}
    }
    const lines = await sessionLineStats(req.params.id);
    const dirty = files + untrackedFiles.length > 0;
    res.json({ git: true, branch, added, removed, files: files + untrackedFiles.length, dirty, sessionAdded: dirty ? added : lines.added, sessionRemoved: dirty ? removed : lines.removed });
  } catch (e) { res.json({ git: false, error: String(e.message || e) }); }
});

// Folder browser for "Open folder…" (the browser has no native folder dialog).
app.get('/api/browse', (req, res) => {
  const raw = String(req.query.path || '');
  const drives = [];
  for (const L of 'CDEFGHIJKLMNOPQRSTUVWXYZ') { try { if (fs.existsSync(L + ':\\')) drives.push(L + ':\\'); } catch {} }
  if (!raw) return res.json({ path: '', parent: null, dirs: drives.map((d) => ({ name: d, path: d })), drives, home: os.homedir() });
  const p = path.resolve(raw);
  let entries = [];
  try { entries = fs.readdirSync(p, { withFileTypes: true }); } catch (e) { return res.status(400).json({ error: 'Cannot open ' + p }); }
  const dirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('$') && e.name !== 'node_modules').map((e) => ({ name: e.name, path: path.join(p, e.name) })).sort((a, b) => a.name.localeCompare(b.name));
  const parent = path.dirname(p) === p ? '' : path.dirname(p);
  res.json({ path: p, parent, dirs, drives, home: os.homedir(), isGit: fs.existsSync(path.join(p, '.git')) });
});

// Branch of any folder (for the new-session chips).
app.get('/api/git', async (req, res) => {
  const cwd = String(req.query.cwd || '');
  if (!cwd || !fs.existsSync(cwd)) return res.json({ git: false });
  try { const r = await execFileP('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 5000, windowsHide: true }); res.json({ git: true, branch: r.stdout.trim() }); }
  catch { res.json({ git: false }); }
});

// ---------- plan limits straight from the account (no turn needed) ----------
// Same endpoint the CLI uses for the usage popover; works for claude.ai logins and
// setup-token tokens, not for Console API keys.
const limitsCache = new Map(); // which -> { at, value }
function oauthTokenFor(which) {
  const a = getAuth();
  if (which === 'token') return a.hasToken && a.tokenKind === 'oauth' ? JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'auth.json'), 'utf8')).token?.token : null;
  try { return JSON.parse(fs.readFileSync(path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), '.credentials.json'), 'utf8')).claudeAiOauth?.accessToken || null; } catch { return null; }
}
async function fetchLimits(which = activeAccount()) {
  const hit = limitsCache.get(which); if (hit && Date.now() - hit.at < 60000) return hit.value;
  const tok = oauthTokenFor(which); if (!tok) return null;
  // The endpoint rate-limits bursts (429): keep the last good answer and retry later.
  const stale = hit?.value || null;
  const fail = () => { limitsCache.set(which, { at: Date.now() - 30000, value: stale }); return stale; };
  try {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 8000);
    const r = await fetch('https://api.anthropic.com/api/oauth/usage', { headers: { Authorization: 'Bearer ' + tok, 'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': 'claude-remote/0.2' }, signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) return fail();
    const u = await r.json();
    const pick = (x) => (x && x.utilization != null ? { utilization: x.utilization, resets_at: x.resets_at } : null);
    const value = {
      subscription_type: whoAmI(which)?.plan || null,
      rate_limits: { five_hour: pick(u.five_hour), seven_day: pick(u.seven_day), seven_day_opus: pick(u.seven_day_opus), seven_day_sonnet: pick(u.seven_day_sonnet), model_scoped: [] },
      at: Date.now(), which,
    };
    limitsCache.set(which, { at: Date.now(), value });
    return value;
  } catch { return fail(); }
}

// Context window of a session and the active account's plan limits (the Desktop popover).
app.get('/api/sessions/:id/usage', async (req, res) => res.json({ context: contextBySession.get(req.params.id) || null, limits: (await fetchLimits()) || runsMod.lastLimits }));
app.get('/api/limits', async (req, res) => res.json({ limits: await fetchLimits(req.query.which === 'token' ? 'token' : req.query.which === 'local' ? 'local' : activeAccount()) }));

// ---------- connectors (MCP servers) and plugins, like Desktop's panel ----------
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const normPath = (p) => path.normalize(String(p || '')).replace(/[\\/]+$/, '').toLowerCase();
function listConnectors(cwd) {
  const out = []; const disabled = new Set(readPrefs().disabledMcp || []);
  const add = (name, cfg, scope) => { if (!cfg || out.some((x) => x.name === name)) return; out.push({ name, scope, type: cfg.type || (cfg.command ? 'stdio' : cfg.url ? 'http' : 'unknown'), target: cfg.url || [cfg.command, ...(cfg.args || [])].filter(Boolean).join(' '), enabled: !disabled.has(name) }); };
  const cj = readJson(path.join(os.homedir(), '.claude.json')) || {};
  for (const [n, c] of Object.entries(cj.mcpServers || {})) add(n, c, 'user');
  if (cwd) {
    for (const [k, v] of Object.entries(cj.projects || {})) if (normPath(k) === normPath(cwd)) for (const [n, c] of Object.entries(v.mcpServers || {})) add(n, c, 'project');
    const pj = readJson(path.join(cwd, '.mcp.json')); for (const [n, c] of Object.entries(pj?.mcpServers || pj || {})) if (c && typeof c === 'object') add(n, c, '.mcp.json');
  }
  out.push({ name: 'claude-remote', scope: 'built-in', type: 'in-process', target: 'SendUserFile — shows files in this chat', enabled: true, builtin: true });
  return out;
}
function listPlugins() {
  const settings = readJson(path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'settings.json')) || {};
  const enabled = settings.enabledPlugins || {};
  const known = readJson(path.join(os.homedir(), '.claude', 'plugins', 'known_marketplaces.json')) || {};
  const out = [];
  for (const [mkt, info] of Object.entries(known)) {
    const mj = readJson(path.join(info.installLocation || '', '.claude-plugin', 'marketplace.json'));
    for (const p of mj?.plugins || []) { const id = `${p.name}@${mkt}`; out.push({ id, name: p.name, marketplace: mkt, description: p.description || '', enabled: enabled[id] === true }); }
  }
  return out;
}
app.get('/api/connectors', async (req, res) => {
  const cwd = String(req.query.cwd || ''); const sessionId = String(req.query.sessionId || '');
  const connectors = listConnectors(cwd);
  const run = runs.get(sessionId);
  if (run && !run.done && run.query) { try { for (const s of await run.query.mcpServerStatus()) { const c = connectors.find((x) => x.name === s.name); if (c) { c.status = s.status; c.tools = (s.tools || []).length; c.error = s.error; } } } catch {} }
  res.json({ connectors, plugins: listPlugins() });
});
app.post('/api/connectors/:name', async (req, res) => {
  const name = req.params.name; const enabled = !!req.body?.enabled;
  const p = readPrefs(); const set = new Set(p.disabledMcp || []);
  if (enabled) set.delete(name); else set.add(name);
  p.disabledMcp = [...set]; writePrefs(p);
  const run = runs.get(String(req.body?.sessionId || ''));
  if (run && !run.done && run.query) { try { await run.query.toggleMcpServer(name, enabled); } catch (e) { return res.json({ enabled, note: 'Applies to the next turn: ' + e.message }); } }
  res.json({ enabled });
});
// Plugins are switched in Claude Code's own settings file, exactly what `/plugin` does.
app.post('/api/plugins/:id', (req, res) => {
  const file = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'settings.json');
  const settings = readJson(file) || {};
  settings.enabledPlugins = { ...(settings.enabledPlugins || {}), [req.params.id]: !!req.body?.enabled };
  fs.writeFileSync(file, JSON.stringify(settings, null, 2));
  res.json({ id: req.params.id, enabled: !!req.body?.enabled });
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

// Sidebar order (projects, sessions within each project, pinned), shared by every device.
// The list never re-sorts itself: new items slot in once, then only drag-and-drop moves them.
app.get('/api/order', (_req, res) => { const p = readPrefs(); res.json(p.order || { projects: [], sessions: {}, pinned: [] }); });
app.post('/api/order', (req, res) => {
  const o = req.body || {};
  const p = readPrefs();
  p.order = { projects: Array.isArray(o.projects) ? o.projects.slice(0, 500) : [], sessions: o.sessions && typeof o.sessions === 'object' ? o.sessions : {}, pinned: Array.isArray(o.pinned) ? o.pinned.slice(0, 500) : [] };
  writePrefs(p);
  res.json(p.order);
});

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
    const showArchived = req.query.archived === '1';
    res.json((await listSessions({ limit, offset })).filter((s) => showArchived || s.tag !== 'archived').map((s) => shape(s, pinned)));
  } catch (e) { next(e); }
});

app.get('/api/projects', async (_req, res, next) => {
  try {
    const seen = new Map();
    for (const s of await listSessions({ limit: 500 })) { const k = s.cwd && path.normalize(s.cwd).toLowerCase(); if (k && !seen.has(k)) seen.set(k, { cwd: s.cwd, name: path.basename(s.cwd), lastModified: s.lastModified }); }
    res.json([...seen.values()].sort((a, b) => b.lastModified - a.lastModified));
  } catch (e) { next(e); }
});

// The model and mode a session is on, like Desktop: what the user last picked for it,
// else what its transcript shows (assistant lines carry the model, user lines the mode).
const settingsCache = new Map(); // id -> { size, model, mode }
function sessionSettings(id) {
  const prefs = readPrefs();
  const saved = (prefs.sessionPrefs || {})[id] || {};
  let model = '', mode = '';
  try {
    const f = sessionFile(id);
    if (f) {
      const size = fs.statSync(f).size; const hit = settingsCache.get(id);
      if (hit && hit.size === size) ({ model, mode } = hit);
      else {
        // Prompt lines are rare in a long transcript (tool results dominate), so scan the whole file.
        for (const line of fs.readFileSync(f, 'utf8').split('\n').reverse()) {
          if (model && mode) break;
          if (!line.includes('"permissionMode"') && !line.includes('"model"')) continue;
          let j; try { j = JSON.parse(line); } catch { continue; }
          if (!model && j.type === 'assistant' && j.message?.model) model = j.message.model;
          if (!mode && j.type === 'user' && j.permissionMode) mode = j.permissionMode; // ('mode' lines are something else: "normal")
        }
        settingsCache.set(id, { size, model, mode });
      }
    }
  } catch {}
  return { model: saved.model || model || '', permissionMode: saved.permissionMode || mode || '', effort: saved.effort ?? '' };
}
// A turn that never finished (the app or the machine was restarted mid-work) leaves the
// transcript ending on a tool call with no result, or on a tool result with no answer.
function interruptedTurn(id) {
  try {
    const f = sessionFile(id); if (!f) return null;
    const st = fs.statSync(f); const size = Math.min(st.size, 512 * 1024);
    const fd = fs.openSync(f, 'r'); const buf = Buffer.alloc(size); fs.readSync(fd, buf, 0, size, st.size - size); fs.closeSync(fd);
    let last = null;
    for (const line of buf.toString('utf8').split('\n').reverse()) {
      if (!line.includes('"type":"assistant"') && !line.includes('"type":"user"')) continue;
      let j; try { j = JSON.parse(line); } catch { continue; }
      if (j.isSidechain || (j.type !== 'assistant' && j.type !== 'user')) continue;
      last = j; break;
    }
    if (!last) return null;
    const c = last.message?.content;
    if (last.type === 'assistant' && Array.isArray(c) && c.some((b) => b.type === 'tool_use')) return { kind: 'tool_call', at: last.timestamp };
    if (last.type === 'user' && Array.isArray(c) && c.some((b) => b.type === 'tool_result')) return { kind: 'tool_result', at: last.timestamp };
    return null;
  } catch { return null; }
}
app.get('/api/sessions/:id', async (req, res, next) => {
  try {
    let s = await getSessionInfo(req.params.id);
    // A session that started a moment ago has a live process but no transcript on disk yet.
    if (!s && isLive(req.params.id)) {
      const run = runs.get(req.params.id); const first = run.events.find((e) => e.t === 'prompt'); const init = run.events.find((e) => e.t === 'init');
      s = { sessionId: req.params.id, firstPrompt: (first?.text || '').slice(0, 120), cwd: init?.cwd || run.cwd || '', lastModified: run.startedAt, createdAt: run.startedAt };
    }
    if (!s) return res.status(404).json({ error: 'Not found' });
    const base = shape(s, new Set(readPrefs().pinned));
    const interrupted = !base.live && !base.working ? interruptedTurn(req.params.id) : null;
    res.json({ ...base, settings: sessionSettings(req.params.id), interrupted });
  } catch (e) { next(e); }
});
app.post('/api/sessions/:id/prefs', (req, res) => {
  const p = readPrefs(); p.sessionPrefs = p.sessionPrefs || {};
  const cur = p.sessionPrefs[req.params.id] || {};
  for (const k of ['model', 'permissionMode', 'effort']) if (req.body?.[k] !== undefined) cur[k] = req.body[k];
  p.sessionPrefs[req.params.id] = cur; writePrefs(p);
  res.json(cur);
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
    const { run } = startRun({ sessionId: id, cwd: info.cwd, prompt, images, model, permissionMode, effort, disabledMcp: readPrefs().disabledMcp || [] });
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
  let cwd = String(req.body?.cwd || '').trim();
  if (!cwd || cwd === '~') cwd = os.homedir(); // "No folder": Desktop runs those from the home directory
  if (!prompt && !images.length) return res.status(400).json({ error: 'Empty message' });
  if (!fs.existsSync(cwd)) return res.status(400).json({ error: 'That folder does not exist on this machine.' });
  const { model, permissionMode, effort } = req.body || {};
  const { run, ready } = startRun({ cwd, prompt, images, model, permissionMode, effort, disabledMcp: readPrefs().disabledMcp || [] });
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

// Tasks: the commands, subagents and workflows a live turn is running (Desktop's tasks panel).
const liveTasks = (id) => { const run = runs.get(id); return run && !run.done ? [...run.tasks.values()].filter((t) => !t.ambient) : []; };
app.get('/api/sessions/:id/tasks', (req, res) => res.json({ tasks: liveTasks(req.params.id) }));
app.post('/api/sessions/:id/tasks/:taskId/stop', async (req, res) => {
  const run = runs.get(req.params.id);
  if (!run || run.done) return res.status(404).json({ error: 'No live turn.' });
  try { res.json({ ok: await run.stopTask(req.params.taskId) }); } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
app.post('/api/sessions/:id/tasks/:taskId/background', async (req, res) => {
  const run = runs.get(req.params.id);
  if (!run || run.done) return res.status(404).json({ error: 'No live turn.' });
  try { res.json({ ok: await run.backgroundTask(req.params.taskId) }); } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
// What a task has printed so far: the CLI writes it under the temp dir, per project slug and session.
function taskOutputFile(sessionId, task) {
  if (task?.outputFile && fs.existsSync(task.outputFile)) return task.outputFile;
  const f = sessionFile(sessionId); if (!f) return null;
  const slug = path.basename(path.dirname(f));
  const p = path.join(os.tmpdir(), 'claude', slug, sessionId, 'tasks', task.id + '.output');
  return fs.existsSync(p) ? p : null;
}
app.get('/api/sessions/:id/tasks/:taskId/output', (req, res) => {
  const run = runs.get(req.params.id);
  const task = run?.tasks.get(req.params.taskId);
  if (!task) return res.status(404).json({ error: 'Unknown task.' });
  const file = taskOutputFile(req.params.id, task);
  if (!file) return res.json({ text: '', size: 0, exists: false });
  const MAX = 64 * 1024;
  try {
    const st = fs.statSync(file); const start = Math.max(0, st.size - MAX);
    const fd = fs.openSync(file, 'r'); const buf = Buffer.alloc(st.size - start); fs.readSync(fd, buf, 0, buf.length, start); fs.closeSync(fd);
    res.json({ text: buf.toString('utf8'), size: st.size, exists: true, truncated: start > 0 });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
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

// Images that Claude's answers point at on this PC (a screenshot it saved, a generated
// share card, `![...](build/icon.png)`): served so the chat can show them, like Desktop.
// Only image files, and only inside a project folder Claude Code has worked in or the
// upload/temp folder.
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|avif|mp4|webm|mov|m4v|mp3|m4a|wav|ogg)$/i; // images, plus video/audio that answers link to
app.get('/api/file', async (req, res) => {
  try {
    const raw = String(req.query.path || '');
    const cwd = String(req.query.cwd || '');
    let p = path.isAbsolute(raw) ? raw : (cwd ? path.resolve(cwd, raw) : '');
    if (!p) return res.status(400).json({ error: 'No path' });
    p = path.normalize(p);
    if (!IMAGE_EXT.test(p) || !fs.existsSync(p) || !fs.statSync(p).isFile()) return res.status(404).json({ error: 'Not an image on this PC' });
    const roots = new Set([os.tmpdir()]);
    for (const s of await listSessions({ limit: 500 })) if (s.cwd && path.normalize(s.cwd).replace(/[\\/]+$/, '').length > 3) roots.add(path.normalize(s.cwd)); // a session run from a drive root would open the whole drive
    const lower = p.toLowerCase();
    if (![...roots].some((r) => lower.startsWith(r.toLowerCase().replace(/[\\/]+$/, '') + path.sep) || lower.startsWith(r.toLowerCase().replace(/[\\/]+$/, '') + '/'))) return res.status(403).json({ error: 'Outside the project folders' });
    res.sendFile(p, { headers: { 'Cache-Control': 'private, max-age=60' }, acceptRanges: true });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// LAN / Tailscale addresses of this PC, for the "Phone connection" dialog.
app.get('/api/addresses', (_req, res) => {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) if (a.family === 'IPv4' && !a.internal) out.push({ name, address: a.address, tailscale: /tailscale/i.test(name) || a.address.startsWith('100.') });
  }
  res.json(out.sort((a, b) => Number(b.tailscale) - Number(a.tailscale)));
});

// ---------- updating from anywhere: what is running, restart the server, rebuild the app ----------
const liveCount = () => [...runs.values()].filter((r) => !r.done).length;
function gitInfo() {
  const g = (args) => { try { return execFileSync('git', ['-C', here, ...args], { encoding: 'utf8', timeout: 4000, windowsHide: true }).trim(); } catch { return ''; } };
  return { commit: g(['rev-parse', '--short', 'HEAD']), subject: g(['log', '-1', '--format=%s']), when: g(['log', '-1', '--format=%ci']), dirty: g(['status', '--porcelain']).split('\n').filter(Boolean).length };
}
// Files newer than what is running: server/page code since the server started (needs
// Restart server), Rust sources since the app was built (needs Rebuild app).
function newerThan(files, since) {
  const out = [];
  for (const f of files) { try { if (fs.statSync(f).mtimeMs > since + 1000) out.push(path.relative(here, f).replace(/\\/g, '/')); } catch {} }
  return out;
}
const listDir = (d, ext) => { try { return fs.readdirSync(d).filter((f) => ext.test(f)).map((f) => path.join(d, f)); } catch { return []; } };
app.get('/api/version', (_req, res) => {
  let exeAt = null; try { exeAt = fs.statSync(process.env.CLAUDE_REMOTE_APP_EXE || '').mtimeMs; } catch {}
  const serverFiles = [path.join(here, 'server.mjs'), path.join(here, 'package.json'), ...listDir(path.join(here, 'lib'), /\.mjs$/), ...listDir(path.join(here, 'public'), /\.(js|css|html|json)$/)];
  const shellFiles = [...listDir(path.join(here, 'src-tauri', 'src'), /\.rs$/), path.join(here, 'src-tauri', 'Cargo.toml'), path.join(here, 'src-tauri', 'tauri.conf.json')];
  const changed = newerThan(serverFiles, SERVER_STARTED_AT);
  const shellChanged = exeAt ? newerThan(shellFiles, exeAt) : [];
  res.json({ ...gitInfo(), serverDir: here, serverStartedAt: SERVER_STARTED_AT, appExe: process.env.CLAUDE_REMOTE_APP_EXE || null, appBuiltAt: exeAt, liveRuns: liveCount(), inApp: !!process.env.CLAUDE_REMOTE_PARENT_PID, stale: changed.length > 0, changed, shellStale: shellChanged.length > 0, shellChanged });
});
// New server code (server.mjs, lib/, public/) without touching the window: the app
// restarts the server on exit code 75 and reloads the page.
app.post('/api/restart', (req, res) => {
  if (liveCount() && !req.body?.force) return res.status(409).json({ error: `Claude is still working (${liveCount()} turn${liveCount() === 1 ? '' : 's'}). Try again when it is done.` });
  if (!process.env.CLAUDE_REMOTE_PARENT_PID) return res.status(400).json({ error: 'Not running inside the desktop app; restart `npm start` by hand.' });
  res.json({ ok: true, restarting: true });
  setTimeout(() => process.exit(75), 300);
});
// The Rust shell changed (rare): a detached script waits until idle, rebuilds and relaunches.
const REBUILD_LOG = path.join(DATA_DIR, 'rebuild.log');
app.post('/api/rebuild', (_req, res) => {
  const script = path.join(here, 'scripts', 'rebuild.ps1');
  if (!fs.existsSync(script)) return res.status(400).json({ error: 'scripts/rebuild.ps1 is missing' });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Repo', here, '-Port', String(PORT), '-Token', TOKEN, '-Log', REBUILD_LOG], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  res.json({ ok: true, log: REBUILD_LOG });
});
app.get('/api/rebuild/log', (_req, res) => { let text = ''; try { text = fs.readFileSync(REBUILD_LOG, 'utf8'); } catch {} res.json({ text, liveRuns: liveCount() }); });

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

// Started by the desktop app: leave when it leaves, but never while Claude is mid-turn.
// A new app instance (after a rebuild or update) finds this server on the port, adopts
// it (POST /api/adopt) and carries on with the same live runs.
let parentPid = Number(process.env.CLAUDE_REMOTE_PARENT_PID) || 0;
let orphanSince = 0;
if (parentPid) setInterval(() => {
  try { process.kill(parentPid, 0); orphanSince = 0; return; } catch {}
  const live = [...runs.values()].filter((r) => !r.done).length;
  if (live) { if (!orphanSince) { orphanSince = Date.now(); console.log(`[claude-remote] desktop app is gone; staying up for ${live} running turn(s)`); } return; }
  console.log('[claude-remote] desktop app is gone and nothing is running, exiting'); process.exit(0);
}, 2000).unref();
app.post('/api/adopt', (req, res) => { const pid = Number(req.body?.pid); if (pid > 0) { parentPid = pid; orphanSince = 0; console.log('[claude-remote] adopted by app pid', pid); } res.json({ ok: true, parentPid, liveRuns: [...runs.values()].filter((r) => !r.done).length }); });
