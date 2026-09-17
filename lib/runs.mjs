// One live turn per session, buffered so a phone that drops off can reconnect
// and catch up. Continuing a session appends to that session's own transcript,
// exactly as `claude --resume` does from a terminal.

import { randomUUID } from 'node:crypto';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { authEnv } from './auth.mjs';

export const runs = new Map();               // sessionId -> Run
export const pendingPermissions = new Map(); // reqId -> { run, resolve }

export class Run {
  constructor(sessionId) {
    this.id = randomUUID();
    this.sessionId = sessionId || null; // filled in at `init` for a new session
    this.events = [];
    this.listeners = new Set();
    this.abort = new AbortController();
    this.done = false;
    this.startedAt = Date.now();
  }
  push(ev) {
    ev.i = this.events.length;
    this.events.push(ev);
    const line = `id: ${ev.i}\ndata: ${JSON.stringify(ev)}\n\n`;
    for (const res of this.listeners) res.write(line);
  }
  finish() {
    this.done = true;
    for (const res of this.listeners) res.end();
    this.listeners.clear();
    // keep the buffer a while so a reconnecting client still sees the tail
    setTimeout(() => { if (runs.get(this.sessionId) === this) runs.delete(this.sessionId); }, 5 * 60 * 1000);
  }
}

export const isLive = (id) => { const r = runs.get(id); return !!r && !r.done; };

function summariseInput(input) {
  if (!input || typeof input !== 'object') return '';
  const s = input.command || input.file_path || input.pattern || input.path || input.description || input.url || input.query || input.prompt || '';
  return String(s).slice(0, 400);
}

// Start a turn. Pass `sessionId` to continue, or only `cwd` for a new session.
// `ready` resolves with the session id as soon as the CLI reports it.
export const MODELS = ['claude-fable-5-1', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'];
export const PERMISSION_MODES = ['default', 'acceptEdits', 'plan'];
export const EFFORTS = ['low', 'medium', 'high'];

export function startRun({ sessionId, cwd, prompt, model, permissionMode, effort }) {
  const run = new Run(sessionId);
  if (sessionId) runs.set(sessionId, run);

  let resolveInit, rejectInit;
  const ready = new Promise((res, rej) => { resolveInit = res; rejectInit = rej; });

  // Tool prompts are answered by the user in the web client; the turn waits.
  const canUseTool = (toolName, input, { signal, suggestions }) => new Promise((resolve) => {
    const reqId = randomUUID();
    pendingPermissions.set(reqId, { run, resolve });
    run.push({ t: 'permission', reqId, tool: toolName, input, summary: summariseInput(input), canAlways: Array.isArray(suggestions) && suggestions.length > 0, suggestions });
    signal?.addEventListener('abort', () => {
      if (pendingPermissions.delete(reqId)) resolve({ behavior: 'deny', message: 'Turn was stopped.' });
    }, { once: true });
  });

  (async () => {
    try {
      const options = {
        cwd,
        env: authEnv(),
        abortController: run.abort,
        permissionMode: PERMISSION_MODES.includes(permissionMode) ? permissionMode : 'default',
        ...(MODELS.includes(model) ? { model } : {}),
        ...(EFFORTS.includes(effort) ? { effort } : {}),
        canUseTool,
        includePartialMessages: true,
        settingSources: ['user', 'project', 'local'],
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        stderr: (d) => { const s = String(d).trim(); if (s) run.push({ t: 'stderr', text: s.slice(0, 2000) }); },
      };
      if (sessionId) options.resume = sessionId;

      for await (const msg of query({ prompt, options })) {
        switch (msg.type) {
          case 'system':
            if (msg.subtype === 'init') {
              if (!run.sessionId) { run.sessionId = msg.session_id; runs.set(msg.session_id, run); }
              run.push({ t: 'init', sessionId: msg.session_id, model: msg.model, cwd: msg.cwd, permissionMode: msg.permissionMode });
              resolveInit(msg.session_id);
            }
            break;
          case 'stream_event': {
            const e = msg.event;
            if (e.type === 'message_start') run.push({ t: 'msg_start' });
            else if (e.type === 'content_block_start') run.push({ t: 'block_start', index: e.index, block: { type: e.content_block.type, name: e.content_block.name, id: e.content_block.id } });
            else if (e.type === 'content_block_delta') {
              const d = e.delta;
              const text = d.text ?? d.thinking ?? d.partial_json ?? '';
              if (text) run.push({ t: 'delta', index: e.index, kind: d.type, text });
            } else if (e.type === 'content_block_stop') run.push({ t: 'block_stop', index: e.index });
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
          case 'result':
            run.push({ t: 'result', subtype: msg.subtype, isError: !!msg.is_error, text: msg.result ?? '', costUsd: msg.total_cost_usd, durationMs: msg.duration_ms, numTurns: msg.num_turns });
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
