// Follow a session transcript that some other process (VS Code, a terminal,
// Claude Desktop) is writing, so the web client can watch it live. Claude Code
// appends one JSON line per finished block, so what we forward is exactly what
// the other window has already shown.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const projectsDir = () => path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');

const pathCache = new Map();
export function sessionFile(id) {
  const cached = pathCache.get(id);
  if (cached && fs.existsSync(cached)) return cached;
  let root;
  try { root = fs.readdirSync(projectsDir(), { withFileTypes: true }); } catch { return null; }
  for (const d of root) {
    if (!d.isDirectory()) continue;
    const p = path.join(projectsDir(), d.name, id + '.jsonl');
    if (fs.existsSync(p)) { pathCache.set(id, p); return p; }
  }
  return null;
}

export const WORKING_WINDOW_MS = 45000;
export function lastWriteMs(id) {
  const f = sessionFile(id);
  try { return f ? fs.statSync(f).mtimeMs : 0; } catch { return 0; }
}
export const isWorkingElsewhere = (id) => Date.now() - lastWriteMs(id) < WORKING_WINDOW_MS;

// Turn one transcript line into the same event shapes the live run stream uses.
function toEvent(line) {
  if (line.isSidechain) return null;
  if (line.type === 'assistant') {
    const content = line.message?.content;
    return Array.isArray(content) ? { t: 'assistant', uuid: line.uuid, content, tail: true } : null;
  }
  if (line.type === 'user') {
    const c = line.message?.content;
    if (typeof c === 'string') return c ? { t: 'user_text', uuid: line.uuid, text: c } : null;
    if (!Array.isArray(c)) return null;
    const results = c.filter((b) => b.type === 'tool_result');
    if (results.length) return { t: 'tool_results', uuid: line.uuid, content: results };
    const text = c.filter((b) => b.type === 'text').map((b) => b.text).join('\n\n');
    return text ? { t: 'user_text', uuid: line.uuid, text } : null;
  }
  if (line.type === 'mode') return { t: 'mode', mode: line.mode };
  return null;
}

/** Start following `id` from its current end. Returns a stop() function, or null if the file is unknown. */
export function tailSession(id, onEvent) {
  const file = sessionFile(id);
  if (!file) return null;
  let offset = 0;
  try { offset = fs.statSync(file).size; } catch {}
  let buf = '';
  let working = null;

  const read = () => {
    let st;
    try { st = fs.statSync(file); } catch { return; }
    if (st.size < offset) { offset = 0; buf = ''; } // rewritten (e.g. compaction)
    if (st.size > offset) {
      const fd = fs.openSync(file, 'r');
      const chunk = Buffer.alloc(st.size - offset);
      fs.readSync(fd, chunk, 0, chunk.length, offset);
      fs.closeSync(fd);
      offset = st.size;
      buf += chunk.toString('utf8');
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const l of lines) {
        if (!l.trim()) continue;
        let parsed; try { parsed = JSON.parse(l); } catch { continue; }
        const ev = toEvent(parsed);
        if (ev) onEvent(ev);
      }
    }
    const now = Date.now() - st.mtimeMs < WORKING_WINDOW_MS;
    if (now !== working) { working = now; onEvent({ t: 'working', on: now }); }
  };

  read();
  const iv = setInterval(read, 800);
  return () => clearInterval(iv);
}
