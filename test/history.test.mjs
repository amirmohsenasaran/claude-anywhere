// A session's history, read from the end of its transcript a page at a time, across compactions
// and in the order the lines were written - what Claude Desktop shows. getSessionMessages()
// began at the last compaction and followed parent links: a compacted session lost its past,
// and a message answered beside the main thread, or a background command's notice, never
// showed. The transcript is made up (fixtures), the app is the real one. `node --test test/`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { freePort, makeLongSession, makeSession, startApp, PIXEL } from './fixtures/index.mjs';

let tmp, configDir, s, h, app;
const headers = () => ({ authorization: 'Bearer ' + app.token });
const textOf = (m) => m.role === 'task' ? m.summary : m.role === 'compact_summary' || m.role === 'notice' ? m.text : (m.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
async function allPages(id, opts = {}) {
  let p = await h.historyPage(id, opts);
  const pages = [p];
  while (p.more) { p = await h.historyPage(id, { ...opts, before: p.before }); pages.unshift(p); }
  return pages;
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-history-test-'));
  configDir = path.join(tmp, 'claude');
  process.env.CLAUDE_CONFIG_DIR = configDir;
  s = makeLongSession(configDir, path.join(tmp, 'project'));
  h = await import('../lib/history.mjs');
  app = await startApp({ port: await freePort(), dataDir: path.join(tmp, 'data'), configDir });
});
after(async () => {
  await app?.stop();
  // What the app started may still be writing into its folders for a moment after it stops
  // (Linux answered ENOTEMPTY in CI): retry, and never fail a run over a temp folder.
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch {}
});

test('the newest page comes first, and it is a page, not the whole session', async () => {
  const p = await h.historyPage(s.id);
  assert.ok(p.more, 'there is more before it');
  assert.ok(p.messages.length >= 100 && p.messages.length <= 200, 'a page of ' + p.messages.length);
  assert.equal(textOf(p.messages.at(-1)), "2 background shell command tasks didn't finish before the previous session ended.");
  assert.ok(!p.messages.some((m) => textOf(m) === 'Turn 1: build thing 1'), 'the first turn waits until someone scrolls up to it');
});

test('paging back reaches the first message, in the order the file has them, nothing twice', async () => {
  const pages = await allPages(s.id);
  const msgs = pages.flatMap((p) => p.messages);
  assert.ok(pages.length >= 4, pages.length + ' pages');
  const uuids = msgs.map((m) => m.uuid);
  assert.equal(new Set(uuids).size, uuids.length, 'a line on two pages');
  const order = uuids.map((u) => Number(u.slice(-12)));
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'file order');
  const text = msgs.map(textOf).join('\n');
  for (const t of s.said) assert.ok(text.includes(t), 'missing: ' + t);
  for (const t of s.hidden) assert.ok(!text.includes(t), 'shown: ' + t);
  assert.equal(textOf(msgs[0]), 'Turn 1: build thing 1');
});

test('each compaction is a marker where it happened, and everything before it is still there', async () => {
  const msgs = (await allPages(s.id)).flatMap((p) => p.messages);
  const marks = msgs.filter((m) => m.role === 'compact');
  assert.equal(marks.length, 2);
  assert.ok(marks.every((m) => m.trigger === 'auto' && m.preTokens > 950000 && m.postTokens === 9000));
  assert.equal(msgs.filter((m) => m.role === 'compact_summary').length, 2, 'the summary each one kept rides along, for its marker');
  // Rewind forks through the SDK, which starts after the last compaction: prompts before it say so.
  const last = msgs.indexOf(marks.at(-1));
  const prompts = (a, b) => msgs.slice(a, b).filter((m) => m.role === 'user' && !m.queued && m.content.some((x) => x.type === 'text'));
  assert.ok(prompts(0, last).length > 10 && prompts(0, last).every((m) => m.old), 'before the last compaction: old');
  assert.ok(prompts(last).every((m) => !m.old), 'after it: not old');
});

test('a message answered beside the main thread, a message typed mid-turn and task notices all show', async () => {
  const msgs = (await allPages(s.id)).flatMap((p) => p.messages);
  const text = msgs.map(textOf).join('\n');
  assert.ok(text.includes('stop the gpu for a game') && text.includes('Stopped the GPU jobs, play away.'), 'the branch off the parent chain');
  const queued = msgs.find((m) => m.queued);
  assert.equal(textOf(queued), 'also keep the logs');
  const tasks = msgs.filter((m) => m.role === 'task');
  assert.deepEqual(tasks.map((t) => [t.status, t.command]), [['completed', 'Render the long video'], ['failed', 'Upload the renders'], ['stopped', '']]);
  assert.ok(tasks[0].toolUseId.startsWith('toolu_'), 'a notice names the call that started its task');
});

test('narration is text, and the rest of the thinking never leaves the server', async () => {
  const msgs = (await allPages(s.id)).flatMap((p) => p.messages);
  assert.ok(!msgs.some((m) => m.role === 'assistant' && m.content.some((b) => b.type === 'thinking' || b.type === 'redacted_thinking')));
  const narration = msgs.filter((m) => m.role === 'assistant' && m.content.some((b) => b.narration));
  assert.equal(narration.length, 60);
});

