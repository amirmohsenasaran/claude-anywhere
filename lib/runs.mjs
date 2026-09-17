// One live Claude Code process per session, driven the way the Desktop app
// drives it: streaming input (so messages typed while Claude works are queued,
// not refused), permission mode / model / effort switchable mid-turn, and every
// status signal the SDK gives (tool progress, task notifications, token usage)
// forwarded to the client. Events are buffered so a phone that drops off can
// reconnect and catch up. Continuing a session appends to that session's own
// transcript, exactly as `claude --resume` does from a terminal.

import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { query, createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { authEnv } from './auth.mjs';

// Desktop gives Claude a SendUserFile tool so it can hand finished files (a video, a
// cover image, a PDF) to the person in the chat. The SDK's Claude Code does not have
// it, so this in-process tool fills the gap; the client renders it like Desktop does.
const sendUserFileServer = createSdkMcpServer({
  name: 'claude-remote',
  version: '1.0.0',
  tools: [
    tool(
      'SendUserFile',
      'Show files you produced to the user inside the chat: images, video, audio, PDFs, documents. Use it whenever the result of the work is a file the user should see or download, instead of only mentioning the path. Files must exist on disk; give absolute paths.',
      { files: z.array(z.string()).min(1).describe('Absolute paths of the files to show'), caption: z.string().optional().describe('One or two lines describing what these files are') },
      async ({ files, caption }) => {
        const missing = files.filter((f) => { try { return !fs.statSync(f).isFile(); } catch { return true; } });
        const ok = files.filter((f) => !missing.includes(f));
        const lines = [`${ok.length} file${ok.length === 1 ? '' : 's'} shown to the user in the chat.`];
        for (const f of ok) lines.push(`  ${f}`);
        if (missing.length) lines.push(`Not found: ${missing.join(', ')}`);
        if (caption) lines.push(`Caption: ${caption}`);
        return { content: [{ type: 'text', text: lines.join('\n') }], isError: ok.length === 0 };
      },
    ),
  ],
});

export const runs = new Map();               // sessionId -> Run
export const pendingPermissions = new Map(); // reqId -> { run, resolve }
export const bus = new EventEmitter();       // 'permission' | 'turn_done' — the desktop app turns these into notifications

export const MODELS = ['claude-fable-5-1', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'];
// bypassPermissions and dontAsk are left out on purpose: the first runs everything
// unattended, the second silently denies. 'auto' lets Claude's own classifier
// approve routine actions and still asks (here, on the phone) for the rest.
export const PERMISSION_MODES = ['default', 'acceptEdits', 'auto', 'plan', 'bypassPermissions'];
export const EFFORTS = ['low', 'medium', 'high'];

// Last known context-window usage per session and the account's rate limits, from the
// CLI's own control requests; what the Desktop "Context window / Plan usage" popover shows.
export const contextBySession = new Map(); // sessionId -> { totalTokens, maxTokens, percentage, model, at }
export let lastLimits = null;              // { subscription_type, rate_limits, at }
// Limits survive a restart so the banner and popover are right from the first screen.
const LIMITS_FILE = (process.env.CLAUDE_REMOTE_DATA_DIR || new URL('../data', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')) + '/limits.json';
try { const saved = JSON.parse(fs.readFileSync(LIMITS_FILE, 'utf8')); if (saved && Date.now() - saved.at < 7 * 24 * 3600 * 1000) lastLimits = saved; } catch {}
async function refreshUsage(run) {
  const q = run.query; if (!q) return;
  try {
    const c = await q.getContextUsage();
    const ctx = { totalTokens: c.totalTokens, maxTokens: c.maxTokens, percentage: c.percentage, model: c.model, at: Date.now() };
    if (run.sessionId) contextBySession.set(run.sessionId, ctx);
    run.push({ t: 'context', ...ctx });
  } catch {}
  try {
    const u = await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET();
    lastLimits = { subscription_type: u.subscription_type, rate_limits: u.rate_limits_available ? u.rate_limits : null, at: Date.now() };
    run.push({ t: 'limits', ...lastLimits });
    try { fs.mkdirSync(LIMITS_FILE.replace(/[\\/][^\\/]+$/, ''), { recursive: true }); fs.writeFileSync(LIMITS_FILE, JSON.stringify(lastLimits)); } catch {}
  } catch {}
}

export class Run {
  constructor(sessionId) {
    this.id = randomUUID();
    this.sessionId = sessionId || null; // filled in at `init` for a new session
    this.events = [];
    this.listeners = new Set();
    this.abort = new AbortController();
    this.done = false;
    this.startedAt = Date.now();
    this.query = null;      // the SDK Query, for mid-turn control
    this.queue = [];        // messages typed while Claude works
    this.wake = null;
    this.closing = false;
    this.inTurn = false;
    this.controls = {};
  }
  push(ev) {
    ev.i = this.events.length;
    this.events.push(ev);
    const line = `id: ${ev.i}\ndata: ${JSON.stringify(ev)}\n\n`;
    for (const res of this.listeners) res.write(line);
  }
  finish() {
    this.done = true;
    this.finishedAt = Date.now();
    for (const res of this.listeners) res.end();
    this.listeners.clear();
    // keep the buffer a while so a reconnecting client still sees the tail
    setTimeout(() => { if (runs.get(this.sessionId) === this) runs.delete(this.sessionId); }, 5 * 60 * 1000);
  }
  // Queue a follow-up. It is handed to Claude as soon as the current turn ends
  // (the Desktop/Remote Control behaviour). Returns null if this process is
  // already shutting down; the caller then starts a fresh one.
  enqueue(text, images = []) {
    if (this.closing || this.done) return null;
    const item = { id: randomUUID(), text, images };
    this.queue.push(item);
    this.push({ t: 'queued', id: item.id, text, images: images.map(imageBlock) });
    if (!this.inTurn) this.wake?.();
    return item.id;
  }
  // Stop the current turn (like Esc / the stop button). Queued messages are dropped.
  async stop() {
    this.queue = [];
    if (this.query && this.inTurn) { try { await this.query.interrupt(); return; } catch {} }
    this.closing = true; this.wake?.();
    this.abort.abort();
  }
  async setControls({ permissionMode, model, effort }) {
    const applied = {};
    if (!this.query) return applied;
    if (permissionMode && PERMISSION_MODES.includes(permissionMode) && permissionMode !== 'bypassPermissions') { await this.query.setPermissionMode(permissionMode); applied.permissionMode = permissionMode; }
    else if (permissionMode === 'bypassPermissions') { try { await this.query.setPermissionMode('bypassPermissions'); applied.permissionMode = permissionMode; } catch { applied.note = 'Bypass takes effect on the next turn.'; } }
    if (model && MODELS.includes(model)) { await this.query.setModel(model); applied.model = model; }
    if (effort !== undefined) { const lvl = EFFORTS.includes(effort) ? effort : null; await this.query.applyFlagSettings({ effortLevel: lvl }); applied.effort = lvl || ''; }
    Object.assign(this.controls, applied);
    this.push({ t: 'controls', ...applied });
    return applied;
  }
}

export const isLive = (id) => { const r = runs.get(id); return !!r && !r.done; };

function summariseInput(input) {
  if (!input || typeof input !== 'object') return '';
  const s = input.command || input.file_path || input.pattern || input.path || input.description || input.url || input.query || input.prompt || '';
  return String(s).slice(0, 400);
}

// A user turn: text, plus any images (API image blocks) sent from the phone or dropped into the window.
export const imageBlock = (a) => ({ type: 'image', source: { type: 'base64', media_type: a.media_type, data: a.data } });
const userMessage = (text, images = []) => ({
  type: 'user',
  message: { role: 'user', content: images.length ? [...images.map(imageBlock), ...(text ? [{ type: 'text', text }] : [])] : text },
  parent_tool_use_id: null,
  session_id: '',
});

// Start a session process. Pass `sessionId` to continue, or only `cwd` for a new
// session. `ready` resolves with the session id as soon as the CLI reports it.
export function startRun({ sessionId, cwd, prompt, images = [], model, permissionMode, effort }) {
  const run = new Run(sessionId);
  if (sessionId) runs.set(sessionId, run);
  const firstId = randomUUID();
  run.push({ t: 'prompt', id: firstId, text: prompt, images: images.map(imageBlock), at: run.startedAt }); // so a client that reloads mid-turn sees the question too
  run.controls = { permissionMode: PERMISSION_MODES.includes(permissionMode) ? permissionMode : 'default', model: MODELS.includes(model) ? model : '', effort: EFFORTS.includes(effort) ? effort : '' };

  let resolveInit, rejectInit;
  const ready = new Promise((res, rej) => { resolveInit = res; rejectInit = rej; });

  // Tool prompts are answered by the user in the web client; the turn waits.
  const canUseTool = (toolName, input, { signal, suggestions }) => new Promise((resolve) => {
    const reqId = randomUUID();
    pendingPermissions.set(reqId, { run, resolve });
    run.push({ t: 'permission', reqId, tool: toolName, input, summary: summariseInput(input), canAlways: Array.isArray(suggestions) && suggestions.length > 0, suggestions });
    bus.emit('permission', { sessionId: run.sessionId, tool: toolName, summary: summariseInput(input) });
    signal?.addEventListener('abort', () => {
      if (pendingPermissions.delete(reqId)) resolve({ behavior: 'deny', message: 'Turn was stopped.' });
    }, { once: true });
  });

  // Streaming input: the first prompt, then whatever gets queued, until a turn
  // ends with nothing waiting.
  async function* inputStream() {
    yield userMessage(prompt, images);
    while (true) {
      if (run.queue.length) {
        const item = run.queue.shift();
        run.inTurn = true;
        run.push({ t: 'prompt', id: item.id, text: item.text, images: (item.images || []).map(imageBlock), at: Date.now() });
        yield userMessage(item.text, item.images || []);
        continue;
      }
      if (run.closing) return;
      await new Promise((r) => { run.wake = r; });
      run.wake = null;
    }
  }

  (async () => {
    try {
      const options = {
        cwd,
        env: authEnv(),
        abortController: run.abort,
        permissionMode: run.controls.permissionMode,
        ...(run.controls.permissionMode === 'bypassPermissions' ? { allowDangerouslySkipPermissions: true } : {}),
        ...(run.controls.model ? { model: run.controls.model } : {}),
        ...(run.controls.effort ? { effort: run.controls.effort } : {}),
        canUseTool,
        mcpServers: { 'claude-remote': sendUserFileServer },
        allowedTools: ['mcp__claude-remote__SendUserFile'],
        includePartialMessages: true,
        settingSources: ['user', 'project', 'local'],
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        stderr: (d) => { const s = String(d).trim(); if (s) run.push({ t: 'stderr', text: s.slice(0, 2000) }); },
      };
      if (sessionId) options.resume = sessionId;

      const q = query({ prompt: inputStream(), options });
      run.query = q;
      run.inTurn = true;

      for await (const msg of q) {
        switch (msg.type) {
          case 'system':
            if (msg.subtype === 'init') {
              if (!run.sessionId) { run.sessionId = msg.session_id; runs.set(msg.session_id, run); }
              run.push({ t: 'init', sessionId: msg.session_id, model: msg.model, cwd: msg.cwd, permissionMode: msg.permissionMode, controls: run.controls });
              resolveInit(msg.session_id);
              refreshUsage(run);
            } else if (msg.subtype === 'status') {
              run.push({ t: 'status', status: msg.status, permissionMode: msg.permissionMode });
            } else if (msg.subtype === 'compact_boundary') {
              run.push({ t: 'note', text: 'Context was compacted.' });
            } else if (msg.subtype === 'informational' && msg.message) {
              run.push({ t: 'note', text: String(msg.message).slice(0, 500) });
            }
            break;
          case 'stream_event': {
            const e = msg.event;
            if (e.type === 'message_start') run.push({ t: 'msg_start', inputTokens: e.message?.usage?.input_tokens });
            else if (e.type === 'content_block_start') run.push({ t: 'block_start', index: e.index, block: { type: e.content_block.type, name: e.content_block.name, id: e.content_block.id } });
            else if (e.type === 'content_block_delta') {
              const d = e.delta;
              const text = d.text ?? d.thinking ?? d.partial_json ?? '';
              if (text) run.push({ t: 'delta', index: e.index, kind: d.type, text });
            } else if (e.type === 'content_block_stop') run.push({ t: 'block_stop', index: e.index });
            else if (e.type === 'message_delta' && e.usage) run.push({ t: 'usage', outputTokens: e.usage.output_tokens });
            break;
          }
          case 'assistant':
            if (!msg.parent_tool_use_id) run.push({ t: 'assistant', uuid: msg.uuid, content: msg.message.content });
            break;
          case 'user':
            if (!msg.parent_tool_use_id && Array.isArray(msg.message?.content)) {
              const results = msg.message.content.filter((b) => b.type === 'tool_result');
              if (results.length) run.push({ t: 'tool_results', uuid: msg.uuid, content: results });
            }
            break;
          case 'tool_progress':
            if (!msg.parent_tool_use_id) run.push({ t: 'tool_progress', toolUseId: msg.tool_use_id, tool: msg.tool_name, elapsed: msg.elapsed_time_seconds, heartbeat: !!msg.heartbeat });
            break;
          case 'tool_use_summary':
            run.push({ t: 'tool_summary', summary: msg.summary, toolUseIds: msg.preceding_tool_use_ids });
            break;
          case 'task_started': case 'task_progress': case 'task_notification': case 'task_updated':
            run.push({ t: 'task', kind: msg.type, taskId: msg.task_id, description: msg.description, summary: msg.summary, status: msg.status });
            break;
          case 'result':
            run.inTurn = false;
            run.push({ t: 'result', subtype: msg.subtype, isError: !!msg.is_error, text: msg.result ?? '', costUsd: msg.total_cost_usd, durationMs: msg.duration_ms, numTurns: msg.num_turns, usage: msg.usage ? { input: msg.usage.input_tokens, output: msg.usage.output_tokens } : undefined });
            bus.emit('turn_done', { sessionId: run.sessionId, text: String(msg.result || '').slice(0, 200), isError: !!msg.is_error });
            {
              // Read context/limits before the process is allowed to exit; never hold the loop for more than a moment.
              const finish = () => { if (!run.queue.length) run.closing = true; run.wake?.(); };
              Promise.race([refreshUsage(run), new Promise((r) => setTimeout(r, 4000))]).then(finish, finish);
            }
            break;
          default:
            break;
        }
      }
    } catch (err) {
      const text = err?.name === 'AbortError' ? 'Stopped.' : String(err?.message || err);
      run.push({ t: 'error', text });
      rejectInit(err);
    } finally {
      run.push({ t: 'done' });
      run.finish();
    }
  })();

  return { run, ready };
}

export function answerPermission(reqId, behavior, always) {
  const p = pendingPermissions.get(reqId);
  if (!p) return false;
  pendingPermissions.delete(reqId);
  const ev = p.run.events.find((e) => e.t === 'permission' && e.reqId === reqId);
  if (behavior === 'allow') {
    const r = { behavior: 'allow' };
    if (always && ev?.suggestions?.length) r.updatedPermissions = ev.suggestions;
    p.resolve(r);
  } else {
    p.resolve({ behavior: 'deny', message: 'The user declined this from their phone.' });
  }
  p.run.push({ t: 'permission_resolved', reqId, behavior: behavior === 'allow' ? 'allow' : 'deny' });
  return true;
}
