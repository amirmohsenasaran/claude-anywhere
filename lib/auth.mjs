// Which Claude credentials the app runs with. Either the machine's own
// `claude login` (nothing stored here) or a token the user typed on the login
// page, kept in data/auth.json (git-ignored) so it survives restarts.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query } from '@anthropic-ai/claude-agent-sdk';

const DATA_DIR = process.env.CLAUDE_REMOTE_DATA_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const FILE = path.join(DATA_DIR, 'auth.json');
let current = null;
try { current = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch {}

export const getAuth = () => current;

export function setAuth(a) {
  current = a;
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  if (a) fs.writeFileSync(FILE, JSON.stringify(a)); else fs.rmSync(FILE, { force: true });
}

export function classifyToken(t) {
  t = (t || '').trim();
  if (!t) return null;
  return /^sk-ant-api/i.test(t) ? 'apikey' : 'oauth';
}

// Environment for every CLI/SDK call: the machine env with exactly one source of
// credentials in it.
export function authEnv() {
  const e = { ...process.env };
  // Inside the desktop app the SDK's child process must run as plain Node, not as Electron.
  if (process.versions.electron) e.ELECTRON_RUN_AS_NODE = '1';
  if (current?.kind === 'apikey') { delete e.CLAUDE_CODE_OAUTH_TOKEN; e.ANTHROPIC_API_KEY = current.token; }
  else if (current?.kind === 'oauth') { delete e.ANTHROPIC_API_KEY; e.CLAUDE_CODE_OAUTH_TOKEN = current.token; }
  return e;
}

export function authSource() {
  if (current) return 'token entered at login';
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return 'CLAUDE_CODE_OAUTH_TOKEN in .env';
  if (process.env.ANTHROPIC_API_KEY) return 'ANTHROPIC_API_KEY in .env';
  return 'machine login';
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
