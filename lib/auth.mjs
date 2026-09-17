// Which Claude account the app runs with. Two are available and the user
// switches between them at any time:
//   local  — the account Claude Code is signed into on this computer (nothing stored here)
//   token  — a token the user pasted (from `claude setup-token`, or a Console API key),
//            kept in data/auth.json (git-ignored) so it survives restarts.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query } from '@anthropic-ai/claude-agent-sdk';

const DATA_DIR = process.env.CLAUDE_REMOTE_DATA_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const FILE = path.join(DATA_DIR, 'auth.json');

let state = { active: 'local', token: null }; // token: { kind: 'oauth' | 'apikey', token, since }
try {
  const saved = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  if (saved && typeof saved === 'object') {
    if (saved.kind && saved.token) state = { active: 'token', token: saved }; // old single-token format
    else state = { active: saved.active === 'token' && saved.token ? 'token' : 'local', token: saved.token || null };
  }
} catch {}

function save() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(state));
}

export const getAuth = () => ({ active: state.active, hasToken: !!state.token, tokenKind: state.token?.kind || '', tokenSince: state.token?.since || 0 });
export const activeAccount = () => (state.active === 'token' && state.token ? 'token' : 'local');

export function setActive(which) {
  state.active = which === 'token' && state.token ? 'token' : 'local';
  save();
  return activeAccount();
}
export function setToken(token, kind) {
  state.token = { kind, token, since: Date.now() };
  state.active = 'token';
  save();
}
export function clearToken() {
  state.token = null;
  state.active = 'local';
  save();
}

export function classifyToken(t) {
  t = (t || '').trim();
  if (!t) return null;
  return /^sk-ant-api/i.test(t) ? 'apikey' : 'oauth';
}

// Environment for CLI/SDK calls on a given account ('local' or 'token'; default: the active one).
export function envFor(which = activeAccount()) {
  const e = { ...process.env };
  if (process.versions.electron) e.ELECTRON_RUN_AS_NODE = '1';
  if (which === 'token' && state.token) {
    delete e.CLAUDE_CODE_OAUTH_TOKEN; delete e.ANTHROPIC_API_KEY;
    e[state.token.kind === 'apikey' ? 'ANTHROPIC_API_KEY' : 'CLAUDE_CODE_OAUTH_TOKEN'] = state.token.token;
  }
  return e;
}
export const authEnv = () => envFor();

export function localSource() {
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return 'CLAUDE_CODE_OAUTH_TOKEN in .env';
  if (process.env.ANTHROPIC_API_KEY) return 'ANTHROPIC_API_KEY in .env';
  return 'machine login';
}
export function authSource() {
  return activeAccount() === 'token' ? 'token entered in the app' : localSource();
}

// A token is only proven by a real request. One tiny turn on the cheapest model.
export async function verifyEnv(env) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 60000);
  try {
    for await (const msg of query({ prompt: 'Reply with the single word: ok', options: { env, abortController: abort, model: 'claude-haiku-4-5-20251001', maxTurns: 1, tools: [], persistSession: false, cwd: path.dirname(FILE) } })) {
      if (msg.type === 'result') return msg.is_error ? { ok: false, error: msg.result || 'The token was rejected.' } : { ok: true };
    }
    return { ok: false, error: 'No answer from Claude.' };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  } finally { clearTimeout(timer); }
}

export function candidateEnv(token, kind) {
  const e = { ...process.env };
  delete e.CLAUDE_CODE_OAUTH_TOKEN; delete e.ANTHROPIC_API_KEY;
  e[kind === 'apikey' ? 'ANTHROPIC_API_KEY' : 'CLAUDE_CODE_OAUTH_TOKEN'] = token;
  return e;
}
