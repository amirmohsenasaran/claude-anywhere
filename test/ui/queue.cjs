// The composer once a background task outlives the answer. A real Claude turn that leaves a
// task running is not reproducible on demand, so the run's event stream is synthetic: a
// scratch app serves the real client, and a tiny server stands in for the API — an answer, a
// running background task, and no `done`. It checks the composer goes idle and the next
// message starts a turn at once, instead of holding at "Working" and queueing behind the task.
//
//   npm i --no-save playwright && npx playwright install chromium
//   node test/ui/queue.cjs            (PW_CHANNEL=chrome to use an installed Chrome)
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const SHOTS = path.join(__dirname, 'shots');
const channel = process.env.PW_CHANNEL || undefined;
const SID = 'dddddddd-1111-2222-3333-444444444444';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0, failed = 0;
const check = (n, ok, d = '') => { ok ? passed++ : failed++; console.log((ok ? 'ok    ' : 'FAIL  ') + n + (!ok && d ? '  — ' + d : '')); };
const until = async (fn, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await fn()) return true; } catch {} await wait(100); } return false; };

// The synthetic API. `sink` is the open SSE the run streams down.
let seq = 0, sink = null;
const ev = (o) => `id: ${seq}\ndata: ${JSON.stringify({ i: seq++, ...o })}\n\n`;
const push = (o) => { if (sink) sink.write(ev(o)); };
function apiServer() {
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (url.pathname === `/api/sessions/${SID}/events`) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      sink = res; seq = 0;
      res.write(ev({ t: 'init', sessionId: SID, model: 'claude-haiku-4-5-20251001', cwd: 'C:/tmp', permissionMode: 'default', controls: {} }));
      res.write(ev({ t: 'prompt', id: 'p0', text: 'Render the video in the background', at: Date.now() }));
      res.write(ev({ t: 'msg_start', inputTokens: 10 }));
      res.write(ev({ t: 'block_start', index: 0, block: { type: 'text' }, at: Date.now() }));
      res.write(ev({ t: 'delta', index: 0, kind: 'text_delta', text: 'Started the render in the background.' }));
      res.write(ev({ t: 'block_stop', index: 0, at: Date.now() }));
      res.write(ev({ t: 'assistant', uuid: 'a0:0', content: [{ type: 'text', text: 'Started the render in the background.' }] }));
      res.write(ev({ t: 'tasks', tasks: [{ id: 'bg1', type: 'local_bash', description: 'ffmpeg render', status: 'running', backgrounded: true, startedAt: Date.now() }] }));
      res.write(ev({ t: 'result', subtype: 'success', isError: false, more: false, text: 'ok' }));
      // No `done`: the background task is still running, the process stays alive.
      req.on('close', () => { if (sink === res) sink = null; });
      return;
    }
    if (url.pathname === `/api/sessions/${SID}/send` && req.method === 'POST') {
      const id = 'p1';
      setTimeout(() => {
        push({ t: 'prompt', id, text: 'and mute the first two seconds', at: Date.now() });
        push({ t: 'msg_start', inputTokens: 10 });
        push({ t: 'block_start', index: 0, block: { type: 'text' }, at: Date.now() });
        push({ t: 'delta', index: 0, kind: 'text_delta', text: 'Muting the first two seconds now.' });
        push({ t: 'block_stop', index: 0, at: Date.now() });
        push({ t: 'assistant', uuid: 'a1:0', content: [{ type: 'text', text: 'Muting the first two seconds now.' }] });
        push({ t: 'result', subtype: 'success', isError: false, more: false, text: 'ok' });
      }, 200);
      return json({ queued: true, id, sessionId: SID });
    }
    if (url.pathname === `/api/sessions/${SID}`) return json({ sessionId: SID, id: SID, title: 'Render', project: 'tmp', cwd: 'C:/tmp', live: true, working: true, runStartedAt: Date.now(), lastModified: Date.now(), settings: { model: '', permissionMode: 'default', effort: '' }, interrupted: null });
    if (url.pathname === `/api/sessions/${SID}/messages`) return json([]);
    if (url.pathname === `/api/sessions/${SID}/usage`) return json({ context: null, limits: null });
    if (url.pathname === '/api/sessions' || url.pathname === '/api/projects' || url.pathname === '/api/worktrees') return json([]);
    if (url.pathname === '/api/config') return json({ passwordRequired: false, userName: 'Arya' });
    if (url.pathname === '/api/me') return json({ version: 'test', userName: 'Arya', host: 'this machine', account: 'local', active: 'local', hasToken: false, port: 7777, addresses: [] });
    if (url.pathname === '/api/models') return json({ models: [], at: Date.now() });
    json({ ok: true });
  });
}

async function main() {
  const fx = await import(pathToFileURL(path.join(__dirname, '..', 'fixtures', 'index.mjs')).href);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-queue-'));
  const app = await fx.startApp({ port: await fx.freePort(), dataDir: path.join(tmp, 'data'), configDir: path.join(tmp, 'claude') });
  const api = apiServer();
  await new Promise((r) => api.listen(0, '127.0.0.1', r));
  const apiPort = api.address().port;
  fs.mkdirSync(SHOTS, { recursive: true });

  const b = await chromium.launch({ headless: true, ...(channel ? { channel } : {}) });
  const ctx = await b.newContext({ viewport: { width: 1280, height: 860 }, colorScheme: 'light' });
  await ctx.addInitScript(() => { try { if (window.top === window) { localStorage.setItem('cr.accountChosen', '1'); localStorage.setItem('cr.token', 'x'); } } catch {} });
  // The client is the real one, from the app; only its API calls go to the synthetic server.
  await ctx.route('**/api/**', (route) => { const u = new URL(route.request().url()); route.continue({ url: `http://127.0.0.1:${apiPort}${u.pathname}${u.search}` }); });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(app.base + '/#/s/' + SID);
  await page.waitForSelector('#app:not(.hidden)');
  const txt = () => page.$eval('#thread', (t) => t.innerText);
  const clip = { x: 300, y: 0, width: 980, height: 860 };

  await until(async () => /Started the render/.test(await txt()));
  await wait(400);
  check('the "Working" pill hides once the answer is done', await page.$eval('#live-pill', (n) => n.classList.contains('hidden')), 'pill still shown');
  check('the send button is Send, not Stop', !(await page.$eval('#send', (n) => n.classList.contains('running'))));
  check('the tasks bar still shows the running background task', /task running/i.test(await page.$eval('#tasks-bar', (n) => n.innerText).catch(() => '')));
  await page.screenshot({ path: path.join(SHOTS, 'queue-idle-with-bg.png'), clip });

  await page.fill('#input', 'and mute the first two seconds');
  await page.click('#send');
  const queued = await until(async () => /Claude reads it after the current step/.test(await txt()), 1000);
  check('the next message is not labelled as queued behind the task', !queued);
  check('it starts a turn and Claude answers it', await until(async () => /Muting the first two seconds/.test(await txt())));
  await page.screenshot({ path: path.join(SHOTS, 'queue-next-message-ran.png'), clip });
  check('no errors in the app', !errors.length, errors.join(' | '));

  await b.close(); api.close(); await app.stop();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
}
main().catch((e) => { console.error(e); process.exit(1); });
