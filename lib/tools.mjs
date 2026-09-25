// Point the other coding tools on this computer at Houshyar24, one button each.
//
// Configuration only: nothing is installed. Each setup writes exactly what Houshyar24's
// own installers write (hy24-app2 frontend/public/install-src/*.sh) or its docs say to
// paste (the /developer/code page), with the same provider id and key variable, so a
// tool set up here and one set up from the website are the same setup. Every file is
// backed up to <file>.bak.<stamp> before it is changed, the way those installers do.
//
// This runs on the computer the server is on - which is the computer whose tools these
// are, even when the window is on a phone.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { EDITION } from './edition.mjs';

const home = os.homedir();
const win = process.platform === 'win32';
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

function backup(file) {
  if (fs.existsSync(file)) fs.copyFileSync(file, file + '.bak.' + stamp());
}
function write(file, text, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  backup(file);
  fs.writeFileSync(file, text);
  if (mode && !win) fs.chmodSync(file, mode);
}
const read = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } };
const dq = (s) => JSON.stringify(String(s)); // a TOML/YAML basic string is JSON's

// Is the program on PATH? A macOS app started from Finder has a bare PATH, so the usual
// install folders are looked at too - the same list the shell uses to find Node.
const EXTRA_PATH = win ? [] : ['/opt/homebrew/bin', '/usr/local/bin', path.join(home, '.local', 'bin'), path.join(home, '.npm-global', 'bin'), path.join(home, '.bun', 'bin'), path.join(home, '.opencode', 'bin')];
function which(cmd) {
  const dirs = [...String(process.env.PATH || '').split(path.delimiter), ...EXTRA_PATH];
  const names = win ? [cmd + '.exe', cmd + '.cmd', cmd] : [cmd];
  for (const d of dirs) for (const n of names) { const p = path.join(d, n); try { if (fs.statSync(p).isFile()) return p; } catch {} }
  return '';
}

// ---------- the key where a tool expects to find it in the environment ----------
// Codex reads the key from a variable named in its config (env_key), so the variable has
// to exist in every new terminal: a marked block in the shell's startup file, replaced
// on the next setup - or a user variable on Windows. Same file and markers as
// Houshyar24's installers (persist_env in _common.sh).
function shellRc() {
  const shell = path.basename(process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash'));
  if (shell === 'zsh') return path.join(process.env.ZDOTDIR || home, '.zshrc');
  if (shell === 'bash') return path.join(home, process.platform === 'darwin' ? '.bash_profile' : '.bashrc');
  if (shell === 'fish') return path.join(home, '.config', 'fish', 'conf.d', EDITION.providerId + '.fish');
  return path.join(home, '.profile');
}
function persistEnv(tag, vars) {
  if (win) {
    for (const [k, v] of Object.entries(vars)) execFileSync('setx', [k, v], { stdio: 'ignore', windowsHide: true });
    return 'your Windows user environment';
  }
  const rc = shellRc(), fish = rc.endsWith('.fish');
  const begin = `# >>> ${EDITION.providerId} ${tag} >>>`, end = `# <<< ${EDITION.providerId} ${tag} <<<`;
  const kept = []; let skip = false;
  for (const line of read(rc).split('\n')) { if (line === begin) { skip = true; continue; } if (line === end) { skip = false; continue; } if (!skip) kept.push(line); }
  while (kept.length && kept[kept.length - 1] === '') kept.pop();
  const sq = (v) => "'" + String(v).replace(/'/g, "'\\''") + "'";
  const block = [begin, ...Object.entries(vars).map(([k, v]) => (fish ? `set -gx ${k} ${sq(v)}` : `export ${k}=${sq(v)}`)), end];
  write(rc, (kept.length ? kept.join('\n') + '\n\n' : '') + block.join('\n') + '\n');
  return rc.replace(home, '~');
}

// ---------- the tools ----------

const claudeSettings = () => path.join(process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'settings.json');
const codexConfig = () => path.join(process.env.CODEX_HOME || path.join(home, '.codex'), 'config.toml');
const opencodeConfig = () => { const dir = path.join(home, '.config', 'opencode'); const jsonc = path.join(dir, 'opencode.jsonc'); return fs.existsSync(jsonc) ? jsonc : path.join(dir, 'opencode.json'); };
const hermesConfig = () => {
  if (process.env.HERMES_HOME) return path.join(process.env.HERMES_HOME, 'config.yaml');
  const dot = path.join(home, '.hermes');
  if (win && process.env.LOCALAPPDATA && !fs.existsSync(dot)) return path.join(process.env.LOCALAPPDATA, 'hermes', 'config.yaml');
  return path.join(dot, 'config.yaml');
};
const openclawConfig = () => process.env.OPENCLAW_CONFIG_PATH || path.join(home, '.openclaw', 'openclaw.json');
const continueConfig = () => path.join(home, '.continue', 'config.yaml');

// JSONC as OpenCode writes it: comments and trailing commas. The comments do not survive
// a rewrite, which is what the backup is for.
function parseJsonc(text) {
  if (!text.trim()) return {};
  const bare = text.replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, s) => s || '').replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(bare);
}

