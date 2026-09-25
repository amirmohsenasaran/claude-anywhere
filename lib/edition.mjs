import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The Houshyar24 edition: one account, Houshyar24's, and nothing to switch.
//
// This branch builds a separate app ("Houshyar24 Code") that asks for a Houshyar24 API
// key on its first screen and runs every turn through Houshyar24's Anthropic-compatible
// endpoint. The generic provider machinery (lib/auth.mjs) does the work; this file only
// names the one provider it is allowed to be, and the other tools it can set up.

const BASE = 'https://houshyar24.ir';

export const EDITION = {
  id: 'houshyar24',
  name: 'Houshyar24 Code',
  brand: 'هوشیار۲۴',
  base: BASE,
  anthropic: BASE + '/api/anthropic',
  openai: BASE + '/api/openai/v1',
  mcp: BASE + '/mcp',
  keysUrl: BASE + '/developer/keys',
  keyPrefix: 'sk-hy24-',
  // The names Houshyar24's own installers use (install-src/_common.sh), so a tool set up
  // here and one set up with `curl …/install/codex.sh | bash` are the same setup.
  providerId: 'houshyar24',
  keyEnv: 'HOUSHYAR24_API_KEY',
};

// The provider record lib/auth.mjs keeps: Houshyar24 answers Bearer only.
export const providerFor = (key) => ({ name: EDITION.brand, baseUrl: EDITION.anthropic, key, keyKind: 'bearer', model: '' });
export const isOurs = (p) => !!p && String(p.baseUrl || '').replace(/\/+$/, '') === EDITION.anthropic;

// Where this app's Claude Code keeps its sessions and settings. Shared means the
// person's own ~/.claude - the sessions they already have, in both apps. Separate
// means ~/.houshyar24, which Claude Code uses as its whole config dir (sessions,
// settings, .claude.json). Read before the server overrides CLAUDE_CONFIG_DIR, so the
// Claude Code the person runs themselves can still be found and set up.
export const USER_CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
export const SEPARATE_DIR = path.join(os.homedir(), '.houshyar24');
// Claude Code is "here" when its CLI is, or when it has sessions to share - Claude
// Desktop keeps them in the same place without a CLI on PATH.
export function claudeInstalled() {
  try { if (fs.readdirSync(path.join(USER_CLAUDE_DIR, 'projects')).length) return true; } catch {}
  const dirs = [...String(process.env.PATH || '').split(path.delimiter), '/opt/homebrew/bin', '/usr/local/bin', path.join(os.homedir(), '.local', 'bin')];
  return dirs.some((d) => ['claude', 'claude.exe', 'claude.cmd'].some((n) => { try { return fs.statSync(path.join(d, n)).isFile(); } catch { return false; } }));
}
export function applyClaudeHome(mode) {
  if (mode === 'separate') { fs.mkdirSync(SEPARATE_DIR, { recursive: true }); process.env.CLAUDE_CONFIG_DIR = SEPARATE_DIR; }
  else if (USER_CLAUDE_DIR === path.join(os.homedir(), '.claude')) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = USER_CLAUDE_DIR;
}
// With CLAUDE_CONFIG_DIR set, Claude Code keeps .claude.json inside it instead of in home.
export const claudeJsonPath = () => (process.env.CLAUDE_CONFIG_DIR ? path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json') : path.join(os.homedir(), '.claude.json'));
