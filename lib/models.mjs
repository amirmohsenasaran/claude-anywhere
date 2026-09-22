// The model menu, as the CLI itself describes it.
//
// Hard-coding the list meant the app drifted from Claude the moment a model was
// added or an effort level appeared: ours offered low/medium/high for everything
// while the CLI had low/medium/high/xhigh/max for some models and none at all for
// Haiku. So the list comes from the CLI — the same answer Claude Code and Claude
// Desktop show — and the app only renders it.
//
// Asking costs a CLI process, not a model call: the query is opened with an input
// that never yields, `supportedModels()` answers over the control protocol, and the
// process is closed again. The answer is cached in memory and on disk, so the menu
// paints instantly and refreshes behind it.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { authEnv } from './auth.mjs';

const HOUR = 60 * 60 * 1000;

// The CLI the app carries, which is the one that answers. A model can be newer than
// it: the catalog entry says `min_claude_code_version`, and a CLI below that hides the
// model rather than offering something it cannot run - Opus 5.5 wanted 2.1.280 while
// the app shipped 2.1.274, so the menu was correct and still missing a model. That
// makes this version, not the clock, the thing worth watching.
const sdkManifest = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'manifest.json');
const cliVersion = () => { try { return JSON.parse(fs.readFileSync(sdkManifest, 'utf8')).version || ''; } catch { return ''; } };

// What to fall back to when the CLI cannot be asked (no login yet, an older CLI).
// Deliberately plain: a wrong-looking menu is better than an empty one.
export const FALLBACK = [
  { value: 'default', displayName: 'Default (recommended)', description: 'The model Claude Code picks', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
];

// Omitting the level runs the model's own default, which is 'high'.
export const DEFAULT_EFFORT = 'high';

let cache = { at: 0, models: null, error: '', from: '', cli: '' };
let inFlight = null;
let cachePath = '';

export function useCache(dir) {
  cachePath = path.join(dir, 'models.json');
  try {
    const disk = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (Array.isArray(disk.models) && disk.models.length) cache = { at: disk.at || 0, models: disk.models, error: '', from: 'disk', cli: disk.cli || '' };
  } catch {}
}

async function ask(env) {
  const never = (async function* () { await new Promise(() => {}); })();
  const q = query({ prompt: never, options: { env: env || authEnv() } });
  try {
    const models = await q.supportedModels();
    return Array.isArray(models) && models.length ? models : null;
  } finally {
    // Ending the generator is what closes the subprocess (stdin EOF, then grace).
    // interrupt() only stops a turn, and there is no turn here — it would leave a
    // CLI process behind on every refresh.
    try { await q.return(undefined); } catch {}
  }
}

function refresh(env) {
  if (inFlight) return inFlight;
  inFlight = ask(env)
    .then((models) => {
      if (!models) return;
      cache = { at: Date.now(), models, error: '', from: 'cli', cli: cliVersion() };
      if (cachePath) { try { fs.mkdirSync(path.dirname(cachePath), { recursive: true }); fs.writeFileSync(cachePath, JSON.stringify({ at: cache.at, cli: cache.cli, models }, null, 2)); } catch {} }
    })
    .catch((e) => { cache = { ...cache, error: String(e?.message || e) }; })
    .finally(() => { inFlight = null; });
  return inFlight;
}

/** The cached list, with a refresh started behind it when it may have moved on. */
export function list({ env, force = false } = {}) {
  const stale = !cache.models || Date.now() - cache.at > HOUR || cache.cli !== cliVersion();
  if (force || stale) refresh(env);
  return { models: cache.models || FALLBACK, at: cache.at, cli: cache.cli, from: cache.models ? cache.from : 'fallback', error: cache.error, defaultEffort: DEFAULT_EFFORT };
}

/** Ask now and wait, for the Refresh row in the menu: a background refresh would hand
 *  back the same list it was pressed about. */
export async function refreshNow(env) {
  await refresh(env);
  return list({ env });
}

/** Forget the list. The models are the account's - another login offers another menu,
 *  and a stale one would offer a model the new account cannot run. */
export function forget() {
  cache = { at: 0, models: null, error: '', from: '', cli: '' };
  if (cachePath) { try { fs.rmSync(cachePath, { force: true }); } catch {} }
}

/** Ask now and wait — used once at startup so the first menu is already the real one. */
export async function warm({ env } = {}) {
  await refresh(env);
  return list({ env });
}

/**
 * The row a saved id belongs to. A persisted wire id like `claude-sonnet-5` is the
 * `resolvedModel` of the alias row `sonnet`, which is what the CLI expects back.
 */
export function rowFor(id, models) {
  if (!id) return null;
  return (models || []).find((m) => m.value === id) || (models || []).find((m) => m.resolvedModel === id) || null;
}

/** Is this an id the CLI offered? Anything else must not be sent to it. */
export function known(id, models) {
  return !!rowFor(id, models);
}

/**
 * The id to send the CLI for what the client asked for, or '' to refuse it — and a
 * saved wire id comes back as the alias row that covers it, which is what the CLI
 * wants to hear. Before the list has arrived nothing can be checked against it, and
 * refusing every model until it does would silently run the wrong one, so the id is
 * passed through for the CLI itself to judge.
 */
export function acceptable(id) {
  if (!id) return '';
  if (!cache.models) return id;
  return rowFor(id, cache.models)?.value || '';
}

/** What is known right now, without asking for a refresh. */
export const cached = () => cache.models;

/** The effort levels that model allows, empty when it has none. */
export function effortsFor(id, models) {
  const row = rowFor(id, models);
  if (!row || row.supportsEffort === false) return [];
  return row.supportedEffortLevels || [];
}
