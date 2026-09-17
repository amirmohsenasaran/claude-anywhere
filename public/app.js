/* claude-remote client. Plain JS, no build step. */
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };

  const state = {
    token: null, userName: '', host: '',
    sessions: [], projects: [], cwd: localStorage.getItem('cr.cwd') || '',
    current: null,       // session id or null for "new chat"
    running: false, es: null, lastEventId: -1,
    live: null,          // streaming assistant message being built
  };
  try { state.token = localStorage.getItem('cr.token'); } catch {}
  // The desktop app opens its own window already signed in.
  try {
    const u = new URL(location.href);
    if (u.searchParams.get('auto')) { state.token = u.searchParams.get('auto'); localStorage.setItem('cr.token', state.token); u.searchParams.delete('auto'); history.replaceState(null, '', u.pathname + u.search + u.hash); }
  } catch {}

  // ---------- api ----------
  async function api(path, opts = {}) {
    const res = await fetch('/api' + path, { ...opts, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + state.token, ...(opts.headers || {}) } });
    if (res.status === 401) { logout(); throw new Error('Unauthorized'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  }

  // ---------- markdown ----------
  marked.setOptions({ breaks: true, gfm: true });
  const md = (text) => DOMPurify.sanitize(marked.parse(text || ''), { USE_PROFILES: { html: true } });
  const stripHarness = (t) => String(t || '')
    .replace(/<(system-reminder|ide_opened_file|ide_selection|local-command-stdout|local-command-stderr|command-name|command-message|command-args)[\s\S]*?<\/\1>/g, '')
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, '')
    .trim();

  // ---------- login ----------
  function showLogin(err) {
    $('#app').classList.add('hidden');
    $('#login').classList.remove('hidden');
    const e = $('#login-error'); e.hidden = !err; e.textContent = err || '';
    $('#login-password').focus();
  }
  function logout() { try { localStorage.removeItem('cr.token'); } catch {} state.token = null; showLogin(); }
  async function login(password) {
    const res = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Wrong password');
    state.token = data.token; try { localStorage.setItem('cr.token', data.token); } catch {}
  }
  $('#login-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const btn = $('#login-submit');
    btn.classList.add('busy'); btn.textContent = 'Signing in…';
    try { await login($('#login-password').value); boot(); }
    catch (e) { showLogin(e.message); }
    finally { btn.classList.remove('busy'); btn.textContent = 'Continue'; }
  });

  // ---------- accounts: this computer's login or a token, switchable any time ----------
  const acctModal = $('#account-modal');
  let accounts = null;
  const describe = (a) => a ? [a.email || (a.auth === 'oauth_token' ? 'Signed in with a token' : a.loggedIn === false ? 'Not signed in' : 'Signed in'), a.plan, a.org && a.org !== a.email + "'s Organization" ? a.org : ''].filter(Boolean).join(' · ') : '';
  async function openAccounts() {
    acctModal.classList.remove('hidden');
    $('#acct-error').hidden = true;
    try { accounts = await api('/accounts'); } catch (e) { $('#acct-error').hidden = false; $('#acct-error').textContent = e.message; return; }
    renderAccounts();
  }
  function renderAccounts() {
    if (!accounts) return;
    $('#acct-local-desc').textContent = describe(accounts.local) || 'No Claude Code login found on this computer';
    $('#acct-token-desc').textContent = accounts.token ? describe(accounts.token) : 'Not added yet';
    for (const card of acctModal.querySelectorAll('.account-card')) {
      const w = card.dataset.which;
      card.classList.toggle('active', accounts.active === w);
      card.classList.toggle('disabled', w === 'token' && !accounts.token);
    }
    $('#acct-token-remove').classList.toggle('hidden', !accounts.token);
    $('#acct-token-input').placeholder = accounts.token ? 'Paste a different token to replace it' : 'Paste a token from claude setup-token, or a Console API key';
  }
  acctModal.querySelectorAll('.account-card').forEach((card) => card.addEventListener('click', async () => {
    const which = card.dataset.which;
    if (which === 'token' && !accounts?.token) { $('#acct-token-input').focus(); return; }
    try { await api('/accounts/active', { method: 'POST', body: JSON.stringify({ which }) }); localStorage.setItem('cr.accountChosen', '1'); acctModal.classList.add('hidden'); await refreshMe(); }
    catch (e) { $('#acct-error').hidden = false; $('#acct-error').textContent = e.message; }
  }));
  $('#acct-token-add').addEventListener('click', async () => {
    const token = $('#acct-token-input').value.trim(); if (!token) return $('#acct-token-input').focus();
    const btn = $('#acct-token-add'); btn.classList.add('busy'); btn.textContent = 'Checking…'; $('#acct-error').hidden = true;
    try { await api('/accounts/token', { method: 'POST', body: JSON.stringify({ token }) }); $('#acct-token-input').value = ''; localStorage.setItem('cr.accountChosen', '1'); accounts = await api('/accounts'); renderAccounts(); await refreshMe(); }
    catch (e) { $('#acct-error').hidden = false; $('#acct-error').textContent = e.message; }
    finally { btn.classList.remove('busy'); btn.textContent = 'Add'; }
  });
  $('#acct-token-remove').addEventListener('click', async () => {
    try { await api('/accounts/token', { method: 'DELETE' }); accounts = await api('/accounts'); renderAccounts(); await refreshMe(); }
    catch (e) { $('#acct-error').hidden = false; $('#acct-error').textContent = e.message; }
  });
  $('#account-close').addEventListener('click', () => { acctModal.classList.add('hidden'); localStorage.setItem('cr.accountChosen', '1'); });
  acctModal.addEventListener('click', (e) => { if (e.target === acctModal) { acctModal.classList.add('hidden'); localStorage.setItem('cr.accountChosen', '1'); } });
  $('#switch-account').addEventListener('click', openAccounts);
  $('#sidebar-user').addEventListener('click', openAccounts);

  async function refreshMe() {
    const me = await api('/me');
    state.userName = me.userName; state.host = me.host;
    const acc = me.account || {};
    $('#sidebar-name').textContent = me.userName;
    $('#sidebar-account').innerHTML = '';
    $('#sidebar-account').appendChild(document.createTextNode(acc.email || (acc.auth === 'oauth_token' ? 'Token account' : acc.loggedIn === false ? 'Not signed in' : 'Signed in')));
    if (acc.plan) { $('#sidebar-account').appendChild(document.createTextNode(' · ')); $('#sidebar-account').appendChild(el('span', 'plan', acc.plan)); }
    $('#sidebar-host').textContent = (me.active === 'token' ? 'Token' : 'This computer') + ' · ' + me.host;
    $('#sidebar-user').title = 'Click to switch account\n' + [acc.name, acc.email, acc.org, acc.plan && 'Plan: ' + acc.plan, 'Auth: ' + (acc.auth || '?'), 'Source: ' + (acc.source || '?'), acc.projectsDir && 'Sessions: ' + acc.projectsDir].filter(Boolean).join('\n');
    $('#sidebar-avatar').textContent = (me.userName || 'U')[0].toUpperCase(); $('#foot-host').textContent = me.host;
    return me;
  }

  // ---------- sidebar ----------
  const app = $('#app');
  $('#sidebar-open').addEventListener('click', () => app.classList.add('sidebar-open'));
  $('#sidebar-close').addEventListener('click', () => app.classList.remove('sidebar-open'));
  $('#scrim').addEventListener('click', () => app.classList.remove('sidebar-open'));

  function relTime(ms) {
    const d = Date.now() - ms, m = Math.round(d / 60000), h = Math.round(m / 60), dd = Math.round(h / 24);
    if (m < 1) return 'now'; if (m < 60) return m + 'm'; if (h < 24) return h + 'h'; if (dd < 7) return dd + 'd';
    return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  async function loadSessions() {
    state.sessions = await api('/sessions?limit=200');
    renderSessions();
  }
  let collapsed = new Set();
  try { collapsed = new Set(JSON.parse(localStorage.getItem('cr.collapsed') || '[]')); } catch {}
  const PIN_SVG = '<svg viewBox="0 0 20 20" width="14" height="14"><path d="M12.5 2.5l5 5-2.2.7-3.1 3.1.4 3.6-1.4 1.4L8 13.1l-4.6 4.6-.7-.7L7.3 12.4 4.1 9.2l1.4-1.4 3.6.4 3.1-3.1z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>';
  const CHEV_SVG = '<svg class="chev" viewBox="0 0 20 20" width="12" height="12"><path d="M5 8l5 5 5-5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';

  function sessionRow(s) {
    const a = el('a', 'session-item' + (s.id === state.current ? ' active' : '') + (s.pinned ? ' pinned' : ''));
    a.href = '#/s/' + s.id; a.title = s.title;
    if (s.live || s.working) { const d = el('span', 'dot'); d.title = s.live ? 'Working (started here)' : 'Working in another window'; a.appendChild(d); }
    const t = el('span', 't', s.title); t.dir = 'auto'; a.appendChild(t);
    a.appendChild(el('span', 'muted small', relTime(s.lastModified)));
    const pin = el('button', 'pin'); pin.type = 'button'; pin.title = s.pinned ? 'Unpin' : 'Pin'; pin.innerHTML = PIN_SVG;
    pin.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); togglePin(s.id, !s.pinned); });
    a.appendChild(pin);
    return a;
  }
  function renderSessions() {
    const list = $('#session-list'); list.innerHTML = '';
    const pinned = state.sessions.filter((s) => s.pinned);
    if (pinned.length) {
      const g = el('details', 'project-group'); g.open = !collapsed.has('__pinned');
      const sm = el('summary'); sm.innerHTML = CHEV_SVG; sm.appendChild(el('span', null, 'Pinned')); sm.appendChild(el('span', 'cnt', String(pinned.length))); g.appendChild(sm);
      for (const s of pinned) g.appendChild(sessionRow(s));
      g.addEventListener('toggle', () => rememberCollapsed('__pinned', !g.open));
      list.appendChild(g);
    }
    const groups = new Map();
    for (const s of state.sessions) { const k = s.project || 'Other'; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(s); }
    for (const [name, items] of groups) {
      const g = el('details', 'project-group'); g.open = !collapsed.has(name);
      const sm = el('summary'); sm.innerHTML = CHEV_SVG; sm.appendChild(el('span', null, name)); sm.appendChild(el('span', 'cnt', String(items.length)));
      sm.title = items[0].cwd; g.appendChild(sm);
      for (const s of items) g.appendChild(sessionRow(s));
      g.addEventListener('toggle', () => rememberCollapsed(name, !g.open));
      list.appendChild(g);
    }
    if (!state.sessions.length) list.appendChild(el('div', 'muted small pad', 'No sessions yet.'));
    updatePinButton();
  }
  function rememberCollapsed(name, isCollapsed) {
    if (isCollapsed) collapsed.add(name); else collapsed.delete(name);
    try { localStorage.setItem('cr.collapsed', JSON.stringify([...collapsed])); } catch {}
  }
  async function togglePin(id, pinned) {
    const s = state.sessions.find((x) => x.id === id); if (s) s.pinned = pinned;
    renderSessions();
    try { await api(`/sessions/${id}/pin`, { method: 'POST', body: JSON.stringify({ pinned }) }); } catch (e) { if (s) s.pinned = !pinned; renderSessions(); }
  }
  function updatePinButton() {
    const b = $('#pin-btn'); const s = state.sessions.find((x) => x.id === state.current);
    b.classList.toggle('hidden', !state.current);
    b.classList.toggle('on', !!s?.pinned); b.title = s?.pinned ? 'Unpin' : 'Pin';
  }
  $('#pin-btn').addEventListener('click', () => { const s = state.sessions.find((x) => x.id === state.current); if (state.current) togglePin(state.current, !s?.pinned); });

  // ---------- projects (for new chats) ----------
  async function loadProjects() {
    state.projects = await api('/projects');
    if (!state.cwd && state.projects[0]) state.cwd = state.projects[0].cwd;
    renderProjectChip();
  }
  function renderProjectChip() {
    const p = state.projects.find((x) => x.cwd === state.cwd);
    $('#project-name').textContent = p ? p.name : (state.cwd ? state.cwd.split(/[\\/]/).pop() : 'Pick a folder');
  }
  const menu = $('#project-menu');
  $('#project-btn').addEventListener('click', (e) => { e.stopPropagation(); menu.classList.toggle('hidden'); if (!menu.classList.contains('hidden')) renderProjectMenu(); });
  document.addEventListener('click', (e) => { if (!menu.contains(e.target)) menu.classList.add('hidden'); });
  function renderProjectMenu() {
    menu.innerHTML = '';
    for (const p of state.projects) {
      const b = el('button', 'menu-item'); b.type = 'button';
      b.appendChild(document.createTextNode(p.name)); b.appendChild(el('small', null, p.cwd));
      b.addEventListener('click', () => { state.cwd = p.cwd; localStorage.setItem('cr.cwd', p.cwd); renderProjectChip(); menu.classList.add('hidden'); });
      menu.appendChild(b);
    }
    menu.appendChild(el('div', 'menu-sep'));
    const c = el('div', 'menu-item custom');
    const inp = el('input'); inp.placeholder = 'C:\\path\\to\\folder'; inp.value = '';
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { state.cwd = inp.value.trim(); localStorage.setItem('cr.cwd', state.cwd); renderProjectChip(); menu.classList.add('hidden'); } });
    inp.addEventListener('click', (e) => e.stopPropagation());
    c.appendChild(inp); menu.appendChild(c);
  }

  // ---------- model / permission mode ----------
  const MODELS = [
    { id: 'claude-fable-5-1', name: 'Claude Fable 5.1', desc: 'Most capable' },
    { id: 'claude-opus-5', name: 'Claude Opus 5', desc: 'Strong, slower' },
    { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', desc: 'Fast and capable' },
    { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', desc: 'Fastest, cheapest' },
  ];
  const EFFORTS = [{ id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium' }, { id: 'high', name: 'High' }];
  // Same labels and order as the Claude Desktop mode picker.
  const MODES = [
    { id: 'default', name: 'Manual', desc: 'Ask before file edits and shell commands' },
    { id: 'acceptEdits', name: 'Edit automatically', desc: 'Edit files without asking; still ask before other commands' },
    { id: 'plan', name: 'Plan', desc: 'Propose an approach without editing source code' },
    { id: 'auto', name: 'Auto', desc: 'Run with background safety checks; ask only for risky actions' },
  ];
  state.model = localStorage.getItem('cr.model') || MODELS[0].id;
  state.effort = localStorage.getItem('cr.effort') || '';
  state.mode = localStorage.getItem('cr.mode') || 'default';

  function menuFor(btnId, menuId, render) {
    const btn = $(btnId), m = $(menuId);
    btn.addEventListener('click', (e) => { e.stopPropagation(); const open = m.classList.contains('hidden'); document.querySelectorAll('.menu').forEach((x) => x.classList.add('hidden')); if (open) { render(m); m.classList.remove('hidden'); } });
    document.addEventListener('click', (e) => { if (!m.contains(e.target)) m.classList.add('hidden'); });
  }
  function item(label, desc, selected, onPick) {
    const b = el('button', 'menu-item' + (selected ? ' sel' : '')); b.type = 'button';
    b.appendChild(document.createTextNode(label)); if (desc) b.appendChild(el('span', 'desc', desc));
    b.addEventListener('click', onPick); return b;
  }
  function renderModelChip() {
    const mdl = MODELS.find((x) => x.id === state.model) || MODELS[0];
    $('#model-label').textContent = mdl.name + (state.effort ? ' · ' + state.effort : '');
  }
  function renderModeChip() { $('#mode-name').textContent = (MODES.find((x) => x.id === state.mode) || MODES[0]).name; }
  // A change made while Claude is working is pushed to the running process and
  // takes effect for the next tool call / model request, like Shift+Tab in the CLI.
  async function pushControls(patch) {
    if (!state.current || !state.running) return;
    try { await api(`/sessions/${state.current}/controls`, { method: 'POST', body: JSON.stringify(patch) }); }
    catch (e) { thread.appendChild(el('div', 'note error', e.message)); }
  }
  menuFor('#model-btn', '#model-menu', function render(m) {
    m.innerHTML = '';
    for (const x of MODELS) m.appendChild(item(x.name, x.desc, x.id === state.model, () => { state.model = x.id; localStorage.setItem('cr.model', x.id); renderModelChip(); m.classList.add('hidden'); pushControls({ model: x.id }); }));
    m.appendChild(el('div', 'menu-sep'));
    const row = el('div', 'seg-row'); row.appendChild(el('span', null, 'Effort'));
    const seg = el('div', 'seg');
    for (const x of [{ id: '', name: 'Auto' }, ...EFFORTS]) {
      const b = el('button', x.id === state.effort ? 'on' : '', x.name); b.type = 'button';
      b.addEventListener('click', (e) => { e.stopPropagation(); state.effort = x.id; if (x.id) localStorage.setItem('cr.effort', x.id); else localStorage.removeItem('cr.effort'); renderModelChip(); render(m); pushControls({ effort: x.id }); });
      seg.appendChild(b);
    }
    row.appendChild(seg); m.appendChild(row);
  });
  menuFor('#mode-btn', '#mode-menu', (m) => {
    m.innerHTML = ''; m.appendChild(el('div', 'menu-title', 'Permissions'));
    for (const x of MODES) m.appendChild(item(x.name, x.desc, x.id === state.mode, () => { state.mode = x.id; localStorage.setItem('cr.mode', x.id); renderModeChip(); m.classList.add('hidden'); pushControls({ permissionMode: x.id }); }));
  });
  // Shift+Tab cycles the mode, as in the CLI and Desktop.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Tab' && e.shiftKey && !$('#app').classList.contains('hidden')) {
      e.preventDefault();
      const i = MODES.findIndex((x) => x.id === state.mode);
      state.mode = MODES[(i + 1) % MODES.length].id; localStorage.setItem('cr.mode', state.mode); renderModeChip(); pushControls({ permissionMode: state.mode });
    }
  });
  renderModelChip(); renderModeChip();
  const turnOptions = () => ({ model: state.model, permissionMode: state.mode, ...(state.effort ? { effort: state.effort } : {}) });

  // ---------- thread rendering ----------
  const thread = $('#thread'), scroll = $('#scroll'), empty = $('#empty');
  let stickToBottom = true;
  scroll.addEventListener('scroll', () => { stickToBottom = scroll.scrollTop + scroll.clientHeight > scroll.scrollHeight - 80; });
  const autoscroll = () => { if (stickToBottom) scroll.scrollTop = scroll.scrollHeight; };

  function toolSummary(name, input) {
    if (!input || typeof input !== 'object') return '';
    return String(input.command || input.file_path || input.pattern || input.path || input.description || input.url || input.query || input.prompt || input.skill || '').split('\n')[0].slice(0, 200);
  }
  function stepEl(kind, name, arg) {
    const d = el('details', 'step ' + kind);
    const s = el('summary');
    s.appendChild(el('span', 'name', name));
    s.appendChild(el('span', 'arg', arg || ''));
    const ch = el('span', 'chev'); ch.innerHTML = '<svg viewBox="0 0 20 20" width="12" height="12"><path d="M5 8l5 5 5-5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
    s.appendChild(ch); d.appendChild(s);
    d.appendChild(el('div', 'step-body'));
    return d;
  }
  function resultText(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.map((b) => b.type === 'text' ? b.text : `[${b.type}]`).join('\n');
    return JSON.stringify(content, null, 2);
  }

  // A message element for one assistant API message (text + thinking + tool_use blocks).
  function assistantMsg() {
    const m = el('div', 'msg assistant');
    const av = el('div', 'msg-avatar', '✱'); m.appendChild(av);
    const body = el('div', 'msg-body'); m.appendChild(body);
    return { root: m, body, blocks: new Map(), tools: new Map() };
  }
  function renderBlock(msg, index, block) {
    let node = msg.blocks.get(index);
    if (block.type === 'text') {
      if (!node) { node = el('div', 'prose'); node.dir = 'auto'; msg.body.appendChild(node); msg.blocks.set(index, node); }
      node.innerHTML = md(block.text);
    } else if (block.type === 'thinking') {
      if (!node) { node = stepEl('thinking', 'Thought', ''); msg.body.appendChild(node); msg.blocks.set(index, node); }
      node.querySelector('.step-body').textContent = block.thinking || '';
      if (!block.thinking && !block.live) node.classList.add('hidden'); else node.classList.remove('hidden');
      if (block.live) { node.open = true; node.classList.add('live'); node.querySelector('.name').textContent = 'Thinking'; }
    } else if (block.type === 'tool_use') {
      if (!node) { node = stepEl('tool', block.name, ''); node._toolId = block.id; msg.body.appendChild(node); msg.blocks.set(index, node); msg.tools.set(block.id, node); }
      node.querySelector('.arg').textContent = toolSummary(block.name, block.input);
      const b = node.querySelector('.step-body'); b.innerHTML = '';
      b.appendChild(el('div', 'label', 'Input'));
      const pre = el('pre', null, typeof block.input === 'string' ? block.input : JSON.stringify(block.input, null, 2)); b.appendChild(pre);
    }
  }
  function attachResult(toolNode, result) {
    if (!toolNode) return;
    const b = toolNode.querySelector('.step-body');
    b.appendChild(el('div', 'label', result.is_error ? 'Error' : 'Result'));
    b.appendChild(el('pre', null, resultText(result.content).slice(0, 20000)));
    if (result.is_error) toolNode.classList.add('error');
  }

  function userMsg(text, { queued = false, id = null } = {}) {
    const m = el('div', 'msg user' + (queued ? ' queued' : ''));
    if (id) m.dataset.promptId = id;
    m.appendChild(el('div', 'msg-avatar', (state.userName || 'U')[0].toUpperCase()));
    const b = el('div', 'msg-body', text); b.dir = 'auto'; m.appendChild(b);
    if (queued) m.appendChild(el('div', 'queued-label', 'Queued · sends when Claude finishes'));
    return m;
  }

  // ---------- live status line (the Desktop "✱ Thinking… 12s · 1.2k tokens" row) ----------
  const VERBS = ['Thinking', 'Pondering', 'Considering', 'Working', 'Reasoning', 'Composing', 'Sketching', 'Puzzling', 'Brewing', 'Cooking', 'Musing', 'Mulling'];
  const status = { el: null, verb: VERBS[0], tool: null, toolSince: 0, startedAt: 0, tokens: 0, waiting: false, timer: null, verbTimer: null };
  function statusStart() {
    if (!status.el) {
      status.el = el('div', 'status-line');
      status.el.innerHTML = '<span class="spark spin">✱</span><span class="shimmer"></span><span class="status-meta"></span>';
    }
    thread.appendChild(status.el);
    status.startedAt = status.startedAt || Date.now(); status.tokens = 0; status.tool = null; status.waiting = false;
    status.verb = VERBS[Math.floor(Math.random() * VERBS.length)];
    clearInterval(status.timer); status.timer = setInterval(statusPaint, 1000);
    clearInterval(status.verbTimer); status.verbTimer = setInterval(() => { if (!status.tool && !status.waiting) { status.verb = VERBS[Math.floor(Math.random() * VERBS.length)]; statusPaint(); } }, 6000);
    statusPaint();
  }
  function statusPaint() {
    if (!status.el) return;
    const secs = Math.max(0, Math.round((Date.now() - status.startedAt) / 1000));
    let text = status.verb + '…';
    if (status.waiting) text = 'Waiting for your approval';
    else if (status.tool) text = (status.tool === 'Bash' || status.tool === 'PowerShell' ? 'Running ' : status.tool === 'Read' || status.tool === 'Grep' || status.tool === 'Glob' ? 'Reading with ' : status.tool === 'Agent' ? 'Running agent ' : 'Using ') + status.tool + '…';
    status.el.querySelector('.shimmer').textContent = text;
    const tok = status.tokens >= 1000 ? (status.tokens / 1000).toFixed(1) + 'k' : String(status.tokens);
    status.el.querySelector('.status-meta').textContent = `${secs}s` + (status.tokens ? ` · ↓ ${tok} tokens` : '') + (status.tool && status.toolSince ? ` · ${Math.round((Date.now() - status.toolSince) / 1000)}s in tool` : '');
    if (!status.el.isConnected) thread.appendChild(status.el); else if (thread.lastElementChild !== status.el) thread.appendChild(status.el);
  }
  function statusStop() {
    clearInterval(status.timer); clearInterval(status.verbTimer); status.timer = status.verbTimer = null;
    status.el?.remove(); status.startedAt = 0; status.tool = null; status.waiting = false;
  }

  function renderHistory(messages) {
    thread.innerHTML = '';
    const toolNodes = new Map();
    let group = null; // the assistant row for the current turn
    for (const m of messages) {
      if (m.role === 'user') {
        const results = m.content.filter((b) => b.type === 'tool_result');
        for (const r of results) attachResult(toolNodes.get(r.tool_use_id), r);
        const text = m.content.filter((b) => b.type === 'text').map((b) => stripHarness(b.text)).filter(Boolean).join('\n\n');
        if (text) { thread.appendChild(userMsg(text)); group = null; }
      } else if (m.role === 'assistant') {
        // One assistant row per turn: consecutive assistant API messages share it, like claude.ai.
        if (!group) group = assistantMsg();
        let any = false;
        m.content.forEach((b, i) => {
          if (b.type === 'thinking' && !b.thinking) return;
          const key = m.uuid + ':' + i;
          renderBlock(group, key, b); any = true;
          if (b.type === 'tool_use') toolNodes.set(b.id, group.blocks.get(key));
        });
        if (any && !group.root.isConnected) thread.appendChild(group.root);
      }
    }
  }

  // ---------- live turn ----------
  function setRunning(on) {
    state.running = on;
    $('#live-pill').classList.toggle('hidden', !on && !state.elsewhere);
    if (on) { $('#live-pill').classList.remove('elsewhere'); $('#live-text').textContent = 'Working'; statusStart(); } else statusStop();
    $('#input').disabled = false;
    paintSendButton();
  }
  // While Claude works the button is Stop, unless there is text typed: then it sends (queues) it.
  function paintSendButton() {
    const hasText = !!$('#input').value.trim();
    $('#send').classList.toggle('running', state.running && !hasText);
    $('#send').title = state.running && !hasText ? 'Stop' : state.running ? 'Send (queued until Claude finishes)' : 'Send';
  }
  // Another window (VS Code, terminal, Claude Desktop) is mid-turn on this session.
  function setElsewhere(on) {
    state.elsewhere = on;
    if (state.running) return;
    $('#live-pill').classList.toggle('hidden', !on);
    $('#live-pill').classList.toggle('elsewhere', on);
    $('#live-text').textContent = on ? 'Working in another window' : 'Working';
    $('#composer').classList.toggle('locked', on);
    $('#send').disabled = on;
    input.placeholder = on ? 'Claude is working on this chat in another window…' : 'How can I help you today?';
  }

  function subscribe(sessionId, { since = -1 } = {}) {
    if (state.es) { state.es.close(); state.es = null; }
    const es = new EventSource(`/api/sessions/${sessionId}/events?token=${encodeURIComponent(state.token)}&since=${since}`);
    state.es = es;
    // partial blocks under construction, by index
    const partial = new Map();
    let msgNo = 0, mode = 'run';
    const key = (index) => msgNo + ':' + index;
    es.onmessage = (e) => {
      const ev = JSON.parse(e.data);
      if (ev.i != null) state.lastEventId = ev.i;
      switch (ev.t) {
        case 'idle': setRunning(false); es.close(); break;
        case 'tail': mode = 'tail'; setRunning(false); setElsewhere(!!ev.working); break;
        case 'working': setElsewhere(!!ev.on); if (!ev.on) loadSessions().catch(() => {}); break;
        case 'user_text': {
          const text = stripHarness(ev.text); if (!text) break;
          state.live = null; thread.appendChild(userMsg(text)); autoscroll(); break;
        }
        case 'mode': break;
        case 'queued': {
          if (ev.id && thread.querySelector(`[data-prompt-id="${ev.id}"]`)) break;
          // our own ghost bubble, posted a moment ago and not yet tagged with its id
          const mine = [...thread.querySelectorAll('.msg.user.queued:not([data-prompt-id])')].find((n) => n.querySelector('.msg-body').textContent === ev.text);
          if (mine) { mine.dataset.promptId = ev.id; break; }
          thread.appendChild(userMsg(ev.text, { queued: true, id: ev.id })); autoscroll(); break;
        }
        case 'prompt': {
          state.live = null;
          const q = ev.id && thread.querySelector(`[data-prompt-id="${ev.id}"]`);
          if (q) { q.classList.remove('queued'); q.querySelector('.queued-label')?.remove(); }
          else thread.appendChild(userMsg(ev.text, { id: ev.id }));
          if (state.running) { status.startedAt = Date.now(); statusStart(); }
          autoscroll(); break;
        }
        case 'init':
          mode = 'run'; setRunning(true);
          if (ev.controls) { if (ev.controls.permissionMode) state.mode = ev.controls.permissionMode; if (ev.controls.model) state.model = ev.controls.model; state.effort = ev.controls.effort || ''; renderModeChip(); renderModelChip(); }
          break;
        case 'controls':
          if (ev.permissionMode) state.mode = ev.permissionMode; if (ev.model) state.model = ev.model; if (ev.effort !== undefined) state.effort = ev.effort;
          renderModeChip(); renderModelChip(); break;
        case 'status': if (ev.permissionMode) { state.mode = ev.permissionMode; renderModeChip(); } break;
        case 'tool_progress': status.tool = ev.tool; if (!status.toolSince) status.toolSince = Date.now() - (ev.elapsed || 0) * 1000; statusPaint(); break;
        case 'usage': if (ev.outputTokens) { status.tokens = ev.outputTokens; statusPaint(); } break;
        case 'tool_summary': break;
        case 'task': if (ev.summary || ev.description) thread.appendChild(el('div', 'note', (ev.kind === 'task_started' ? 'Started: ' : '') + (ev.summary || ev.description))); statusPaint(); break;
        case 'note': thread.appendChild(el('div', 'note', ev.text)); statusPaint(); break;
        // One assistant row for the whole turn; each API message gets its own key space.
        case 'msg_start':
          msgNo += 1; partial.clear();
          if (!state.live) { state.live = assistantMsg(); thread.appendChild(state.live.root); }
          break;
        case 'block_start':
          if (!state.live) { state.live = assistantMsg(); thread.appendChild(state.live.root); }
          partial.set(ev.index, { type: ev.block.type, name: ev.block.name, id: ev.block.id, text: '', thinking: '', json: '', since: Date.now() });
          if (ev.block.type === 'tool_use') { renderBlock(state.live, key(ev.index), { type: 'tool_use', name: ev.block.name, id: ev.block.id, input: {} }); status.tool = ev.block.name; status.toolSince = 0; }
          if (ev.block.type === 'thinking') { renderBlock(state.live, key(ev.index), { type: 'thinking', thinking: '', live: true }); status.verb = 'Thinking'; }
          if (ev.block.type === 'text') { status.tool = null; status.verb = 'Writing'; }
          statusPaint(); autoscroll();
          break;
        case 'delta': {
          const p = partial.get(ev.index); if (!p || !state.live) break;
          if (ev.kind === 'text_delta') { p.text += ev.text; renderBlock(state.live, key(ev.index), { type: 'text', text: p.text }); state.live.blocks.get(key(ev.index))?.classList.add('cursor'); }
          else if (ev.kind === 'thinking_delta') { p.thinking += ev.text; renderBlock(state.live, key(ev.index), { type: 'thinking', thinking: p.thinking, live: true }); }
          else if (ev.kind === 'input_json_delta') { p.json += ev.text; const n = state.live.blocks.get(key(ev.index)); if (n) n.querySelector('.arg').textContent = p.json.slice(0, 200); }
          autoscroll(); break;
        }
        case 'block_stop': {
          const n = state.live?.blocks.get(key(ev.index)); n?.classList.remove('cursor');
          const p = partial.get(ev.index);
          if (n && p?.type === 'thinking') { n.open = false; n.classList.remove('live'); n.querySelector('.name').textContent = 'Thought for ' + Math.max(1, Math.round((Date.now() - p.since) / 1000)) + 's'; if (!p.thinking) n.classList.add('hidden'); }
          break;
        }
        case 'assistant':
          // final blocks for the message being streamed: re-render with full data
          if (!state.live) { state.live = assistantMsg(); thread.appendChild(state.live.root); }
          if (ev.tail) {
            // From the transcript file: one finished block per line, keyed by its uuid.
            ev.content.forEach((b, i) => { if (b.type === 'thinking' && !b.thinking) return; renderBlock(state.live, ev.uuid + ':' + i, b); });
            autoscroll(); break;
          }
          // The SDK emits one `assistant` message per finished block, so its content index is not
          // the stream index. Match tool blocks by id and text/thinking blocks by the latest
          // streamed block of that type.
          for (const b of ev.content) {
            if (b.type === 'thinking' && !b.thinking) continue;
            let k = null;
            if (b.type === 'tool_use') { for (const [kk, n] of state.live.blocks) if (n._toolId === b.id) k = kk; }
            else { for (const [idx, p] of partial) if (p.type === b.type) k = key(idx); }
            renderBlock(state.live, k ?? key('final:' + b.type + ':' + (b.id || msgNo)), b);
          }
          autoscroll(); break;
        case 'tool_results':
          for (const r of ev.content) attachResult(findTool(r.tool_use_id), r);
          status.tool = null; status.toolSince = 0; statusPaint();
          autoscroll(); break;
        case 'permission': showPermission(ev); status.waiting = true; statusPaint(); autoscroll(); break;
        case 'permission_resolved': resolvePermissionCard(ev.reqId, ev.behavior); status.waiting = false; statusPaint(); break;
        case 'result':
          if (ev.isError) thread.appendChild(el('div', 'note error', ev.text));
          state.live = null; statusStop();
          break;
        case 'error': thread.appendChild(el('div', 'note error', ev.text)); break;
        case 'stderr': console.warn('[claude]', ev.text); break;
        case 'done':
          setRunning(false); state.live = null; es.close(); loadSessions();
          // keep watching the file in case another window continues this chat
          if (state.current === sessionId) setTimeout(() => { if (state.current === sessionId && !state.running) subscribe(sessionId); }, 500);
          break;
      }
    };
    es.onerror = () => { /* EventSource retries by itself with Last-Event-ID */ };
  }
  function findTool(id) {
    for (const d of thread.querySelectorAll('details.step.tool')) if (d._toolId === id) return d;
    return state.live?.tools.get(id) || null;
  }
  function prettyModel(m) {
    if (!m) return 'Claude';
    const map = { 'claude-fable-5-1': 'Claude Fable 5.1', 'claude-opus-5': 'Claude Opus 5', 'claude-sonnet-5': 'Claude Sonnet 5' };
    return map[m] || m.replace(/^claude-/, 'Claude ').replace(/-(\d)-(\d)/, ' $1.$2');
  }

  function showPermission(ev) {
    const t = $('#tpl-permission').content.firstElementChild.cloneNode(true);
    t.dataset.reqId = ev.reqId;
    t.querySelector('.perm-tool').textContent = ev.tool;
    t.querySelector('.perm-summary').textContent = ev.summary || '(no summary)';
    t.querySelector('.perm-input').textContent = JSON.stringify(ev.input, null, 2);
    if (!ev.canAlways) t.querySelector('[data-act="always"]').remove();
    t.querySelectorAll('button[data-act]').forEach((b) => b.addEventListener('click', async () => {
      const act = b.dataset.act;
      t.querySelectorAll('button').forEach((x) => x.disabled = true);
      try { await api('/permissions/' + ev.reqId, { method: 'POST', body: JSON.stringify({ behavior: act === 'deny' ? 'deny' : 'allow', always: act === 'always' }) }); }
      catch (e) { t.querySelector('.perm-result').textContent = e.message; t.querySelector('.perm-result').classList.remove('hidden'); }
    }));
    thread.appendChild(t);
  }
  function resolvePermissionCard(reqId, behavior) {
    const card = thread.querySelector(`.permission[data-req-id="${reqId}"]`); if (!card) return;
    card.querySelector('.permission-actions').remove();
    const r = card.querySelector('.perm-result'); r.textContent = behavior === 'allow' ? 'Allowed' : 'Denied'; r.classList.remove('hidden');
  }

  // ---------- composer ----------
  const input = $('#input'), send = $('#send');
  // Unsent text survives a refresh, per chat.
  const draftKey = (id) => 'cr.draft.' + (id || 'new');
  function restoreDraft(id) {
    let v = ''; try { v = localStorage.getItem(draftKey(id)) || ''; } catch {}
    input.value = v; input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, window.innerHeight * 0.4) + 'px';
  }
  input.addEventListener('input', () => {
    input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, window.innerHeight * 0.4) + 'px';
    try { if (input.value) localStorage.setItem(draftKey(state.current), input.value); else localStorage.removeItem(draftKey(state.current)); } catch {}
    paintSendButton();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && window.matchMedia('(min-width: 861px)').matches) { e.preventDefault(); submit(); }
    if (e.key === 'Escape' && state.running) { e.preventDefault(); stop(); }
  });
  send.addEventListener('click', () => { if (state.running && !input.value.trim()) stop(); else submit(); });

  async function submit() {
    const text = input.value.trim(); if (!text) return;
    input.value = ''; input.style.height = 'auto'; try { localStorage.removeItem(draftKey(state.current)); } catch {}
    empty.classList.remove('show'); stickToBottom = true;
    // Claude is mid-turn on this chat: the message is queued and runs right after, like Desktop.
    if (state.running && state.current) {
      const ghost = userMsg(text, { queued: true }); thread.appendChild(ghost); statusPaint(); autoscroll(); paintSendButton();
      try { const r = await api(`/sessions/${state.current}/send`, { method: 'POST', body: JSON.stringify({ text }) }); if (r.id) ghost.dataset.promptId = r.id; }
      catch (e) { ghost.remove(); thread.appendChild(el('div', 'note error', e.message)); }
      return;
    }
    thread.appendChild(userMsg(text)); autoscroll();
    setRunning(true);
    try {
      if (state.current) {
        await api(`/sessions/${state.current}/send`, { method: 'POST', body: JSON.stringify({ text, ...turnOptions() }) });
        subscribe(state.current, { since: 0 }); // event 0 is our own prompt, already on screen
      } else {
        if (!state.cwd) throw new Error('Pick a folder first.');
        const r = await api('/sessions', { method: 'POST', body: JSON.stringify({ text, cwd: state.cwd, ...turnOptions() }) });
        state.current = r.sessionId;
        history.replaceState(null, '', '#/s/' + r.sessionId);
        $('#chat-title').textContent = text.slice(0, 60);
        $('#chat-meta').textContent = state.cwd.split(/[\\/]/).pop();
        $('#project-btn').classList.add('locked');
        subscribe(r.sessionId, { since: 0 });
      }
    } catch (e) {
      thread.appendChild(el('div', 'note error', e.message)); setRunning(false);
    }
  }
  async function stop() { if (state.current) await api(`/sessions/${state.current}/stop`, { method: 'POST' }); }

  // ---------- routing ----------
  async function openSession(id) {
    state.current = id; state.live = null;
    if (state.es) { state.es.close(); state.es = null; }
    app.classList.remove('sidebar-open');
    empty.classList.remove('show'); thread.innerHTML = '<div class="muted small pad">Loading…</div>';
    renderSessions();
    try {
      const info = await api('/sessions/' + id);
      // A turn started here and still running is replayed by the live stream from
      // its prompt onwards, so the history stops just before it.
      const messages = await api(`/sessions/${id}/messages` + (info.live && info.runStartedAt ? '?before=' + info.runStartedAt : ''));
      $('#chat-title').textContent = info.title;
      $('#chat-meta').textContent = [info.project, info.branch].filter(Boolean).join(' · ');
      state.cwd = info.cwd || state.cwd; renderProjectChip(); $('#project-btn').classList.add('locked');
      renderHistory(messages);
      stickToBottom = true; scroll.scrollTop = scroll.scrollHeight;
      setRunning(false); setElsewhere(false);
      subscribe(id); // streams our own turn, or follows the file if another window is working
      restoreDraft(id);
    } catch (e) { thread.innerHTML = ''; thread.appendChild(el('div', 'note error', e.message)); }
    input.focus();
  }
  function openNew() {
    state.current = null; state.live = null;
    if (state.es) { state.es.close(); state.es = null; }
    app.classList.remove('sidebar-open');
    thread.innerHTML = ''; empty.classList.add('show');
    $('#chat-title').textContent = 'New chat'; $('#chat-meta').textContent = '';
    $('#project-btn').classList.remove('locked'); renderProjectChip();
    setRunning(false); setElsewhere(false); renderSessions(); updatePinButton(); restoreDraft(null);
    const h = new Date().getHours();
    $('#greeting-text').textContent = (h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening') + (state.userName ? ', ' + state.userName : '');
    input.focus();
  }
  function route() {
    const m = location.hash.match(/^#\/s\/([0-9a-f-]{36})$/i);
    if (m) openSession(m[1]); else openNew();
  }
  window.addEventListener('hashchange', route);

  // ---------- boot ----------
  async function boot() {
    // No app password configured? Then no login screen: just fetch the session token.
    if (!state.token) {
      let cfg = {};
      try { cfg = await (await fetch('/api/config')).json(); } catch {}
      if (cfg.passwordRequired) return showLogin();
      try { await login(''); } catch { return showLogin(); }
    }
    let me;
    try { me = await refreshMe(); } catch { return; }
    $('#login').classList.add('hidden'); $('#app').classList.remove('hidden');
    await Promise.all([loadSessions(), loadProjects()]);
    route();
    // First time on this device: ask which account to use (local or token).
    let chosen = false; try { chosen = !!localStorage.getItem('cr.accountChosen'); } catch {}
    if (!chosen && !me.hasToken) openAccounts();
    setInterval(() => { if (!document.hidden) loadSessions().catch(() => {}); }, 10000);
    // Coming back after the screen was off: rebuild the open chat from disk and reattach.
    let hiddenAt = 0;
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { hiddenAt = Date.now(); return; }
      if (state.current && !state.running && Date.now() - hiddenAt > 15000) openSession(state.current);
      else loadSessions().catch(() => {});
    });
  }
  boot();
})();