test('a picture is a URL on the page, and the URL gives the picture back', async () => {
  const pages = await allPages(s.id);
  assert.ok(!JSON.stringify(pages).includes(PIXEL), 'no picture bytes in any page');
  const m = pages.flatMap((p) => p.messages).find((x) => JSON.stringify(x.content || '').includes('/image/'));
  const url = m.content[0].content[0].url;
  const [, uuid, n] = url.match(/\/image\/([^/]+)\/(\d+)$/);
  const pic = await h.historyImage(s.id, uuid, Number(n));
  assert.equal(pic.type, 'image/png');
  assert.deepEqual(pic.data, Buffer.from(PIXEL, 'base64'));
});

test('a page never separates a tool call from its result', async () => {
  for (const p of await allPages(s.id)) {
    const calls = new Set(p.messages.flatMap((m) => (m.role === 'assistant' ? m.content.filter((b) => b.type === 'tool_use').map((b) => b.id) : [])));
    for (const m of p.messages) if (m.role === 'user') for (const b of m.content) if (b.type === 'tool_result') assert.ok(calls.has(b.tool_use_id), 'a result without its call on page ending ' + p.before);
  }
});

test('a turn still running here is left to the live stream', async () => {
  const cut = Date.parse(s.lines.filter((l) => l.uuid && !l.isSidechain).at(-40).timestamp);
  const p = await h.historyPage(s.id, { until: cut });
  assert.ok(p.messages.length > 50);
  assert.ok(p.messages.every((m) => Date.parse(m.timestamp) < cut), 'nothing from the running turn');
});

test('the transcript growing shows in the next page, a half-written line waits, a rewritten file is read again', async () => {
  const x = makeLongSession(configDir, path.join(tmp, 'grow'), { id: 'ffffffff-1111-2222-3333-444444444444', turns: 6 });
  const first = await h.historyPage(x.id);
  const line = { parentUuid: x.lines.at(-1).uuid, isSidechain: false, type: 'user', uuid: 'ffffffff-0000-4000-8000-999999999999', timestamp: new Date().toISOString(), message: { role: 'user', content: 'one more thing' } };
  fs.appendFileSync(x.file, JSON.stringify(line) + '\n');
  assert.equal(textOf((await h.historyPage(x.id)).messages.at(-1)), 'one more thing');
  fs.appendFileSync(x.file, '{"parentUuid":null,"isSidechain":false,"type":"user","message":{"role":"user","content":"half a li');
  assert.equal(textOf((await h.historyPage(x.id)).messages.at(-1)), 'one more thing');
  fs.writeFileSync(x.file, x.lines.slice(0, 12).map((l) => JSON.stringify(l)).join('\n') + '\n');
  const again = await h.historyPage(x.id);
  assert.ok(again.messages.length < first.messages.length && !again.messages.some((m) => textOf(m) === 'one more thing'));
});

test('over HTTP: /history pages back through the session, and a picture needs the token', async () => {
  const get = (p) => fetch(app.base + p, { headers: headers() }).then((r) => r.json());
  let page = await get(`/api/sessions/${s.id}/history`);
  assert.ok(page.messages.length && page.more);
  let url = null, pages = 1;
  while (page.more) {
    const older = await get(`/api/sessions/${s.id}/history?before=${page.before}`);
    assert.ok(older.messages.length, 'an older page is not empty');
    assert.ok(Number(older.messages.at(-1).uuid.slice(-12)) < Number(page.messages[0].uuid.slice(-12)), 'and older');
    url ||= JSON.stringify(older.messages).match(/\/api\/sessions\/[^"]+\/image\/[^"]+\/\d+/)?.[0];
    page = older; pages++;
  }
  assert.ok(pages >= 4);
  assert.equal((await fetch(app.base + url)).status, 401, 'no picture without the token');
  const pic = await fetch(app.base + url + '?token=' + encodeURIComponent(app.token));
  assert.equal(pic.status, 200);
  assert.equal(pic.headers.get('content-type'), 'image/png');
  assert.match(pic.headers.get('cache-control'), /immutable/);
  const unknown = await get('/api/sessions/00000000-1111-2222-3333-444444444444/history');
  assert.deepEqual(unknown.messages, []);
  // An id that is not a session's names no file, however it is spelled.
  fs.writeFileSync(path.join(configDir, 'secret.jsonl'), JSON.stringify({ type: 'user', uuid: 'x', message: { role: 'user', content: 'not a session' } }) + '\n');
  for (const id of ['..%5Csecret', '..%2Fsecret', '..%5C..%5Csecret']) assert.deepEqual((await get(`/api/sessions/${id}/history`)).messages ?? [], [], id);
});

test('untracked files count as Desktop counts them: the first 200, text up to 1 MB each', async () => {
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo);
  const git = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'pipe' });
  git('init', '-q'); git('config', 'user.email', 'test@example.com'); git('config', 'user.name', 'test');
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n'); git('add', '.'); git('commit', '-qm', 'first');
  for (let i = 0; i < 205; i++) fs.writeFileSync(path.join(repo, `a${String(i).padStart(3, '0')}.txt`), 'line\n');
  fs.writeFileSync(path.join(repo, 'a000-big.txt'), 'x\n'.repeat(700000)); // 1.4 MB, and first in git's order
  const sid = makeSession(configDir, repo, '99999999-1111-2222-3333-444444444444');
  const g = await (await fetch(app.base + `/api/sessions/${sid}/git`, { headers: headers() })).json();
  assert.equal(g.files, 206);
  assert.equal(g.sessionAdded, 199, 'the big file is read as nothing, and the 201st file on is not read');
});