export const TOOLS = [
  {
    id: 'claude-code', name: 'Claude Code', how: 'The claude CLI and its IDE extensions, through Houshyar24\'s Anthropic endpoint.',
    installed: () => !!which('claude'), file: claudeSettings,
    configured: () => { try { return JSON.parse(read(claudeSettings())).env?.ANTHROPIC_BASE_URL === EDITION.anthropic; } catch { return false; } },
    // settings.json's env block rather than the shell: it reaches the CLI, the VS Code and
    // JetBrains extensions and Claude Desktop's Code tab alike, on every platform. A stray
    // ANTHROPIC_API_KEY there would win over the token, so it goes.
    setup({ key }) {
      const file = claudeSettings(); let s = {};
      try { s = JSON.parse(read(file) || '{}'); } catch { throw new Error(file + ' is not valid JSON; fix it and try again.'); }
      const env = { ...(s.env || {}) }; delete env.ANTHROPIC_API_KEY;
      s.env = { ...env, ANTHROPIC_BASE_URL: EDITION.anthropic, ANTHROPIC_AUTH_TOKEN: key };
      write(file, JSON.stringify(s, null, 2) + '\n', 0o600);
      return { wrote: [file], then: 'Start it with: claude' };
    },
  },
  {
    id: 'codex', name: 'Codex', how: 'OpenAI\'s Codex CLI, through Houshyar24\'s Responses API.',
    installed: () => !!which('codex'), file: codexConfig,
    configured: () => new RegExp(`^\\s*\\[model_providers\\.${EDITION.providerId}\\]`, 'm').test(read(codexConfig())),
    // Houshyar24's codex.sh, line for line: drop our previous table and every top-level
    // model_provider, put ours first (top-level keys must precede the first table) and
    // append the table. No model is set: Codex's own names are aliases on Houshyar24.
    setup({ key }) {
      const file = codexConfig(); const id = EDITION.providerId; const kept = [];
      let inTable = false, skip = false;
      for (const line of read(file).split(/\r?\n/)) {
        if (/^\s*\[/.test(line)) { inTable = true; const h = line.replace(/[\s"]/g, ''); skip = h === `[model_providers.${id}]` || h.startsWith(`[model_providers.${id}.`); }
        if (skip) continue;
        if (!inTable && /^\s*model_provider\s*=/.test(line)) continue;
        kept.push(line);
      }
      const body = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
      const text = `model_provider = ${dq(id)}\n${body ? body + '\n' : ''}\n[model_providers.${id}]\nname = ${dq('Houshyar24')}\nbase_url = ${dq(EDITION.openai)}\nenv_key = ${dq(EDITION.keyEnv)}\nwire_api = "responses"\n`;
      write(file, text);
      const where = persistEnv('codex', { [EDITION.keyEnv]: key });
      return { wrote: [file], env: where, then: 'Open a new terminal, then: codex  (pick a model with /model)' };
    },
  },
  {
    id: 'opencode', name: 'OpenCode', how: 'OpenCode, as a custom OpenAI-compatible provider with Houshyar24\'s models.',
    installed: () => !!which('opencode'), file: opencodeConfig,
    configured: () => { try { return !!parseJsonc(read(opencodeConfig())).provider?.[EDITION.providerId]; } catch { return false; } },
    setup({ key, models }) {
      const file = opencodeConfig(); let c;
      try { c = parseJsonc(read(file)); } catch { throw new Error(file + ' could not be read as JSON; fix it and try again.'); }
      c.$schema ||= 'https://opencode.ai/config.json';
      c.provider = { ...(c.provider || {}), [EDITION.providerId]: { npm: '@ai-sdk/openai-compatible', name: 'Houshyar24', options: { baseURL: EDITION.openai, apiKey: key }, models: Object.fromEntries(models.map((m) => [m.id, { name: m.name || m.id }])) } };
      write(file, JSON.stringify(c, null, 2) + '\n', 0o600);
      return { wrote: [file], then: 'Restart OpenCode and choose a Houshyar24 model with /models' };
    },
  },
  {
    id: 'hermes', name: 'Hermes', how: 'Nous Research\'s Hermes agent, as a custom provider.',
    installed: () => !!which('hermes'), file: hermesConfig,
    configured: () => read(hermesConfig()).includes(EDITION.openai),
    // Houshyar24's hermes.sh: only the top-level `model:` block is replaced, key inline,
    // file readable by its owner alone.
    setup({ key, model }) {
      const file = hermesConfig(); const out = []; let inModel = false, blanks = [];
      for (const line of read(file).split(/\r?\n/)) {
        if (inModel) { if (!line.trim()) { blanks.push(line); continue; } if (/^\s/.test(line)) { blanks = []; continue; } inModel = false; out.push(...blanks); blanks = []; }
        if (/^model\s*:/.test(line)) { inModel = true; continue; }
        out.push(line);
      }
      out.push(...blanks);
      const body = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
      write(file, (body ? body + '\n\n' : '') + `model:\n  default: ${dq(model)}\n  provider: custom\n  base_url: ${dq(EDITION.openai)}\n  api_key: ${dq(key)}\n`, 0o600);
      return { wrote: [file], then: `Start it with: hermes  (switch with /model custom:<id>)` };
    },
  },
  {
    id: 'openclaw', name: 'OpenClaw', how: 'OpenClaw, with Houshyar24 as a model provider and one model as its default.',
    installed: () => !!which('openclaw'), file: openclawConfig,
    configured: () => read(openclawConfig()).includes(EDITION.openai),
    // Through OpenClaw's own `config set` when it is installed, which knows its JSON5 file
    // and reloads a running gateway; the flags changed between versions, hence the ladder.
    // Without it, only a file that does not exist yet is written - never rewrite JSON5.
    setup({ key, model, models }) {
      const provider = { baseUrl: EDITION.openai, api: 'openai-completions', apiKey: key, models: models.map((m) => ({ id: m.id, name: m.name || m.id, input: m.vision ? ['text', 'image'] : ['text'] })) };
      const bin = which('openclaw');
      if (bin) {
        const set = (args) => execFileSync(bin, ['config', 'set', ...args], { stdio: 'pipe', windowsHide: true, timeout: 30000 });
        const json = JSON.stringify(provider);
        let done = false, last;
        for (const flags of [['--strict-json', '--replace'], ['--strict-json', '--merge'], ['--strict-json'], []]) { try { set([`models.providers.${EDITION.providerId}`, json, ...flags]); done = true; break; } catch (e) { last = e; } }
        if (!done) throw new Error('openclaw config set failed: ' + String(last?.stderr || last?.message || last).trim().split('\n').pop());
        set(['agents.defaults.model.primary', `${EDITION.providerId}/${model}`]);
        return { wrote: ['openclaw config'], then: 'Start it with: openclaw onboard  (a running gateway picks this up by itself)' };
      }
      const file = openclawConfig();
      if (fs.existsSync(file)) throw new Error('OpenClaw is not on PATH, and its config already exists. Install OpenClaw (npm install -g openclaw@latest) and press Set up again.');
      write(file, JSON.stringify({ models: { providers: { [EDITION.providerId]: provider } }, agents: { defaults: { model: { primary: `${EDITION.providerId}/${model}` } } } }, null, 2) + '\n', 0o600);
      return { wrote: [file], then: 'Install OpenClaw (npm install -g openclaw@latest), then: openclaw onboard' };
    },
  },
  {
    id: 'continue', name: 'Continue', how: 'The Continue extension for VS Code and JetBrains, with Houshyar24\'s models.',
    installed: () => fs.existsSync(path.join(home, '.continue')), file: continueConfig,
    configured: () => read(continueConfig()).includes(EDITION.openai),
    // Houshyar24's docs replace the whole file; the backup keeps what was there.
    setup({ key, models }) {
      const lines = ['name: Houshyar24', 'version: 0.0.1', 'schema: v1', 'models:'];
      for (const m of models) lines.push(`  - name: ${dq(m.name || m.id)}`, '    provider: openai', `    model: ${dq(m.id)}`, `    apiBase: ${dq(EDITION.openai + '/')}`, `    apiKey: ${dq(key)}`, '    useResponsesApi: false', '    capabilities:', '      - tool_use', ...(m.vision ? ['      - image_input'] : []));
      write(continueConfig(), lines.join('\n') + '\n', 0o600);
      return { wrote: [continueConfig()], then: 'Reload Continue; the models are in its model picker' };
    },
  },
  {
    // Cline keeps its settings in VS Code's own storage, which no file edit reaches; the
    // page shows what to paste instead.
    id: 'cline', name: 'Cline', how: 'Cline in VS Code: paste these into its settings (API Provider: OpenAI Compatible).',
    manual: true, installed: () => false, configured: () => false,
  },
];

export function list() {
  return TOOLS.map((t) => {
    let installed = false, configured = false;
    try { installed = t.installed(); } catch {}
    try { configured = t.configured(); } catch {}
    return { id: t.id, name: t.name, how: t.how, manual: !!t.manual, installed, configured, file: t.file ? t.file().replace(home, '~') : '' };
  });
}

export async function setup(id, opts) {
  const t = TOOLS.find((x) => x.id === id);
  if (!t || t.manual) throw new Error('Nothing to set up for ' + id);
  if (!opts.key) throw new Error('Enter your Houshyar24 key first.');
  const r = t.setup(opts);
  return { ...r, wrote: (r.wrote || []).map((f) => f.replace(home, '~')) };
}

// ---------- Houshyar24's MCP server, in Claude Code ----------
// Added with the Claude Code binary the app already carries, exactly `claude mcp add`,
// so the file it lives in (~/.claude.json, which Claude Code rewrites all the time) is
// changed by its owner. Houshyar24's MCP signs in with OAuth only - the API key is
// refused - so the one sign-in happens in Claude Code: /mcp, then Authenticate.
const MCP_NAME = EDITION.providerId;
function claudeBin() {
  const require = createRequire(import.meta.url);
  try {
    const dir = path.dirname(require.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`));
    const bin = path.join(dir, win ? 'claude.exe' : 'claude');
    if (fs.existsSync(bin)) return bin;
  } catch {}
  return which('claude');
}
export function mcpStatus() {
  let added = false;
  try { added = !!JSON.parse(read(path.join(home, '.claude.json')) || '{}').mcpServers?.[MCP_NAME]; } catch {}
  return { name: MCP_NAME, url: EDITION.mcp, added, cli: !!which('claude') };
}
export function addMcp() {
  const bin = claudeBin();
  if (!bin) throw new Error('Claude Code was not found to add it with.');
  if (mcpStatus().added) return mcpStatus();
  execFileSync(bin, ['mcp', 'add', '--transport', 'http', '--scope', 'user', MCP_NAME, EDITION.mcp], { stdio: 'pipe', windowsHide: true, timeout: 30000 });
  return mcpStatus();
}
