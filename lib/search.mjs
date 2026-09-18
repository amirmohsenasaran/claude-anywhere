// Find text inside session transcripts. The files are JSON Lines and some of them
// are hundreds of megabytes, so this scans raw bytes in chunks and only parses the
// lines that already matched — parsing every line would be minutes, not seconds.
//
// Scanning is newest-file-first under a time budget: a search that runs out of time
// says so rather than making the caller wait for a gigabyte of old transcripts.

import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { projectsDir } from './tail.mjs';

const CHUNK = 4 * 1024 * 1024;
const SNIPPET_PAD = 70;

/** Every transcript on this machine, newest first: [{ id, file, mtimeMs, size }]. */
export function transcriptFiles() {
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(projectsDir(), { withFileTypes: true }); } catch { return out; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const dir = path.join(projectsDir(), d.name);
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith('.jsonl')) continue;
      try { const st = fs.statSync(path.join(dir, n)); out.push({ id: n.slice(0, -6), file: path.join(dir, n), mtimeMs: st.mtimeMs, size: st.size }); } catch {}
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

// What a matching line is worth showing. What someone typed and what Claude answered
// come first; a match that is only in a command it ran or in the output of one is
// still worth showing, just after those.
function visibleText(j) {
  const c = j.message?.content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  const parts = [];
  for (const b of c) {
    if (b.type === 'text') parts.push(b.text);
    else if (b.type === 'tool_use') parts.push(b.name + ' ' + Object.values(b.input || {}).filter((v) => typeof v === 'string').join(' '));
    else if (b.type === 'tool_result') parts.push(typeof b.content === 'string' ? b.content : (b.content || []).filter((x) => x.type === 'text').map((x) => x.text).join(' '));
  }
  return parts.join('\n');
}
function snippetFor(line, needle) {
  let j;
  try { j = JSON.parse(line); } catch { return null; }
  if (j.isSidechain) return null;
  const text = visibleText(j);
  if (!text) return null;
  const at = text.toLowerCase().indexOf(needle);
  if (at < 0) return null;
  const from = Math.max(0, at - SNIPPET_PAD);
  const cut = text.slice(from, at + needle.length + SNIPPET_PAD).replace(/\s+/g, ' ').trim();
  return { role: j.type === 'assistant' ? 'assistant' : 'user', text: (from ? '…' : '') + cut + (at + needle.length + SNIPPET_PAD < text.length ? '…' : ''), uuid: j.uuid, timestamp: j.timestamp };
}

// A transcript also carries the harness's own bookkeeping — attachments, reminders,
// queued-prompt records. Those are not the conversation, and counting them makes a
// session look like a match when nobody ever said the word. Only what someone typed
// or Claude produced counts, which the raw line announces before we parse anything.
const isTurn = (line) => line.includes('"type":"user"') || line.includes('"type":"assistant"');

/** Scan one transcript. Returns { count, snippets, more }; counting stops at `maxHits`. */
function scanFile(file, needle, { maxHits = 200, maxSnippets = 3 } = {}) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return null; }
  const buf = Buffer.alloc(CHUNK);
  // A 4 MB boundary lands in the middle of a multi-byte character sooner or later, and
  // these transcripts are full of them; the decoder holds the stray bytes back until
  // the next chunk completes them, instead of handing us a replacement character.
  const decoder = new StringDecoder('utf8');
  let carry = '', count = 0, more = false;
  const snippets = [];
  const take = (line) => {
    if (!line || !isTurn(line) || line.toLowerCase().indexOf(needle) < 0) return true;
    const s = snippetFor(line, needle);
    if (!s) return true; // the word was in metadata on a real turn, not in the turn itself
    count++;
    if (snippets.length < maxSnippets) snippets.push(s);
    if (count >= maxHits) { more = true; return false; }
    return true;
  };
  try {
    for (let pos = 0; ; ) {
      const read = fs.readSync(fd, buf, 0, CHUNK, pos);
      if (read <= 0) break;
      pos += read;
      // A chunk boundary can split a line; the tail is carried into the next round.
      const lines = (carry + decoder.write(buf.subarray(0, read))).split('\n');
      carry = lines.pop() || '';
      let go = true;
      for (const line of lines) if (!(go = take(line))) break;
      if (!go || read < CHUNK) break;
    }
    if (!more) take(carry + decoder.end());
  } catch { /* a transcript being written while we read it: keep what we have */ }
  finally { try { fs.closeSync(fd); } catch {} }
  return { count, snippets, more };
}

// The same query twice in a row (typing, then pressing Enter) should not rescan a gigabyte.
const cache = new Map(); // q -> { at, value }
const CACHE_MS = 30000;

/**
 * Search every transcript for `q`, newest first.
 * Returns { q, hits: [{ id, count, snippets }], scanned, total, truncated }.
 */
export function searchTranscripts(q, { budgetMs = 8000, maxSessions = 60 } = {}) {
  const needle = String(q || '').toLowerCase().trim();
  if (needle.length < 2) return { q, hits: [], scanned: 0, total: 0, truncated: false };
  const hit = cache.get(needle);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;

  const files = transcriptFiles();
  const started = Date.now();
  const hits = [];
  let scanned = 0;
  for (const f of files) {
    if (Date.now() - started > budgetMs || hits.length >= maxSessions) break;
    scanned++;
    const r = scanFile(f.file, needle);
    if (r && r.count) hits.push({ id: f.id, count: r.count, more: r.more, snippets: r.snippets, lastModified: f.mtimeMs });
  }
  const value = { q, hits, scanned, total: files.length, truncated: scanned < files.length };
  cache.set(needle, { at: Date.now(), value });
  if (cache.size > 40) cache.delete(cache.keys().next().value);
  return value;
}
