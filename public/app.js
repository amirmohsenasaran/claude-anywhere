/* claude-anywhere client. Plain JS, no build step. */
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
  // Images in an answer that point at files on the PC (`![card](out/share.png)`,
  // `C:\...\shot.png`) are fetched through the server, so they show like in Desktop.
  const localFileUrl = (href) => `/api/file?token=${encodeURIComponent(state.token || '')}&cwd=${encodeURIComponent(state.cwd || '')}&path=${encodeURIComponent(href)}`;
  const isWebUrl = (h) => /^(https?:|data:|blob:)/i.test(h || '');
  const escapeAttr = (s) => String(s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const isVideo = (h) => /\.(mp4|webm|mov|m4v)(\?|#|$)/i.test(h || ''), isAudio = (h) => /\.(mp3|m4a|wav|ogg)(\?|#|$)/i.test(h || '');
  const mediaSrc = (href) => isWebUrl(href) ? href : localFileUrl(href.replace(/^file:\/\/\/?/i, ''));
  // Video and audio files an answer points at play inline (Desktop shows a player); images show as images.
  // A video sits in a rounded frame with one big play button, like Desktop; the native
  // controls appear once it plays.
  const videoHtml = (src) => `<div class="video-frame"><video preload="metadata" playsinline class="md-video" src="${escapeAttr(src)}"></video><button type="button" class="video-play" aria-label="Play"><svg viewBox="0 0 24 24" width="26" height="26"><path d="M8 5.5v13l11-6.5z" fill="currentColor"/></svg></button></div>`;
  function videoEl(src) { const t = document.createElement('template'); t.innerHTML = videoHtml(src); return t.content.firstElementChild; }
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.video-play'); if (!btn) return;
    const v = btn.parentElement.querySelector('video'); if (!v) return;
    v.controls = true; btn.parentElement.classList.add('playing'); v.play().catch(() => {});
  });
  document.addEventListener('pause', (e) => { if (e.target.tagName === 'VIDEO' && e.target.ended) e.target.parentElement?.classList.remove('playing'); }, true);
  marked.use({ renderer: {
    image({ href, title, text }) {
      if (isVideo(href)) return videoHtml(mediaSrc(href));
      if (isAudio(href)) return `<audio controls class="md-audio" src="${escapeAttr(mediaSrc(href))}"></audio>`;
      return `<img src="${escapeAttr(mediaSrc(href))}" alt="${escapeAttr(text)}"${title ? ` title="${escapeAttr(title)}"` : ''} loading="lazy" class="md-img">`;
    },
    link({ href, title, tokens }) {
      const inner = this.parser.parseInline(tokens);
      if (isVideo(href)) return videoHtml(mediaSrc(href));
      if (isAudio(href)) return `<audio controls class="md-audio" src="${escapeAttr(mediaSrc(href))}"></audio>`;
      return `<a href="${escapeAttr(href)}"${title ? ` title="${escapeAttr(title)}"` : ''} target="_blank" rel="noopener">${inner}</a>`;
    },
  } });
  const md = (text) => DOMPurify.sanitize(marked.parse(text || ''), { USE_PROFILES: { html: true, svg: true }, ADD_TAGS: ['video', 'audio', 'button', 'svg', 'path'], ADD_ATTR: ['loading', 'controls', 'preload', 'target', 'playsinline', 'aria-label', 'viewBox', 'fill', 'd'] });
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
    $('#acct-token-desc').textContent = accounts.token ? describe(accounts.token) + ' · paste a new token below to replace it' : 'Not added yet';
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

  // Right-click on a session row: the Desktop context menu.
  const ctx = $('#ctx-menu');
  function showCtxMenu(s, x, y, kind = 'session', group = null) {
    ctx.innerHTML = '';
    const add = (label, hint, fn, cls) => { const b = item(label, '', false, () => { ctx.classList.add('hidden'); fn(); }, { hint }); if (cls) b.classList.add(cls); ctx.appendChild(b); };
    add('Open', '', () => { location.hash = '#/s/' + s.id; });
    ctx.appendChild(el('div', 'menu-sep'));
    const gk = group || groupKey(s); const lk = kind === 'pinned' ? 'pinned' : 'session';
    add('Move up', '', () => nudge(lk, gk, s.id, -1));
    add('Move down', '', () => nudge(lk, gk, s.id, 1));
    ctx.appendChild(el('div', 'menu-sep'));
    add(s.unread || s.failed ? 'Mark as read' : 'Mark as unread', '', async () => { try { await api(`/sessions/${s.id}/${s.unread || s.failed ? 'read' : 'unread'}`, { method: 'POST' }); loadSessions(); } catch {} });
    add(s.pinned ? 'Unpin' : 'Pin', 'P', () => togglePin(s.id, !s.pinned));
    add('Rename', 'R', async () => { const t = prompt('Session name', s.title || ''); if (t && t.trim()) { try { await api(`/sessions/${s.id}/rename`, { method: 'POST', body: JSON.stringify({ title: t.trim() }) }); if (state.current === s.id) $('#chat-title').textContent = t.trim(); loadSessions(); } catch (e) { alert(e.message); } } });
    add('Fork', 'F', async () => { try { const r = await api(`/sessions/${s.id}/fork`, { method: 'POST', body: JSON.stringify({}) }); await loadSessions(); location.hash = '#/s/' + r.sessionId; } catch (e) { alert(e.message); } });
    ctx.appendChild(el('div', 'menu-sep'));
    add(s.archived ? 'Unarchive' : 'Archive', 'A', async () => { try { await api(`/sessions/${s.id}/archive`, { method: 'POST', body: JSON.stringify({ archived: !s.archived }) }); await loadSessions(); if (state.current === s.id && !s.archived) location.hash = '#/'; } catch (e) { alert(e.message); } });
    add('Delete', 'D', async () => { if (!confirm(`Delete "${s.title}" from this computer? This cannot be undone.`)) return; try { await api(`/sessions/${s.id}`, { method: 'DELETE' }); await loadSessions(); if (state.current === s.id) location.hash = '#/'; } catch (e) { alert(e.message); } }, 'danger');
    ctx.classList.remove('hidden');
    if (window.matchMedia('(max-width: 860px)').matches) { ctx.style.left = ctx.style.top = ''; return; } // a bottom sheet on the phone
    const r = ctx.getBoundingClientRect();
    ctx.style.left = Math.min(x, window.innerWidth - r.width - 8) + 'px'; ctx.style.top = Math.min(y, window.innerHeight - r.height - 8) + 'px';
  }
  document.addEventListener('click', (e) => { if (!ctx.contains(e.target)) ctx.classList.add('hidden'); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') ctx.classList.add('hidden'); });

  function sessionRow(s, kind = 'session', group = null) {
    const onBranch = s.branch && !/^(main|master)$/i.test(s.branch);
    const attn = s.needsInput ? 'needs-input' : s.failed ? 'failed' : s.unread ? 'unread' : '';
    const a = el('a', 'session-item' + (s.id === state.current ? ' active' : '') + (s.pinned ? ' pinned' : '') + (onBranch ? ' on-branch' : '') + (s.live || s.working ? ' working' : '') + (attn ? ' ' + attn : ''));
    a.href = '#/s/' + s.id; a.title = s.title + (s.branch ? '\nBranch: ' + s.branch : '');
    a.addEventListener('contextmenu', (e) => { e.preventDefault(); showCtxMenu(s, e.clientX, e.clientY, kind, group); });
    // Long-press on the phone opens the same menu; the tap that ends it must not open the session.
    let pressTimer = null, pressed = false;
    a.addEventListener('touchstart', (e) => { pressed = false; const t = e.touches[0]; pressTimer = setTimeout(() => { pressed = true; showCtxMenu(s, t.clientX, t.clientY, kind, group); if (navigator.vibrate) navigator.vibrate(10); }, 450); }, { passive: true });
    for (const evn of ['touchend', 'touchmove', 'touchcancel']) a.addEventListener(evn, () => clearTimeout(pressTimer), { passive: true });
    a.addEventListener('click', (e) => { if (pressed) { e.preventDefault(); e.stopPropagation(); pressed = false; } });
    if (attn) { const d = el('span', 'dot ' + attn); d.title = attn === 'needs-input' ? 'Needs your input' : attn === 'failed' ? 'The last turn failed' : 'Finished while you were away'; a.appendChild(d); }
    else if (s.live || s.working) { const d = el('span', 'dot'); d.title = s.live ? 'Working (started here)' : 'Working in another window'; a.appendChild(d); }
    const t = el('span', 't', s.title); t.dir = 'auto'; a.appendChild(t);
    a.appendChild(el('span', 'muted small', relTime(s.lastModified)));
    const pin = el('button', 'pin'); pin.type = 'button'; pin.title = s.pinned ? 'Unpin' : 'Pin'; pin.innerHTML = PIN_SVG;
    pin.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); togglePin(s.id, !s.pinned); });
    a.appendChild(pin);
    return a;
  }
  // ---------- a sidebar that keeps its order ----------
  // Nothing re-sorts itself when a session is written to. New projects go to the bottom,
  // new sessions to the top of their project, once; after that only drag-and-drop
  // (or Move up / Move down on the phone) changes the order. Saved on the server.
  state.order = { projects: [], sessions: {}, pinned: [] };
  const groupKey = (s) => (s.cwd || s.project || 'Other').replace(/[\\/]+$/, '').toLowerCase();
  function applyOrder() {
    const o = state.order; let changed = false;
    const groups = new Map();
    for (const s of state.sessions) { const k = groupKey(s); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(s); }
    for (const k of groups.keys()) if (!o.projects.includes(k)) { o.projects.push(k); changed = true; }
    for (const [k, items] of groups) {
      const known = o.sessions[k] || (o.sessions[k] = []);
      const fresh = items.filter((s) => !known.includes(s.id)).sort((a, b) => (b.createdAt || b.lastModified) - (a.createdAt || a.lastModified)).map((s) => s.id);
      if (fresh.length) { known.unshift(...fresh); changed = true; }
    }
    const pinnedNow = state.sessions.filter((s) => s.pinned).map((s) => s.id);
    for (const id of pinnedNow) if (!o.pinned.includes(id)) { o.pinned.push(id); changed = true; }
    if (changed) saveOrder();
  }
  let saveTimer = null;
  function saveOrder() { clearTimeout(saveTimer); saveTimer = setTimeout(() => api('/order', { method: 'POST', body: JSON.stringify(state.order) }).catch(() => {}), 400); }
  const byOrder = (list, order, key) => list.slice().sort((a, b) => { const ia = order.indexOf(key(a)), ib = order.indexOf(key(b)); return (ia < 0 ? 1e9 : ia) - (ib < 0 ? 1e9 : ib); });

  // drag & drop (mouse): rows within their group, project headers among projects
  let drag = null;
  function makeDraggable(node, kind, id, group) {
    node.draggable = true;
    node.addEventListener('dragstart', (e) => { drag = { kind, id, group }; node.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', id); } catch {} });
    node.addEventListener('dragend', () => { node.classList.remove('dragging'); drag = null; document.querySelectorAll('.drop-before, .drop-after').forEach((x) => x.classList.remove('drop-before', 'drop-after')); });
    node.addEventListener('dragover', (e) => {
      if (!drag || drag.kind !== kind || drag.group !== group || drag.id === id) return;
      e.preventDefault(); e.dataTransfer.dropEffect = 'move';
      const r = node.getBoundingClientRect(); const after = e.clientY > r.top + r.height / 2;
      node.classList.toggle('drop-before', !after); node.classList.toggle('drop-after', after);
    });
    node.addEventListener('dragleave', () => node.classList.remove('drop-before', 'drop-after'));
    node.addEventListener('drop', (e) => {
      if (!drag || drag.kind !== kind || drag.group !== group || drag.id === id) return;
      e.preventDefault();
      const r = node.getBoundingClientRect(); const after = e.clientY > r.top + r.height / 2;
      moveInOrder(kind, group, drag.id, id, after); drag = null;
    });
  }
  function orderList(kind, group) { return kind === 'project' ? state.order.projects : kind === 'pinned' ? state.order.pinned : (state.order.sessions[group] || (state.order.sessions[group] = [])); }
  function moveInOrder(kind, group, id, targetId, after) {
    const list = orderList(kind, group);
    const from = list.indexOf(id); if (from < 0) return; list.splice(from, 1);
    let to = list.indexOf(targetId); if (to < 0) to = list.length; if (after) to += 1;
    list.splice(to, 0, id); saveOrder(); renderSessions();
  }
  function nudge(kind, group, id, dir) {
    const list = orderList(kind, group); const i = list.indexOf(id); const j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return;
    list.splice(i, 1); list.splice(j, 0, id); saveOrder(); renderSessions();
  }

  function renderSessions() {
    applyOrder();
    const list = $('#session-list'); list.innerHTML = '';
    const pinned = byOrder(state.sessions.filter((s) => s.pinned), state.order.pinned, (s) => s.id);
    if (pinned.length) {
      const g = el('details', 'project-group'); g.open = !collapsed.has('__pinned');
      const sm = el('summary'); sm.innerHTML = CHEV_SVG; sm.appendChild(el('span', null, 'Pinned')); sm.appendChild(el('span', 'cnt', String(pinned.length))); g.appendChild(sm);
      for (const s of pinned) { const row = sessionRow(s, 'pinned', '__pinned'); makeDraggable(row, 'pinned', s.id, '__pinned'); g.appendChild(row); }
      g.addEventListener('toggle', () => rememberCollapsed('__pinned', !g.open));
      list.appendChild(g);
    }
    const q = (state.search || '').trim().toLowerCase();
    const groups = new Map();
    for (const s of state.sessions) {
      if (q && !(s.title + ' ' + s.project + ' ' + s.branch).toLowerCase().includes(q)) continue;
      const k = groupKey(s); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(s);
    }
    const keys = byOrder([...groups.keys()], state.order.projects, (k) => k);
    for (const k of keys) {
      const items = byOrder(groups.get(k), state.order.sessions[k] || [], (s) => s.id);
      const name = items[0].project || 'Other';
      const g = el('details', 'project-group'); g.open = q ? true : !collapsed.has(name);
      const sm = el('summary'); sm.innerHTML = CHEV_SVG; sm.appendChild(el('span', null, name)); sm.appendChild(el('span', 'cnt', String(items.length)));
      // "+" on the project row: a new session in that folder, like Desktop
      const add = el('button', 'proj-add'); add.type = 'button'; add.title = 'New session in ' + name;
      add.innerHTML = '<svg viewBox="0 0 20 20" width="14" height="14"><path d="M10 4v12M4 10h12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
      add.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); state.cwd = items[0].cwd; localStorage.setItem('cr.cwd', state.cwd); location.hash = '#/'; renderProjectChip(); });
      sm.appendChild(add);
      sm.title = items[0].cwd + '\nDrag to reorder projects'; g.appendChild(sm);
      makeDraggable(sm, 'project', k, '__projects');
      sm.addEventListener('contextmenu', (e) => { e.preventDefault(); showProjectMenu(k, name, e.clientX, e.clientY); });
      for (const s of items) { const row = sessionRow(s, 'session', k); makeDraggable(row, 'session', s.id, k); g.appendChild(row); }
      g.addEventListener('toggle', () => { if (!q) rememberCollapsed(name, !g.open); });
      list.appendChild(g);
    }
    if (!state.sessions.length) list.appendChild(el('div', 'muted small pad', 'No sessions yet.'));
    if (q && !groups.size) list.appendChild(el('div', 'muted small pad', 'No sessions match.'));
    updatePinButton();
  }
  function showProjectMenu(k, name, x, y) {
    ctx.innerHTML = '';
    const add = (label, hint, fn) => { const b = item(label, '', false, () => { ctx.classList.add('hidden'); fn(); }, { hint }); ctx.appendChild(b); };
    ctx.appendChild(el('div', 'menu-title', name));
    add('Move up', '', () => nudge('project', '__projects', k, -1));
    add('Move down', '', () => nudge('project', '__projects', k, 1));
    ctx.classList.remove('hidden');
    if (isPhone()) { ctx.style.left = ctx.style.top = ''; return; }
    const r = ctx.getBoundingClientRect();
    ctx.style.left = Math.min(x, window.innerWidth - r.width - 8) + 'px'; ctx.style.top = Math.min(y, window.innerHeight - r.height - 8) + 'px';
  }
  // search (magnifier in the sidebar), back / forward
  $('#search-btn').addEventListener('click', () => {
    const sb = $('#sidebar'); sb.classList.toggle('searching');
    if (sb.classList.contains('searching')) $('#search-input').focus(); else { state.search = ''; $('#search-input').value = ''; renderSessions(); }
  });
  $('#search-input').addEventListener('input', () => { state.search = $('#search-input').value; renderSessions(); });
  $('#search-input').addEventListener('keydown', (e) => { if (e.key === 'Escape') $('#search-btn').click(); });
  $('#nav-back').addEventListener('click', () => history.back());
  $('#nav-fwd').addEventListener('click', () => history.forward());
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
  const folderName = (p) => (p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;
  async function renderProjectChip() {
    const p = state.projects.find((x) => x.cwd === state.cwd);
    const name = state.cwd ? (p ? p.name : folderName(state.cwd)) : 'No folder';
    $('#project-name').textContent = name;
    $('#nb-folder-name').textContent = name;
    // branch of the chosen folder, for the chip next to it
    const br = $('#nb-branch'); br.classList.add('hidden');
    if (state.cwd) { try { const g = await api('/git?cwd=' + encodeURIComponent(state.cwd)); if (g.git && !state.current) { br.textContent = g.branch; br.classList.remove('hidden'); } } catch {} }
  }
  function pickFolder(cwd) { state.cwd = cwd || ''; localStorage.setItem('cr.cwd', state.cwd); renderProjectChip(); }
  // Desktop's folder menu: No folder / Recent / Open folder…
  function renderProjectMenu(menu) {
    menu.innerHTML = '';
    menu.appendChild(item('No folder', '', !state.cwd, () => { pickFolder(''); menu.classList.add('hidden'); }));
    menu.appendChild(el('div', 'menu-sep'));
    menu.appendChild(el('div', 'menu-title', 'Recent'));
    for (const p of state.projects.slice(0, 8)) menu.appendChild(item(p.name, '', p.cwd === state.cwd, () => { pickFolder(p.cwd); menu.classList.add('hidden'); }));
    menu.appendChild(el('div', 'menu-sep'));
    menu.appendChild(item('Open folder…', '', false, () => { menu.classList.add('hidden'); openFolderBrowser(state.cwd); }));
  }
  menuFor('#project-btn', '#project-menu', renderProjectMenu);
  menuFor('#nb-folder', '#nb-folder-menu', renderProjectMenu);

  // Folder browser (the browser cannot open the OS folder dialog): drives → folders → Use this folder.
  const fb = $('#folder-modal');
  async function openFolderBrowser(start) {
    fb.classList.remove('hidden');
    await browseTo(start || '');
  }
  async function browseTo(p) {
    const list = $('#fb-list'); list.innerHTML = '<div class="muted small pad">Loading…</div>';
    try {
      const d = await api('/browse?path=' + encodeURIComponent(p || ''));
      $('#fb-path').value = d.path || '';
      $('#fb-use').disabled = !d.path;
      list.innerHTML = '';
      if (d.path) { const up = el('button', 'fb-row up'); up.type = 'button'; up.textContent = '..'; up.addEventListener('click', () => browseTo(d.parent || '')); list.appendChild(up); }
      for (const dir of d.dirs) {
        const b = el('button', 'fb-row'); b.type = 'button';
        b.innerHTML = '<svg viewBox="0 0 20 20" width="15" height="15"><path d="M3 5.5A1.5 1.5 0 0 1 4.5 4h3.2l1.6 1.8h6.2A1.5 1.5 0 0 1 17 7.3v7.2a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 14.5z" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>';
        b.appendChild(document.createTextNode(dir.name));
        // click selects (the path box and "Use this folder" follow it); double-click opens it
        b.addEventListener('click', () => { list.querySelectorAll('.fb-row.sel').forEach((x) => x.classList.remove('sel')); b.classList.add('sel'); $('#fb-path').value = dir.path; $('#fb-use').disabled = false; });
        b.addEventListener('dblclick', () => browseTo(dir.path));
        list.appendChild(b);
      }
      if (!d.dirs.length) list.appendChild(el('div', 'muted small pad', 'No subfolders'));
    } catch (e) { list.innerHTML = ''; list.appendChild(el('div', 'note error', e.message)); }
  }
  $('#fb-path').addEventListener('keydown', (e) => { if (e.key === 'Enter') browseTo($('#fb-path').value.trim()); });
  $('#fb-home').addEventListener('click', async () => { try { const d = await api('/browse'); browseTo(d.home); } catch {} });
  $('#fb-use').addEventListener('click', () => { const p = $('#fb-path').value.trim(); if (p) { pickFolder(p); fb.classList.add('hidden'); } });
  $('#fb-close').addEventListener('click', () => fb.classList.add('hidden'));
  fb.addEventListener('click', (e) => { if (e.target === fb) fb.classList.add('hidden'); });

  // ---------- model / permission mode ----------
  const MODELS = [
    { id: 'claude-fable-5-1', name: 'Claude Fable 5.1', desc: 'Most capable' },
    { id: 'claude-opus-5', name: 'Claude Opus 5', desc: 'Strong, slower' },
    { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', desc: 'Fast and capable' },
    { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', desc: 'Fastest, cheapest' },
  ];
  const EFFORTS = [{ id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium' }, { id: 'high', name: 'High' }];
  // The Claude Desktop mode picker, word for word, in its order (1–5 are its shortcuts).
  const MODES = [
    { id: 'auto', name: 'Auto', desc: 'Claude handles permission decisions' },
    { id: 'default', name: 'Manual', desc: 'Always ask before making changes' },
    { id: 'acceptEdits', name: 'Accept edits', desc: 'Automatically accept all file edits' },
    { id: 'plan', name: 'Plan', desc: 'Create a plan before making changes' },
    { id: 'bypassPermissions', name: 'Bypass permissions', desc: 'Accepts all permissions' },
  ];
  state.model = localStorage.getItem('cr.model') || MODELS[0].id;
  state.effort = localStorage.getItem('cr.effort') || '';
  state.mode = localStorage.getItem('cr.mode') || 'default';

  function menuFor(btnId, menuId, render) {
    const btn = $(btnId), m = $(menuId);
    btn.addEventListener('click', (e) => { e.stopPropagation(); const open = m.classList.contains('hidden'); document.querySelectorAll('.menu').forEach((x) => x.classList.add('hidden')); if (open) { render(m); m.classList.remove('hidden'); } });
    document.addEventListener('click', (e) => { if (!m.contains(e.target)) m.classList.add('hidden'); });
  }
  function item(label, desc, selected, onPick, { hint = '', tag = '' } = {}) {
    const b = el('button', 'menu-item' + (selected ? ' sel' : '')); b.type = 'button';
    const t = el('span', 'menu-label'); t.appendChild(document.createTextNode(label)); if (tag) t.appendChild(el('span', 'tag', tag)); b.appendChild(t);
    if (desc) b.appendChild(el('span', 'desc', desc));
    if (hint) b.appendChild(el('span', 'hint', hint));
    b.addEventListener('click', onPick); return b;
  }
  function renderModelChip() {
    const mdl = MODELS.find((x) => x.id === state.model) || MODELS[0];
    $('#model-label').textContent = mdl.name + (state.effort ? ' · ' + state.effort : '');
  }
  function renderModeChip() { $('#mode-name').textContent = (MODES.find((x) => x.id === state.mode) || MODES[0]).name; }
  // Model, mode and effort belong to the session, like Desktop: a change is remembered for
  // this session, and pushed to the running process so it takes effect for the next tool
  // call / model request (Shift+Tab in the CLI). With no session open it is the default
  // for new sessions on this device.
  async function pushControls(patch) {
    if (!state.current) return;
    api(`/sessions/${state.current}/prefs`, { method: 'POST', body: JSON.stringify(patch) }).catch(() => {});
    if (!state.running) return;
    try { await api(`/sessions/${state.current}/controls`, { method: 'POST', body: JSON.stringify(patch) }); }
    catch (e) { thread.appendChild(el('div', 'note error', e.message)); }
  }
  function applySessionSettings(s) {
    restoreDeviceDefaults(); // unknown values fall back to this device's defaults, never to the previous session's
    if (!s) return;
    if (s.model && MODELS.some((m) => m.id === s.model)) state.model = s.model;
    if (s.permissionMode && MODES.some((m) => m.id === s.permissionMode)) state.mode = s.permissionMode;
    state.effort = s.effort || '';
    renderModelChip(); renderModeChip();
  }
  function restoreDeviceDefaults() {
    state.model = localStorage.getItem('cr.model') || MODELS[0].id;
    state.effort = localStorage.getItem('cr.effort') || '';
    state.mode = localStorage.getItem('cr.mode') || 'default';
    renderModelChip(); renderModeChip();
  }
  menuFor('#model-btn', '#model-menu', function render(m) {
    m.innerHTML = '';
    MODELS.forEach((x, i) => m.appendChild(item(x.name, '', x.id === state.model, () => { state.model = x.id; localStorage.setItem('cr.model', x.id); renderModelChip(); m.classList.add('hidden'); pushControls({ model: x.id }); }, { hint: x.id === state.model ? '' : String(i + 1), tag: x.id === MODELS[0].id ? 'Default' : '' })));
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
    m.innerHTML = ''; m.appendChild(el('div', 'menu-title', 'Mode'));
    MODES.forEach((x, i) => m.appendChild(item(x.name, x.desc, x.id === state.mode, () => { state.mode = x.id; localStorage.setItem('cr.mode', x.id); renderModeChip(); m.classList.add('hidden'); pushControls({ permissionMode: x.id }); }, { hint: String(i + 1) })));
  });
  // 1–5 while the mode menu is open, like Desktop
  document.addEventListener('keydown', (e) => {
    if ($('#mode-menu').classList.contains('hidden') || !/^[1-5]$/.test(e.key)) return;
    const x = MODES[Number(e.key) - 1]; if (!x) return;
    e.preventDefault(); state.mode = x.id; localStorage.setItem('cr.mode', x.id); renderModeChip(); $('#mode-menu').classList.add('hidden'); pushControls({ permissionMode: x.id });
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

  // ---------- session bar (project · branch · +added −removed · Create PR), session ⋮ menu, usage popover ----------
  async function refreshGit() {
    const bar = $('#session-bar'); if (!state.current) { bar.classList.add('hidden'); return; }
    try {
      const g = await api(`/sessions/${state.current}/git`);
      if (!g.git) { bar.classList.add('hidden'); return; }
      bar.classList.remove('hidden');
      $('#sb-project').textContent = state.cwd ? state.cwd.split(/[\\/]/).pop() : '';
      $('#sb-branch').textContent = g.branch;
      // Desktop counts the lines this session wrote, not just what is uncommitted.
      const add = g.sessionAdded ?? g.added, del = g.sessionRemoved ?? g.removed;
      $('#sb-added').textContent = '+' + Number(add).toLocaleString(); $('#sb-removed').textContent = '−' + Number(del).toLocaleString();
      $('#sb-diff').classList.toggle('hidden', !(add || del));
      $('#sb-pr').classList.toggle('hidden', !g.dirty);
    } catch { bar.classList.add('hidden'); }
  }
  $('#sb-close').addEventListener('click', () => $('#session-bar').classList.add('hidden'));
  $('#sb-pr').addEventListener('click', () => { input.value = 'Create a pull request for the current changes: commit what is uncommitted with a clear message, push the branch, and open the PR with a title and a short description.'; input.dispatchEvent(new Event('input')); submit(); });

  menuFor('#session-menu-btn', '#session-menu', (m) => {
    m.innerHTML = '';
    const s = state.sessions.find((x) => x.id === state.current) || {};
    m.appendChild(item('Rename', '', false, async () => { m.classList.add('hidden'); const t = prompt('Session name', s.title || ''); if (t && t.trim()) { try { await api(`/sessions/${state.current}/rename`, { method: 'POST', body: JSON.stringify({ title: t.trim() }) }); $('#chat-title').textContent = t.trim(); loadSessions(); } catch (e) { alert(e.message); } } }, { hint: 'R' }));
    m.appendChild(item('Fork', '', false, async () => { m.classList.add('hidden'); try { const r = await api(`/sessions/${state.current}/fork`, { method: 'POST', body: JSON.stringify({}) }); await loadSessions(); location.hash = '#/s/' + r.sessionId; } catch (e) { alert(e.message); } }, { hint: 'F' }));
    m.appendChild(item('Changes', '', false, () => { m.classList.add('hidden'); openChanges(); }));
    m.appendChild(item('Preview', 'Show this project\'s dev server, here and on your phone', false, () => { m.classList.add('hidden'); openPreview(); }));
    m.appendChild(el('div', 'menu-sep'));
    m.appendChild(item(s.archived ? 'Unarchive' : 'Archive', '', false, async () => { m.classList.add('hidden'); try { await api(`/sessions/${state.current}/archive`, { method: 'POST', body: JSON.stringify({ archived: !s.archived }) }); await loadSessions(); if (!s.archived) location.hash = '#/'; } catch (e) { alert(e.message); } }, { hint: 'A' }));
    const del = item('Delete', '', false, async () => { m.classList.add('hidden'); if (!confirm('Delete this session from this computer? This cannot be undone.')) return; try { await api(`/sessions/${state.current}`, { method: 'DELETE' }); await loadSessions(); location.hash = '#/'; } catch (e) { alert(e.message); } }, { hint: 'D' });
    del.classList.add('danger'); m.appendChild(del);
  });

  // ---------- connectors & plugins (Desktop's panel) ----------
  const ctModal = $('#connectors-modal');
  const STATUS_WORD = { connected: 'Connected', failed: 'Failed', 'needs-auth': 'Needs sign-in', pending: 'Connecting…', disabled: 'Off' };
  function toggleEl(on, onChange) {
    const t = el('button', 'toggle' + (on ? ' on' : '')); t.type = 'button'; t.setAttribute('role', 'switch'); t.setAttribute('aria-checked', String(on));
    t.appendChild(el('i'));
    t.addEventListener('click', async () => { const next = !t.classList.contains('on'); t.classList.toggle('on', next); t.setAttribute('aria-checked', String(next)); try { await onChange(next); } catch (e) { t.classList.toggle('on', !next); $('#connectors-error').hidden = false; $('#connectors-error').textContent = e.message; } });
    return t;
  }
  async function openConnectors() {
    ctModal.classList.remove('hidden'); $('#connectors-error').hidden = true;
    $('#connectors-list').innerHTML = '<div class="muted small pad">Loading…</div>'; $('#plugins-list').innerHTML = '';
    let data;
    try { data = await api('/connectors?cwd=' + encodeURIComponent(state.cwd || '') + '&sessionId=' + encodeURIComponent(state.current || '')); }
    catch (e) { $('#connectors-error').hidden = false; $('#connectors-error').textContent = e.message; return; }
    const cl = $('#connectors-list'); cl.innerHTML = '';
    for (const c of data.connectors) {
      const row = el('div', 'ct-row');
      const info = el('div', 'ct-info');
      const name = el('div', 'ct-name'); name.appendChild(document.createTextNode(c.name)); name.appendChild(el('span', 'tag', c.scope));
      if (c.status) { const st = el('span', 'ct-status ' + c.status, STATUS_WORD[c.status] || c.status); if (c.tools) st.textContent += ' · ' + c.tools + ' tools'; name.appendChild(st); }
      info.appendChild(name); info.appendChild(el('div', 'ct-desc', (c.type + ' · ' + (c.target || '')).slice(0, 120)));
      if (c.error) info.appendChild(el('div', 'ct-desc error', c.error.slice(0, 160)));
      row.appendChild(info);
      if (!c.builtin) row.appendChild(toggleEl(c.enabled, (on) => api('/connectors/' + encodeURIComponent(c.name), { method: 'POST', body: JSON.stringify({ enabled: on, sessionId: state.current }) })));
      cl.appendChild(row);
    }
    if (!data.connectors.length) cl.appendChild(el('div', 'muted small pad', 'No MCP servers configured on this computer.'));
    // Enabled plugins first; the rest of the marketplace behind a search box, like /plugin's Discover.
    const pl = $('#plugins-list'); pl.innerHTML = '';
    const pluginRow = (p) => {
      const row = el('div', 'ct-row');
      const info = el('div', 'ct-info');
      const name = el('div', 'ct-name'); name.appendChild(document.createTextNode(p.name)); name.appendChild(el('span', 'tag', p.marketplace)); info.appendChild(name);
      if (p.description) info.appendChild(el('div', 'ct-desc', p.description.slice(0, 140)));
      row.appendChild(info);
      row.appendChild(toggleEl(p.enabled, (on) => api('/plugins/' + encodeURIComponent(p.id), { method: 'POST', body: JSON.stringify({ enabled: on }) })));
      return row;
    };
    const on = data.plugins.filter((p) => p.enabled), off = data.plugins.filter((p) => !p.enabled);
    for (const p of on) pl.appendChild(pluginRow(p));
    if (!on.length) pl.appendChild(el('div', 'muted small pad', 'No plugins enabled.'));
    if (off.length) {
      const d = el('details', 'ct-more'); const s = el('summary', null, `Available in the marketplace (${off.length})`); d.appendChild(s);
      const search = el('input', 'ct-search'); search.placeholder = 'Search plugins'; search.type = 'search'; d.appendChild(search);
      const box = el('div', 'ct-list'); d.appendChild(box);
      const paint = () => { const q = search.value.trim().toLowerCase(); box.innerHTML = ''; off.filter((p) => !q || (p.name + ' ' + p.description).toLowerCase().includes(q)).slice(0, 40).forEach((p) => box.appendChild(pluginRow(p))); };
      search.addEventListener('input', paint); paint(); pl.appendChild(d);
    }
    if (!data.plugins.length) pl.appendChild(el('div', 'muted small pad', 'No plugin marketplaces installed.'));
  }
  // App section: what is running, restart the server with new code, rebuild the shell.
  async function paintVersion() {
    try {
      const v = await api('/version');
      $('#app-version').textContent = v.commit ? v.commit + (v.dirty ? ' +' + v.dirty + ' uncommitted' : '') : 'unknown';
      $('#app-version-desc').textContent = [v.subject, v.when && 'committed ' + relTime(Date.parse(v.when)) + ' ago', 'server up ' + relTime(v.serverStartedAt), v.appBuiltAt && 'app built ' + relTime(v.appBuiltAt) + ' ago', v.liveRuns ? v.liveRuns + ' turn running' : ''].filter(Boolean).join(' · ');
      $('#app-restart').disabled = !v.inApp;
      paintRebuildLog();
    } catch (e) { $('#app-version').textContent = '?'; $('#app-version-desc').textContent = e.message; }
  }
  // The panel is opened long after a rebuild as often as during one.
  async function paintRebuildLog() {
    const log = $('#app-log');
    let j; try { j = await api('/rebuild/log'); } catch { return; }
    if (!j.text || !j.text.trim()) { log.classList.add('hidden'); return; }
    log.classList.remove('hidden');
    if (j.running || j.at === undefined) { log.classList.remove('old'); log.textContent = j.text; if (j.running) followRebuild(); return; } // an older server does not report when it is from
    log.classList.add('old');
    log.textContent = 'Last rebuild · ' + relTime(j.at) + ' ago' + (j.failed ? ' · failed' : '') + '\n' + j.text;
  }
  let rebuildPoll = null;
  function followRebuild() {
    if (rebuildPoll) return;
    const log = $('#app-log');
    rebuildPoll = setInterval(async () => {
      try {
        const r = await fetch('/api/rebuild/log', { headers: { Authorization: 'Bearer ' + state.token }, cache: 'no-store' });
        if (!r.ok) throw 0;
        const j = await r.json();
        log.classList.remove('old');
        log.textContent = j.text || 'Starting…';
        log.scrollTop = log.scrollHeight;
        if (j.done) { clearInterval(rebuildPoll); rebuildPoll = null; if (!j.failed) setTimeout(() => location.reload(), 1500); }
      } catch { log.textContent += '\n(the app is restarting…)'; }
    }, 2000);
  }

  async function waitForServer(then, seconds = 900) {
    const log = $('#app-log'); log.classList.remove('hidden');
    if (!log.textContent.startsWith('Claude is working')) log.textContent = 'Restarting the server…';
    const started = Date.now();
    for (let i = 0; i < seconds; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      try { const r = await fetch('/api/version', { headers: { Authorization: 'Bearer ' + state.token }, cache: 'no-store' }); if (r.ok) { const v = await r.json(); if (Date.now() - v.serverStartedAt < 60000) { log.textContent = 'Back. Reloading…'; return then(); } } } catch {}
      if (!log.textContent.startsWith('Claude is working')) log.textContent = 'Restarting the server… ' + (i + 1) + 's';
      else if (i % 10 === 0) log.textContent = 'Claude is working. The server restarts by itself the moment this turn ends, and the window reloads. (' + Math.round((Date.now() - started) / 1000) + 's)';
    }
    log.textContent = 'The server did not come back yet. Reload the page in a moment.';
  }
  $('#app-restart').addEventListener('click', async () => {
    const btn = $('#app-restart'); btn.disabled = true;
    const log = $('#app-log');
    try {
      const r = await api('/restart', { method: 'POST', body: JSON.stringify({}) });
      if (r.queued) {
        log.classList.remove('hidden'); log.classList.remove('old');
        log.textContent = 'Claude is working. The server restarts by itself the moment this turn ends, and the window reloads.';
      }
      await waitForServer(() => location.reload());
    } catch (e) { btn.disabled = false; $('#connectors-error').hidden = false; $('#connectors-error').textContent = e.message; }
  });
  $('#app-rebuild').addEventListener('click', async () => {
    if (!confirm('Rebuild the Windows app now? The window closes and comes back in 1–3 minutes. The chat keeps running while it builds.')) return;
    const log = $('#app-log'); log.classList.remove('hidden'); log.classList.remove('old'); log.textContent = 'Starting…';
    try { await api('/rebuild', { method: 'POST', body: JSON.stringify({}) }); } catch (e) { log.textContent = e.message; return; }
    followRebuild();
  });
  // "A new version is ready" banner: the server notices files newer than what it is running.
  let updateSnoozed = '';
  async function checkForUpdate() {
    let v; try { v = await api('/version'); } catch { return; }
    const bar = $('#update-banner');
    const key = (v.shellStale ? 'shell:' + v.shellChanged.join(',') : '') + (v.stale ? 'srv:' + v.changed.join(',') : '');
    if (!key || key === updateSnoozed) { bar.classList.add('hidden'); return; }
    bar.classList.remove('hidden');
    if (v.shellStale) {
      $('#ub-text').textContent = 'The app shell changed'; $('#ub-detail').textContent = v.shellChanged.slice(0, 3).join(', ') + ' · needs a rebuild (1–3 min)';
      $('#ub-action').textContent = 'Rebuild app'; $('#ub-action').onclick = () => { bar.classList.add('hidden'); openConnectors(); paintVersion(); $('#app-rebuild').click(); };
    } else {
      $('#ub-text').textContent = 'A new version is ready'; $('#ub-detail').textContent = v.changed.length + ' file' + (v.changed.length === 1 ? '' : 's') + ' changed' + (v.liveRuns ? ' · waits until Claude is idle' : '');
      $('#ub-action').textContent = !v.inApp ? 'Reload' : v.restartQueued ? 'Restarting after this turn' : 'Restart now';
      $('#ub-action').disabled = !!v.restartQueued;
      $('#ub-action').onclick = async () => {
        if (!v.inApp) return location.reload();
        try { await api('/restart', { method: 'POST', body: JSON.stringify({}) }); openConnectors(); await waitForServer(() => location.reload()); }
        catch (e) { $('#ub-detail').textContent = e.message; }
      };
    }
    $('#ub-close').onclick = () => { updateSnoozed = key; bar.classList.add('hidden'); };
  }
  setInterval(checkForUpdate, 30000); setTimeout(checkForUpdate, 3000);
  // Desktop keeps connectors in the composer's + menu; so do we, and the header stays clean.
  menuFor('#attach-btn', '#attach-menu', (m) => {
    m.innerHTML = '';
    m.appendChild(item('Upload from this computer', 'Images, video, audio, documents. Pasting and dropping work too.', false, () => { m.classList.add('hidden'); $('#file-input').click(); }));
    m.appendChild(el('div', 'menu-sep'));
    m.appendChild(item('Connectors & plugins', 'MCP servers this computer can use, and the app itself.', false, () => { m.classList.add('hidden'); openConnectors(); paintVersion(); }));
  });
  $('#connectors-refresh').addEventListener('click', () => { openConnectors(); paintVersion(); });
  $('#connectors-close').addEventListener('click', () => ctModal.classList.add('hidden'));
  ctModal.addEventListener('click', (e) => { if (e.target === ctModal) ctModal.classList.add('hidden'); });

  const fmtK = (n) => n >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k' : String(n);
  const resetsIn = (iso) => { if (!iso) return ''; const ms = Date.parse(iso) - Date.now(); if (!(ms > 0)) return 'Resets soon'; const h = Math.floor(ms / 3600000), mnt = Math.floor((ms % 3600000) / 60000); return 'Resets in ' + (h >= 24 ? Math.floor(h / 24) + ' d ' + (h % 24) + ' hr' : h ? h + ' hr ' + mnt + ' min' : mnt + ' min'); };
  let usage = { context: null, limits: null };
  function paintUsage() {
    const c = usage.context, ring = $('#usage-btn');
    ring.classList.toggle('hidden', !state.current);
    const pct = c ? Math.round(c.percentage) : 0;
    ring.style.setProperty('--pct', pct);
    ring.title = c ? `Context window ${fmtK(c.totalTokens)} / ${fmtK(c.maxTokens)} (${pct}%)` : 'Context window';
    const pop = $('#usage-pop');
    pop.querySelector('.uc-value').textContent = c ? `${fmtK(c.totalTokens)} / ${fmtK(c.maxTokens)} (${pct}%)` : 'Unknown until this session runs a turn';
    pop.querySelector('.uc-bar > i').style.width = pct + '%';
    const L = usage.limits?.rate_limits; const list = pop.querySelector('.ul-list'); list.innerHTML = '';
    pop.querySelector('.ul-title').textContent = 'Plan usage limits' + (usage.limits?.subscription_type ? ' · ' + usage.limits.subscription_type[0].toUpperCase() + usage.limits.subscription_type.slice(1) : '');
    const row = (name, lim) => { if (!lim || lim.utilization == null) return; const u = Math.round(lim.utilization * (lim.utilization <= 1 ? 100 : 1)); const r = el('div', 'ul-row'); r.innerHTML = `<div class="ul-head"><span>${name}</span><span class="muted">${resetsIn(lim.resets_at)}</span><b>${u}%</b></div><div class="ul-bar${u >= 90 ? ' hot' : ''}"><i style="width:${Math.min(100, u)}%"></i></div>`; list.appendChild(r); };
    if (L) { row('5-hour limit', L.five_hour); row('Weekly · all models', L.seven_day); if (L.seven_day_opus) row('Weekly · Opus', L.seven_day_opus); if (L.seven_day_sonnet) row('Weekly · Sonnet', L.seven_day_sonnet); for (const m of L.model_scoped || []) row('Weekly · ' + m.display_name, m); }
    if (!L) list.appendChild(el('div', 'muted small', 'Limits appear after the first turn from this app.'));
    paintLimitBanner();
  }
  // "Approaching weekly usage limit · Resets Fri, Sep 18, 8:00 PM" above the composer, like Desktop.
  function paintLimitBanner() {
    const L = usage.limits?.rate_limits; const bar = $('#limit-banner');
    let worst = null;
    if (L) for (const [name, lim] of [['weekly', L.seven_day], ['5-hour', L.five_hour], ...((L.model_scoped || []).map((m) => [m.display_name, m]))]) { if (!lim || lim.utilization == null) continue; const u = lim.utilization * (lim.utilization <= 1 ? 100 : 1); if (u >= 85 && (!worst || u > worst.u)) worst = { name, u, resets: lim.resets_at }; }
    if (!worst || sessionStorage.getItem('cr.limitDismissed') === String(worst.resets)) { bar.classList.add('hidden'); return; }
    bar.classList.remove('hidden');
    $('#lb-text').textContent = (worst.u >= 100 ? 'Reached ' : 'Approaching ') + worst.name + ' usage limit';
    $('#lb-resets').textContent = worst.resets ? 'Resets ' + new Date(worst.resets).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
    $('#lb-close').onclick = () => { try { sessionStorage.setItem('cr.limitDismissed', String(worst.resets)); } catch {} bar.classList.add('hidden'); };
  }
  menuFor('#usage-btn', '#usage-pop', async () => { paintUsage(); try { const u = await api(`/sessions/${state.current}/usage`); usage.context = u.context || usage.context; usage.limits = u.limits || usage.limits; paintUsage(); } catch {} });
  $('#usage-compact').addEventListener('click', () => { $('#usage-pop').classList.add('hidden'); input.value = '/compact'; input.dispatchEvent(new Event('input')); submit(); });

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

  // A message element for one assistant turn (text + thinking + tool_use blocks).
  function assistantMsg() {
    const m = el('div', 'msg assistant');
    const av = el('div', 'msg-avatar', '✱'); m.appendChild(av);
    const body = el('div', 'msg-body'); m.appendChild(body);
    return { root: m, body, blocks: new Map(), tools: new Map(), group: null };
  }
  // Consecutive tool calls fold into one "Ran 3 commands ›" line, like Desktop.
  const TOOL_KIND = { Bash: 'command', PowerShell: 'command', Read: 'read', Glob: 'search', Grep: 'search', Edit: 'edit', Write: 'create', NotebookEdit: 'edit', Agent: 'agent', WebFetch: 'fetch', WebSearch: 'browse', SendUserFile: 'sent' };
  const isSendTool = (n) => n === 'SendUserFile' || /__SendUserFile$/.test(n || '');
  const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);
  const baseName = (p) => String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop();
  // Desktop's wording, in the order the tools first happened:
  // "Fetched 4 pages, browsed the web, ran 15 commands, created hasanlu-doc.txt, used a tool"
  function groupLabel(names, inputs = []) {
    const order = []; const c = {}; const files = { create: [], edit: [] };
    names.forEach((n, i) => { const k = isSendTool(n) ? 'sent' : (TOOL_KIND[n] || 'tool'); if (!c[k]) { c[k] = 0; order.push(k); } c[k]++; const f = inputs[i]?.file_path || inputs[i]?.notebook_path; if (f && (k === 'create' || k === 'edit') && !files[k].includes(baseName(f))) files[k].push(baseName(f)); });
    if (order.includes('tool')) order.push(order.splice(order.indexOf('tool'), 1)[0]); // "used a tool" goes last, as in Desktop
    const parts = order.map((k) => {
      switch (k) {
        case 'fetch': return 'Fetched ' + plural(c[k], 'page', 'pages');
        case 'browse': return 'Browsed the web';
        case 'command': return 'Ran ' + plural(c[k], 'command', 'commands');
        case 'create': return 'Created ' + (files.create.length === 1 ? files.create[0] : plural(c[k], 'file', 'files'));
        case 'edit': return 'Edited ' + (files.edit.length === 1 ? files.edit[0] : plural(c[k], 'file', 'files'));
        case 'read': return 'Read ' + plural(c[k], 'file', 'files');
        case 'search': return 'Searched ' + plural(c[k], 'time', 'times');
        case 'agent': return 'Ran ' + plural(c[k], 'agent', 'agents');
        case 'sent': return 'Sent';
        default: return c[k] === 1 ? 'Used a tool' : 'Used ' + plural(c[k], 'tool', 'tools');
      }
    });
    if (!parts.length) return 'Worked';
    return parts.map((p, i) => i ? p[0].toLowerCase() + p.slice(1) : p).join(', ');
  }
  // Lines a group added / removed, from Write and Edit inputs (the "+137 −0" next to Desktop's group line).
  const lineCount = (s) => { if (!s) return 0; s = String(s); return s.split('\n').length - (s.endsWith('\n') ? 1 : 0); };
  function groupDiff(names, inputs) {
    let add = 0, del = 0;
    names.forEach((n, i) => { const inp = inputs[i] || {}; if (n === 'Write') add += lineCount(inp.content); else if (n === 'Edit') { add += lineCount(inp.new_string); del += lineCount(inp.old_string); } else if (n === 'NotebookEdit') add += lineCount(inp.new_source); });
    return { add, del };
  }
  function paintGroupSummary(g) {
    if (g._fromCli) return;
    const s = g.querySelector('summary'); s.innerHTML = '';
    s.appendChild(document.createTextNode(groupLabel(g._names, g._inputs)));
    const d = groupDiff(g._names, g._inputs);
    if (d.add || d.del) { const st = el('span', 'group-diff'); st.innerHTML = `<span class="add">+${d.add.toLocaleString()}</span> <span class="del">−${d.del.toLocaleString()}</span>`; s.appendChild(st); }
  }
  // What SendUserFile delivered, shown the way Desktop shows it: caption, then the files inline.
  function sentCard(input) {
    const card = el('div', 'sent-card');
    const files = Array.isArray(input?.files) ? input.files : (input?.path ? [input.path] : []);
    if (input?.caption) { const cap = el('div', 'prose sent-caption'); cap.dir = 'auto'; cap.innerHTML = md(input.caption); card.appendChild(cap); }
    const media = el('div', 'sent-media');
    for (const p of files) {
      const src = localFileUrl(p);
      if (isVideo(p)) media.appendChild(videoEl(src));
      else if (isAudio(p)) { const a = el('audio', 'md-audio'); a.controls = true; a.src = src; media.appendChild(a); }
      else if (/\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i.test(p)) { const im = el('img', 'md-img sent-img'); im.src = src; im.alt = baseName(p); im.loading = 'lazy'; im.addEventListener('click', () => window.open(src, '_blank')); media.appendChild(im); }
      else { const chip = el('a', 'sent-file'); chip.textContent = baseName(p); chip.title = p; chip.href = src; chip.target = '_blank'; media.appendChild(chip); }
    }
    if (files.length) card.appendChild(media);
    return card;
  }
  function toolGroupFor(msg) {
    if (msg.group && msg.group === msg.body.lastElementChild) return msg.group;
    const g = el('details', 'tool-group'); g.appendChild(el('summary', null, 'Working')); g.appendChild(el('div', 'group-body'));
    g._names = []; g._inputs = []; msg.body.appendChild(g); msg.group = g; return g;
  }
  function setGroupSummary(g, text) { if (g) g.querySelector('summary').textContent = text; }
  function renderBlock(msg, index, block) {
    let node = msg.blocks.get(index);
    if (block.type === 'text') {
      if (!node) { node = el('div', 'prose'); node.dir = 'auto'; msg.body.appendChild(node); msg.blocks.set(index, node); msg.group = null; }
      node.innerHTML = md(block.text);
      if (!block.live) attachMediaPreviews(node, block.text);
    } else if (block.type === 'thinking') {
      if (!node) { node = stepEl('thinking', 'Thought', ''); msg.body.appendChild(node); msg.blocks.set(index, node); msg.group = null; }
      node.querySelector('.step-body').textContent = block.thinking || '';
      if (!block.thinking && !block.live) node.classList.add('hidden'); else node.classList.remove('hidden');
      if (block.live) { node.open = true; node.classList.add('live'); node.querySelector('.name').textContent = 'Thinking'; }
    } else if (block.type === 'tool_use') {
      if (!node) {
        node = stepEl('tool', block.name, ''); node._toolId = block.id;
        if (isSendTool(block.name)) msg.group = null; // "Sent ›" is its own line in Desktop
        const g = toolGroupFor(msg); g.querySelector('.group-body').appendChild(node); g._names.push(block.name); g._inputs.push(block.input || {}); node._groupIndex = g._names.length - 1;
        paintGroupSummary(g);
        msg.blocks.set(index, node); msg.tools.set(block.id, node);
      } else if (node._groupIndex != null && node.parentElement?.parentElement) { const g = node.parentElement.parentElement; g._inputs[node._groupIndex] = block.input || {}; paintGroupSummary(g); }
      node.querySelector('.arg').textContent = toolSummary(block.name, block.input);
      const b = node.querySelector('.step-body'); b.innerHTML = '';
      b.appendChild(el('div', 'label', 'Input'));
      const pre = el('pre', null, typeof block.input === 'string' ? block.input : JSON.stringify(block.input, null, 2)); b.appendChild(pre);
      // A file sent to the user is shown below its "Sent ›" line, like Desktop, once the input is complete.
      if (isSendTool(block.name) && block.input && (block.input.files || block.input.path) && !node._sentCard) {
        node._sentCard = sentCard(block.input);
        const g = node.parentElement?.parentElement; (g || msg.body).after ? g.after(node._sentCard) : msg.body.appendChild(node._sentCard);
        msg.group = null; // the next tool starts a new group under the card
      }
    }
  }
  const dataUrl = (img) => img?.source?.data ? `data:${img.source.media_type || 'image/png'};base64,${img.source.data}` : (img?.dataUrl || '');
  // Desktop shows a player when an answer mentions a video/audio file on the PC, even as a
  // bare path or in backticks (`out/hasanlu.mp4`). Files that do not exist simply drop out.
  const MEDIA_PATH = /(?:[A-Za-z]:\\|\.{0,2}[\\/])?(?:[\w .()\-]+[\\/])*[\w .()\-]+\.(mp4|webm|mov|m4v|mp3|wav|m4a|ogg)\b/gi;
  function attachMediaPreviews(node, text) {
    if (!text || node.querySelector('video, audio')) return;
    const seen = new Set();
    for (const m of text.matchAll(MEDIA_PATH)) {
      const p = m[0].trim(); if (seen.has(p) || /^https?:/i.test(p)) continue; seen.add(p);
      if (seen.size > 4) break;
      let media;
      if (isAudio(p)) { media = el('audio', 'md-audio'); media.controls = true; media.src = localFileUrl(p); media.addEventListener('error', () => media.remove(), { once: true }); }
      else { media = videoEl(localFileUrl(p)); media.querySelector('video').addEventListener('error', () => media.remove(), { once: true }); }
      node.appendChild(media);
    }
  }
  function attachResult(toolNode, result) {
    if (!toolNode) return;
    const b = toolNode.querySelector('.step-body');
    b.appendChild(el('div', 'label', result.is_error ? 'Error' : 'Result'));
    const blocks = Array.isArray(result.content) ? result.content : [{ type: 'text', text: resultText(result.content) }];
    const text = blocks.filter((x) => x.type === 'text').map((x) => x.text).join('\n');
    if (text) b.appendChild(el('pre', null, text.slice(0, 20000)));
    // Images Claude looked at (Read on a screenshot, a browser capture…) are shown, like Desktop.
    for (const x of blocks) if (x.type === 'image') { const im = el('img', 'tool-img'); im.src = dataUrl(x); im.alt = 'image'; im.loading = 'lazy'; b.appendChild(im); }
    if (blocks.some((x) => x.type === 'image')) { toolNode.open = true; toolNode.classList.add('has-image'); }
    if (result.is_error) toolNode.classList.add('error');
  }

  function userMsg(text, { queued = false, id = null, images = [], uuid = null } = {}) {
    const m = el('div', 'msg user' + (queued ? ' queued' : ''));
    if (id) m.dataset.promptId = id;
    if (uuid) m.dataset.uuid = uuid;
    m.appendChild(el('div', 'msg-avatar', (state.userName || 'U')[0].toUpperCase()));
    const b = el('div', 'msg-body'); b.dir = 'auto';
    if (images.length) {
      const strip = el('div', 'msg-images');
      for (const img of images) { const im = el('img'); im.src = typeof img === 'string' ? img : dataUrl(img); im.alt = 'attachment'; im.addEventListener('click', () => window.open(im.src, '_blank')); strip.appendChild(im); }
      b.appendChild(strip);
    }
    if (text) b.appendChild(el('div', 'msg-text', text));
    m.appendChild(b);
    if (queued) m.appendChild(el('div', 'queued-label', 'Queued · Claude reads it after the current step'));
    if (uuid && !queued) {
      // Rewind: a new session that stops just before this message, with the message back in the composer to change and resend.
      const row = el('div', 'msg-actions user-actions');
      const rw = el('button'); rw.type = 'button'; rw.title = 'Rewind to here'; rw.className = 'rewind';
      rw.innerHTML = '<svg viewBox="0 0 20 20" width="15" height="15"><path d="M4 10a6 6 0 1 1 1.8 4.3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M4 6v4h4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg><span>Rewind to here</span>';
      rw.addEventListener('click', () => rewindTo(uuid, text));
      row.appendChild(rw); m.appendChild(row);
    }
    return m;
  }
  async function rewindTo(uuid, text) {
    if (!state.current) return;
    try {
      const r = await api(`/sessions/${state.current}/rewind`, { method: 'POST', body: JSON.stringify({ uuid }) });
      pendingPrefill = text || '';
      await loadSessions();
      if (r.sessionId) location.hash = '#/s/' + r.sessionId;
      else { if (r.cwd) { state.cwd = r.cwd; localStorage.setItem('cr.cwd', r.cwd); } location.hash = '#/'; }
    } catch (e) { toast(e.message); }
  }
  let pendingPrefill = '';
  async function markRead(id) { try { await api(`/sessions/${id}/read`, { method: 'POST' }); const s = state.sessions.find((x) => x.id === id); if (s && (s.unread || s.failed)) { s.unread = false; s.failed = false; renderSessions(); } } catch {} }

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

  // Copy + time under a finished assistant turn (the Desktop action row).
  function addActions(msg, whenMs) {
    if (!msg?.root || msg.root.querySelector('.msg-actions')) return;
    const row = el('div', 'msg-actions');
    const copy = el('button'); copy.type = 'button'; copy.title = 'Copy';
    copy.innerHTML = '<svg viewBox="0 0 20 20" width="15" height="15"><rect x="7" y="7" width="9" height="9" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M13 7V5.5A1.5 1.5 0 0 0 11.5 4h-6A1.5 1.5 0 0 0 4 5.5v6A1.5 1.5 0 0 0 5.5 13H7" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>';
    copy.addEventListener('click', async () => { const t = [...msg.body.querySelectorAll('.prose')].map((n) => n.innerText).join('\n\n'); try { await navigator.clipboard.writeText(t); copy.title = 'Copied'; setTimeout(() => copy.title = 'Copy', 1500); } catch {} });
    row.appendChild(copy);
    if (whenMs) row.appendChild(el('span', 'time', relTime(whenMs) === 'now' ? 'just now' : relTime(whenMs) + (/\d[mhd]$/.test(relTime(whenMs)) ? ' ago' : '')));
    msg.body.appendChild(row);
  }

  function renderHistory(messages) {
    thread.innerHTML = '';
    const toolNodes = new Map();
    let group = null; // the assistant row for the current turn
    let lastAt = 0;
    for (const m of messages) {
      if (m.role === 'user') {
        const results = m.content.filter((b) => b.type === 'tool_result');
        for (const r of results) attachResult(toolNodes.get(r.tool_use_id), r);
        const text = m.content.filter((b) => b.type === 'text').map((b) => stripHarness(b.text)).filter(Boolean).join('\n\n');
        const images = m.content.filter((b) => b.type === 'image');
        if (text || images.length) { if (group) addActions(group, lastAt); thread.appendChild(userMsg(text, { images, uuid: m.uuid })); group = null; }
      } else if (m.role === 'assistant') {
        // One assistant row per turn: consecutive assistant API messages share it, like Desktop.
        if (!group) group = assistantMsg();
        let any = false;
        m.content.forEach((b, i) => {
          if (b.type === 'thinking' && !b.thinking) return;
          const key = m.uuid + ':' + i;
          renderBlock(group, key, b); any = true;
          if (b.type === 'tool_use') toolNodes.set(b.id, group.blocks.get(key));
        });
        if (m.timestamp) lastAt = Date.parse(m.timestamp) || lastAt;
        if (any && !group.root.isConnected) thread.appendChild(group.root);
      }
    }
    if (group) addActions(group, lastAt);
  }

  // ---------- tasks: what the turn is running (commands, subagents, workflows) ----------
  // A bar above the composer says how many are running; it opens a panel on the right
  // (a sheet on the phone) with each task, its elapsed time and output, and its own Stop.
  state.tasks = [];
  const hiddenTasks = new Set();
  const tasksPanel = $('#tasks-panel'), tpList = $('#tp-list');
  let tasksOpen = false, tasksTimer = null;
  const outputOpen = new Map(); // taskId -> { pre, timer }
  const toast = (m) => { const n = el('div', 'note error', m); thread.appendChild(n); autoscroll(); setTimeout(() => n.remove(), 5000); };
  const TASK_ICON = {
    local_bash: '<svg viewBox="0 0 20 20" width="15" height="15"><rect x="2.5" y="4" width="15" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M6 8l2.5 2L6 12M10 12.5h4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    local_agent: '<svg viewBox="0 0 20 20" width="15" height="15"><path d="M10 2.5l1.6 4.4 4.4 1.6-4.4 1.6L10 14.5 8.4 10.1 4 8.5l4.4-1.6z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M15.5 13.5l.6 1.6 1.6.6-1.6.6-.6 1.6-.6-1.6-1.6-.6 1.6-.6z" fill="currentColor"/></svg>',
    local_workflow: '<svg viewBox="0 0 20 20" width="15" height="15"><circle cx="5" cy="10" r="2" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="15" cy="5" r="2" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="15" cy="15" r="2" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M7 10h3l3-5M10 10l3 5" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>',
  };
  const taskKind = (t) => t.type === 'local_bash' ? 'Command' : t.type === 'local_agent' ? 'Agent' + (t.subagentType ? ' · ' + t.subagentType : '') : t.type === 'local_workflow' ? 'Workflow' + (t.workflow ? ' · ' + t.workflow : '') : t.type === 'mcp_task' ? 'Connector task' : t.type === 'remote_agent' ? 'Remote agent' : 'Task';
  const taskState = (t) => t.status === 'running' ? (t.backgrounded ? 'Running in background' : 'Running') : t.status === 'completed' ? 'Finished' : t.status === 'failed' ? 'Failed' : t.status === 'stopped' ? 'Stopped' : t.status;
  const fmtTok = (n) => n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n || 0);
  const fmtDur = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? s + 's' : s < 3600 ? Math.floor(s / 60) + 'm ' + (s % 60) + 's' : Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm'; };
  const visibleTasks = () => state.tasks.filter((t) => !hiddenTasks.has(t.id));
  function paintTasks() {
    const all = visibleTasks();
    const running = all.filter((t) => t.status === 'running');
    const bar = $('#tasks-bar');
    bar.classList.toggle('hidden', !all.length);
    bar.classList.toggle('idle', !running.length);
    if (all.length) {
      const cmds = running.filter((t) => t.type === 'local_bash').length, agents = running.filter((t) => t.type === 'local_agent').length, other = running.length - cmds - agents;
      $('#tb-text').textContent = running.length ? `${running.length} task${running.length === 1 ? '' : 's'} running` : `${all.length} task${all.length === 1 ? '' : 's'} finished`;
      const parts = []; if (cmds) parts.push(cmds + (cmds === 1 ? ' command' : ' commands')); if (agents) parts.push(agents + (agents === 1 ? ' agent' : ' agents')); if (other) parts.push(other + ' other');
      $('#tb-detail').textContent = parts.join(' · ');
      bar.querySelector('.tb-open').textContent = tasksOpen ? 'Hide' : 'Show';
    }
    if (!all.length && tasksOpen) closeTasks();
    if (tasksOpen) paintTaskList(all);
    clearInterval(tasksTimer); tasksTimer = null;
    if (running.length && tasksOpen) tasksTimer = setInterval(() => { for (const t of running) { const n = tpList.querySelector(`[data-task="${t.id}"] .tp-elapsed`); if (n) n.textContent = fmtDur(Date.now() - t.startedAt); } }, 1000);
  }
  function openTasks() { if (changesOpen) closeChanges(); if (previewOpen) closePreview(); tasksOpen = true; tasksPanel.classList.remove('hidden'); app.classList.add('tasks-open'); paintTasks(); }
  function closeTasks() { tasksOpen = false; tasksPanel.classList.add('hidden'); app.classList.remove('tasks-open'); for (const [, o] of outputOpen) clearInterval(o.timer); outputOpen.clear(); paintTasks(); }
  $('#tasks-bar').addEventListener('click', () => tasksOpen ? closeTasks() : openTasks());
  $('#tp-close').addEventListener('click', closeTasks);
  $('#tp-clear').addEventListener('click', () => { for (const t of state.tasks) if (t.status !== 'running') hiddenTasks.add(t.id); paintTasks(); });
  function paintTaskList(all) {
    const running = all.filter((t) => t.status === 'running'), finished = all.filter((t) => t.status !== 'running');
    $('#tp-count').textContent = running.length ? running.length + ' running' : '';
    $('#tp-clear').classList.toggle('hidden', !finished.length);
    // keep open output views across repaints
    const keep = new Map(); for (const [id, o] of outputOpen) keep.set(id, o.pre.textContent);
    tpList.innerHTML = '';
    const section = (label, items) => {
      if (!items.length) return;
      tpList.appendChild(el('div', 'tp-section', label));
      for (const t of items) tpList.appendChild(taskRow(t, keep.get(t.id)));
    };
    section('Running', running); section('Finished', finished);
    if (!all.length) tpList.appendChild(el('div', 'muted small pad', 'Nothing is running.'));
  }
  function taskRow(t, keptOutput) {
    const row = el('div', 'tp-row' + (t.status === 'running' ? ' running' : ' ' + t.status)); row.dataset.task = t.id;
    const head = el('div', 'tp-row-head');
    const ic = el('span', 'tp-icon'); ic.innerHTML = TASK_ICON[t.type] || TASK_ICON.local_bash; head.appendChild(ic);
    const main = el('div', 'tp-main');
    main.appendChild(el('div', 'tp-desc', t.description || taskKind(t)));
    const meta = el('div', 'tp-meta');
    meta.appendChild(el('span', null, taskKind(t)));
    meta.appendChild(el('span', 'tp-state', taskState(t)));
    meta.appendChild(el('span', 'tp-elapsed', fmtDur((t.endedAt || Date.now()) - t.startedAt)));
    if (t.usage?.tool_uses) meta.appendChild(el('span', null, t.usage.tool_uses + (t.usage.tool_uses === 1 ? ' tool use' : ' tool uses')));
    if (t.usage?.total_tokens) meta.appendChild(el('span', null, fmtTok(t.usage.total_tokens) + ' tokens'));
    if (t.lastTool && t.status === 'running') meta.appendChild(el('span', null, 'now: ' + t.lastTool));
    main.appendChild(meta);
    if (t.summary && t.summary !== t.description) main.appendChild(el('div', 'tp-summary', t.summary));
    if (t.error) main.appendChild(el('div', 'tp-summary error', t.error));
    head.appendChild(main);
    const acts = el('div', 'tp-actions');
    if (t.status === 'running') {
      const stop = el('button', 'btn btn-ghost small', 'Stop'); stop.type = 'button';
      stop.addEventListener('click', async () => { stop.disabled = true; stop.textContent = 'Stopping…'; try { await api(`/sessions/${state.current}/tasks/${t.id}/stop`, { method: 'POST' }); } catch (e) { stop.disabled = false; stop.textContent = 'Stop'; toast(e.message); } });
      acts.appendChild(stop);
    }
    head.appendChild(acts);
    row.appendChild(head);
    const foot = el('div', 'tp-foot');
    const outBtn = el('button', 'tp-link', keptOutput != null ? 'Hide output' : 'Output'); outBtn.type = 'button';
    const pre = el('pre', 'tp-out' + (keptOutput != null ? '' : ' hidden')); if (keptOutput != null) pre.textContent = keptOutput;
    outBtn.addEventListener('click', () => toggleOutput(t, pre, outBtn));
    foot.appendChild(outBtn);
    if (t.status === 'running' && !t.backgrounded && t.toolUseId) {
      const bg = el('button', 'tp-link', 'Run in background'); bg.type = 'button'; bg.title = 'Let Claude go on while this keeps running (Ctrl+B in the terminal)';
      bg.addEventListener('click', async () => { bg.disabled = true; try { await api(`/sessions/${state.current}/tasks/${t.id}/background`, { method: 'POST' }); } catch (e) { bg.disabled = false; toast(e.message); } });
      foot.appendChild(bg);
    }
    let promptPre = null;
    if (t.prompt && t.type === 'local_agent') {
      const pb = el('button', 'tp-link', 'Prompt'); pb.type = 'button';
      promptPre = el('pre', 'tp-out hidden'); promptPre.textContent = t.prompt;
      pb.addEventListener('click', () => { promptPre.classList.toggle('hidden'); pb.textContent = promptPre.classList.contains('hidden') ? 'Prompt' : 'Hide prompt'; });
      foot.appendChild(pb);
    }
    row.appendChild(foot); if (promptPre) row.appendChild(promptPre); row.appendChild(pre);
    if (keptOutput != null) { const o = outputOpen.get(t.id); if (o) o.pre = pre; }
    return row;
  }
  async function toggleOutput(t, pre, btn) {
    const cur = outputOpen.get(t.id);
    if (cur) { clearInterval(cur.timer); outputOpen.delete(t.id); pre.classList.add('hidden'); btn.textContent = 'Output'; return; }
    pre.classList.remove('hidden'); btn.textContent = 'Hide output'; pre.textContent = 'Loading…';
    const o = { pre, timer: null }; outputOpen.set(t.id, o);
    const load = async () => {
      try {
        const r = await api(`/sessions/${state.current}/tasks/${t.id}/output`);
        const stick = o.pre.scrollTop + o.pre.clientHeight >= o.pre.scrollHeight - 8;
        o.pre.textContent = r.exists ? (r.truncated ? '…\n' : '') + (r.text || '(nothing yet)') : '(no output yet)';
        if (stick) o.pre.scrollTop = o.pre.scrollHeight;
      } catch (e) { o.pre.textContent = e.message; }
      const still = state.tasks.find((x) => x.id === t.id)?.status === 'running';
      if (!still && o.timer) { clearInterval(o.timer); o.timer = null; }
    };
    await load();
    if (state.tasks.find((x) => x.id === t.id)?.status === 'running') o.timer = setInterval(load, 2000);
  }

  // ---------- the window's own title bar (native app only) ----------
  // The Tauri window is frameless, like Claude Desktop's: the header row is the
  // drag handle and the three buttons at the top right belong to the page.
  (function titleBar() {
    const T = window.__TAURI__;
    if (!T?.window?.getCurrentWindow) return;
    const win = T.window.getCurrentWindow();
    const root = document.documentElement;
    root.classList.add('in-app');
    const paintMax = async () => { try { root.classList.toggle('maximized', await win.isMaximized()); } catch {} };
    paintMax();
    window.addEventListener('resize', paintMax);
    $('#win-min').addEventListener('click', () => win.minimize().catch(() => {}));
    $('#win-max').addEventListener('click', async () => { try { await win.toggleMaximize(); } catch {} paintMax(); });
    $('#win-close').addEventListener('click', () => win.close().catch(() => {}));
    // Dragging: anywhere in the header or the top of the sidebar that is not a control.
    const DRAG_ZONES = '.topbar, .sidebar-top, .tp-head';
    const NO_DRAG = 'button, a, input, textarea, select, .menu, .chip, [role="button"], .pill';
    document.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || !e.target.closest(DRAG_ZONES) || e.target.closest(NO_DRAG)) return;
      win.startDragging().catch(() => {});
    });
    document.addEventListener('dblclick', async (e) => {
      if (!e.target.closest(DRAG_ZONES) || e.target.closest(NO_DRAG)) return;
      try { await win.toggleMaximize(); } catch {} paintMax();
    });
  })();

  // ---------- Preview: whatever this project's dev server is serving ----------
  // The page is proxied through our own origin, so the phone can see a server
  // that only listens on the PC's localhost, and hot reload keeps working.
  const pvPanel = $('#preview-panel'), pvFrame = $('#pv-frame'), pvNote = $('#pv-note');
  let previewOpen = false, pvPort = 0, pvPorts = [];
  const pvKey = () => 'cr.preview.' + (state.cwd || 'any');
  function pvRemember() { try { localStorage.setItem(pvKey(), JSON.stringify({ port: pvPort, path: $('#pv-path').value })); } catch {} }
  function pvRecall() { try { return JSON.parse(localStorage.getItem(pvKey()) || '{}'); } catch { return {}; } }

  async function openPreview() {
    if (tasksOpen) closeTasks();
    if (changesOpen) closeChanges();
    previewOpen = true; pvPanel.classList.remove('hidden'); app.classList.add('panel-open');
    // The frame cannot send our token, so the server hands out a cookie first.
    try { await api('/preview/grant'); } catch (e) { pvNote.textContent = e.message; }
    const saved = pvRecall();
    if (saved.path) $('#pv-path').value = saved.path;
    await loadPorts();
    const pick = saved.port && pvPorts.some((p) => p.port === saved.port) ? saved.port : (pvPorts.find((p) => p.port >= 3000 && p.port <= 9999) || pvPorts[0])?.port;
    if (pick) usePort(pick); else { pvNote.textContent = 'Nothing is listening on this machine yet. Start the dev server and press refresh.'; pvNote.classList.remove('hidden'); }
  }
  function closePreview() { previewOpen = false; pvPanel.classList.add('hidden'); app.classList.remove('panel-open'); pvFrame.src = 'about:blank'; }
  $('#pv-close').addEventListener('click', closePreview);

  async function loadPorts() {
    try { const r = await api('/preview/ports'); pvPorts = r.ports || []; }
    catch (e) { pvPorts = []; pvNote.textContent = e.message; }
  }
  function usePort(port) {
    pvPort = port;
    const found = pvPorts.find((p) => p.port === port);
    $('#pv-port-name').textContent = port + (found?.label ? ' · ' + found.label : '');
    show();
  }
  function show() {
    if (!pvPort) return;
    let p = $('#pv-path').value.trim() || '/';
    if (!p.startsWith('/')) p = '/' + p;
    pvNote.classList.add('hidden'); pvFrame.classList.remove('hidden');
    pvFrame.src = '/preview/' + pvPort + p;
    pvRemember();
  }
  $('#pv-reload').addEventListener('click', () => { loadPorts(); show(); });
  $('#pv-open').addEventListener('click', () => { if (pvPort) window.open('/preview/' + pvPort + ($('#pv-path').value || '/'), '_blank'); });
  $('#pv-path').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); show(); } });
  pvFrame.addEventListener('load', () => { pvNote.classList.add('hidden'); });
  menuFor('#pv-port', '#pv-port-menu', (m) => {
    m.innerHTML = '';
    if (!pvPorts.length) { m.appendChild(el('div', 'muted small pad', 'Nothing is listening.')); return; }
    m.appendChild(el('div', 'menu-title', 'Listening on this machine'));
    for (const p of pvPorts) {
      m.appendChild(item(String(p.port), p.label || p.process || '', p.port === pvPort, () => { m.classList.add('hidden'); usePort(p.port); }));
    }
  });

  // ---------- Changes: the files this folder has changed, and their diffs (Desktop's Changes pane) ----------
  const changesPanel = $('#changes-panel'), chList = $('#ch-list'), chDiff = $('#ch-diff');
  let changesOpen = false, changesData = null, changesFile = null;
  function openChanges() { if (tasksOpen) closeTasks(); if (previewOpen) closePreview(); changesOpen = true; changesPanel.classList.remove('hidden'); app.classList.add('panel-open'); showChangesList(); loadChanges(); }
  function closeChanges() { changesOpen = false; changesFile = null; changesPanel.classList.add('hidden'); app.classList.remove('panel-open'); }
  $('#ch-close').addEventListener('click', closeChanges);
  $('#ch-refresh').addEventListener('click', () => loadChanges());
  $('#ch-back').addEventListener('click', () => showChangesList());
  $('#sb-diff').addEventListener('click', () => changesOpen ? closeChanges() : openChanges());
  function showChangesList() { changesFile = null; chDiff.classList.add('hidden'); chList.classList.remove('hidden'); $('#ch-back').classList.add('hidden'); $('#ch-file').textContent = ''; }
  async function loadChanges() {
    if (!state.current) return;
    try {
      changesData = await api(`/sessions/${state.current}/changes`);
      paintChanges();
      if (changesFile) loadDiff(changesFile);
    } catch (e) { chList.innerHTML = ''; chList.appendChild(el('div', 'muted small pad', e.message)); }
  }
  const fmtN = (n) => Number(n || 0).toLocaleString();
  function paintChanges() {
    const d = changesData; chList.innerHTML = '';
    if (!d || !d.git) { $('#ch-meta').textContent = ''; chList.appendChild(el('div', 'muted small pad', 'This folder is not a git repository.')); return; }
    $('#ch-meta').textContent = d.branch + ' · ' + d.files.length + (d.files.length === 1 ? ' file' : ' files');
    $('#ch-stat').innerHTML = d.files.length ? `<span class="add">+${fmtN(d.added)}</span> <span class="del">−${fmtN(d.removed)}</span>` : '';
    if (!d.files.length) { chList.appendChild(el('div', 'muted small pad', 'No uncommitted changes.')); return; }
    for (const f of d.files) {
      const row = el('button', 'ch-row'); row.type = 'button'; row.title = f.path;
      const st = el('span', 'ch-st st-' + (f.status === '?' ? 'A' : f.status), f.status === '?' ? 'A' : f.status);
      const name = el('span', 'ch-name');
      const i = f.path.lastIndexOf('/');
      if (i >= 0) name.appendChild(el('span', 'ch-dir', f.path.slice(0, i + 1)));
      name.appendChild(el('span', 'ch-base', f.path.slice(i + 1)));
      const n = el('span', 'ch-n');
      n.innerHTML = f.binary ? '<span class="muted">binary</span>' : `<span class="add">+${fmtN(f.added)}</span> <span class="del">−${fmtN(f.removed)}</span>`;
      row.appendChild(st); row.appendChild(name); row.appendChild(n);
      row.addEventListener('click', () => loadDiff(f.path));
      chList.appendChild(row);
    }
  }
  async function loadDiff(rel) {
    changesFile = rel;
    chList.classList.add('hidden'); chDiff.classList.remove('hidden'); $('#ch-back').classList.remove('hidden');
    $('#ch-file').textContent = rel; $('#ch-file').title = rel;
    chDiff.innerHTML = ''; chDiff.appendChild(el('div', 'muted small pad', 'Loading…'));
    try {
      const r = await api(`/sessions/${state.current}/changes/diff?path=${encodeURIComponent(rel)}`);
      chDiff.innerHTML = '';
      if (r.binary) { chDiff.appendChild(el('div', 'muted small pad', 'Binary file.')); return; }
      if (r.missing) { chDiff.appendChild(el('div', 'muted small pad', 'The file is gone.')); return; }
      if (!r.diff) { chDiff.appendChild(el('div', 'muted small pad', 'No differences.')); return; }
      chDiff.appendChild(renderDiff(r.diff));
      if (r.truncated) chDiff.appendChild(el('div', 'muted small pad', 'Showing the first 4,000 lines.'));
    } catch (e) { chDiff.innerHTML = ''; chDiff.appendChild(el('div', 'muted small pad', e.message)); }
  }
  // A unified diff as rows: old/new line numbers, then the line. Hunk headers stay as dividers.
  function renderDiff(text) {
    const pre = el('div', 'diff');
    let o = 0, n = 0;
    for (const raw of text.split('\n')) {
      if (raw.startsWith('diff --git') || raw.startsWith('index ') || raw.startsWith('--- ') || raw.startsWith('+++ ') || raw.startsWith('new file') || raw.startsWith('deleted file') || raw.startsWith('similarity') || raw.startsWith('rename ') || raw.startsWith('old mode') || raw.startsWith('new mode')) continue;
      const line = el('div', 'dl');
      if (raw.startsWith('@@')) {
        const m = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/); if (m) { o = Number(m[1]); n = Number(m[2]); }
        line.className = 'dl hunk'; line.appendChild(el('span', 'no', '')); line.appendChild(el('span', 'no', '')); line.appendChild(el('span', 'tx', m ? '@@ ' + (m[3] || '').trim() : raw));
        pre.appendChild(line); continue;
      }
      if (raw.startsWith('\\')) continue; // "No newline at end of file"
      const kind = raw[0] === '+' ? 'add' : raw[0] === '-' ? 'del' : 'ctx';
      line.classList.add(kind);
      line.appendChild(el('span', 'no', kind === 'add' ? '' : String(o)));
      line.appendChild(el('span', 'no', kind === 'del' ? '' : String(n)));
      line.appendChild(el('span', 'tx', raw.slice(1)));
      if (kind !== 'add') o++; if (kind !== 'del') n++;
      pre.appendChild(line);
    }
    return pre;
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
    const hasText = !!$('#input').value.trim() || pending.length > 0;
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
    input.placeholder = on ? 'Claude is working on this chat in another window…' : (state.current ? 'Type / for commands' : 'Describe a task or ask a question');
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
          const text = stripHarness(ev.text); const images = ev.images || [];
          if (!text && !images.length) break;
          state.live = null; thread.appendChild(userMsg(text, { images })); autoscroll(); break;
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
          else thread.appendChild(userMsg(ev.text, { id: ev.id, images: ev.images || [] }));
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
        case 'context': usage.context = ev; paintUsage(); break;
        case 'limits': usage.limits = ev; paintUsage(); break;
        case 'tool_progress': status.tool = ev.tool; if (!status.toolSince) status.toolSince = Date.now() - (ev.elapsed || 0) * 1000; statusPaint(); break;
        case 'usage': if (ev.outputTokens) { status.tokens = ev.outputTokens; statusPaint(); } break;
        case 'tool_summary': { // the CLI's own wording ("Ran 3 commands") for the open group
          const g = state.live?.group; if (g && ev.summary) { g._fromCli = true; setGroupSummary(g, ev.summary); const d = groupDiff(g._names, g._inputs); if (d.add || d.del) { const st = el('span', 'group-diff'); st.innerHTML = `<span class="add">+${d.add.toLocaleString()}</span> <span class="del">−${d.del.toLocaleString()}</span>`; g.querySelector('summary').appendChild(st); } }
          break;
        }
        case 'tasks': state.tasks = ev.tasks || []; paintTasks(); break;
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
          if (ev.isError) authNote(ev.text);
          if (state.live) addActions(state.live, Date.now());
          state.live = null; statusStop(); refreshGit();
          if (document.visibilityState === 'visible') markRead(sessionId); // finished in front of you: no dot
          if (changesOpen) loadChanges();
          break;
        case 'error': authNote(ev.text); break;
        case 'stderr': console.warn('[claude]', ev.text); break;
        case 'done':
          setRunning(false); state.live = null; es.close(); loadSessions(); state.tasks = []; paintTasks();
          // keep watching the file in case another window continues this chat
          if (state.current === sessionId) setTimeout(() => { if (state.current === sessionId && !state.running) subscribe(sessionId); }, 500);
          break;
      }
    };
    es.onerror = () => { /* EventSource retries by itself with Last-Event-ID */ };
  }
  // An error that smells like a dead token gets a button straight to the account dialog.
  function authNote(text) {
    const n = el('div', 'note error', text || 'Something went wrong.');
    if (/401|invalid|expired|authenticat|not logged in|api key|oauth/i.test(text || '')) {
      n.appendChild(document.createTextNode(' '));
      const b = el('button', 'link-btn inline', 'Update token or switch account'); b.type = 'button';
      b.addEventListener('click', openAccounts); n.appendChild(b);
    }
    thread.appendChild(n); autoscroll();
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
  function applyPrefill() { if (!pendingPrefill) return false; input.value = pendingPrefill; pendingPrefill = ''; input.dispatchEvent(new Event('input')); input.focus(); return true; }
  function restoreDraft(id) {
    if (applyPrefill()) return;
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
  send.addEventListener('click', () => { if (state.running && !input.value.trim() && !pending.length) stop(); else submit(); });

  // ---------- attachments: images go to Claude as images; other files are saved on the PC and referenced ----------
  const pending = []; // { kind: 'image'|'file', name, media_type, data (base64), dataUrl }
  const strip = $('#attachments');
  function renderPending() {
    strip.innerHTML = ''; strip.classList.toggle('hidden', !pending.length);
    pending.forEach((a, i) => {
      const chip = el('div', 'att' + (a.kind === 'image' ? ' att-img' : ''));
      if (a.kind === 'image') { const im = el('img'); im.src = a.dataUrl; chip.appendChild(im); } else chip.appendChild(el('span', 'att-name', a.name));
      const x = el('button', 'att-x'); x.type = 'button'; x.title = 'Remove'; x.textContent = '×';
      x.addEventListener('click', () => { pending.splice(i, 1); renderPending(); paintSendButton(); });
      chip.appendChild(x); strip.appendChild(chip);
    });
    paintSendButton();
  }
  const readAsDataUrl = (blob) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(blob); });
  // Big photos are shrunk (longest side 1600px) so they upload fast and stay under the API's image limits.
  async function prepareImage(file) {
    const url = await readAsDataUrl(file);
    if (file.size < 1200 * 1024 && /^image\/(png|jpeg|webp|gif)$/.test(file.type)) return { kind: 'image', name: file.name, media_type: file.type, data: url.split(',')[1], dataUrl: url };
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
    const c = document.createElement('canvas'); c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    const out = c.toDataURL('image/jpeg', 0.85);
    return { kind: 'image', name: file.name.replace(/\.\w+$/, '') + '.jpg', media_type: 'image/jpeg', data: out.split(',')[1], dataUrl: out };
  }
  async function addFiles(files) {
    for (const f of files) {
      if (pending.length >= 10) break;
      try {
        if (f.type.startsWith('image/')) pending.push(await prepareImage(f));
        else if (f.size <= 25 * 1024 * 1024) pending.push({ kind: 'file', name: f.name, media_type: f.type || 'application/octet-stream', data: (await readAsDataUrl(f)).split(',')[1] });
        else thread.appendChild(el('div', 'note error', f.name + ' is larger than 25 MB.'));
      } catch (e) { thread.appendChild(el('div', 'note error', 'Could not read ' + f.name)); }
    }
    renderPending();
  }
  $('#file-input').addEventListener('change', () => { addFiles([...$('#file-input').files]); $('#file-input').value = ''; });
  // Paste: a screenshot from the clipboard (Windows, Android, iOS) arrives as items, sometimes as files.
  function pastedFiles(e) {
    const out = [...(e.clipboardData?.files || [])];
    if (!out.length) for (const it of e.clipboardData?.items || []) { if (it.kind === 'file') { const f = it.getAsFile(); if (f) out.push(f); } }
    return out;
  }
  input.addEventListener('paste', (e) => { const files = pastedFiles(e); if (files.length) { e.preventDefault(); addFiles(files); } });
  document.addEventListener('paste', (e) => { if (e.target === input || $('#app').classList.contains('hidden')) return; const files = pastedFiles(e); if (files.length) { e.preventDefault(); addFiles(files); input.focus(); } });
  for (const evn of ['dragover', 'dragenter']) document.addEventListener(evn, (e) => { if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); $('#composer').classList.add('drop'); } });
  document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) $('#composer').classList.remove('drop'); });
  document.addEventListener('drop', (e) => { $('#composer').classList.remove('drop'); if (e.dataTransfer?.files?.length) { e.preventDefault(); addFiles([...e.dataTransfer.files]); } });

  async function submit() {
    const text = input.value.trim(); if (!text && !pending.length) return;
    const attachments = pending.filter((a) => a.kind === 'image').map((a) => ({ media_type: a.media_type, data: a.data }));
    const files = pending.filter((a) => a.kind === 'file').map((a) => ({ name: a.name, media_type: a.media_type, data: a.data }));
    const images = pending.filter((a) => a.kind === 'image').map((a) => a.dataUrl);
    const shown = text || (files.length ? files.map((f) => f.name).join(', ') : '');
    pending.length = 0; renderPending();
    input.value = ''; input.style.height = 'auto'; try { localStorage.removeItem(draftKey(state.current)); } catch {}
    empty.classList.remove('show'); stickToBottom = true;
    const body = { text, attachments, files };
    // Claude is mid-turn on this chat: the message is queued and runs right after, like Desktop.
    if (state.running && state.current) {
      const ghost = userMsg(shown, { queued: true, images }); thread.appendChild(ghost); statusPaint(); autoscroll(); paintSendButton();
      try { const r = await api(`/sessions/${state.current}/send`, { method: 'POST', body: JSON.stringify(body) }); if (r.id) ghost.dataset.promptId = r.id; }
      catch (e) { ghost.remove(); thread.appendChild(el('div', 'note error', e.message)); }
      return;
    }
    thread.appendChild(userMsg(shown, { images })); autoscroll();
    setRunning(true);
    try {
      if (state.current) {
        await api(`/sessions/${state.current}/send`, { method: 'POST', body: JSON.stringify({ ...body, ...turnOptions() }) });
        subscribe(state.current, { since: 0 }); // event 0 is our own prompt, already on screen
      } else {
        const r = await api('/sessions', { method: 'POST', body: JSON.stringify({ ...body, cwd: state.cwd || '~', ...turnOptions() }) });
        state.current = r.sessionId;
        history.replaceState(null, '', '#/s/' + r.sessionId);
        app.classList.remove('new');
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
    state.current = id; state.live = null; state.tasks = []; hiddenTasks.clear(); paintTasks(); if (changesOpen) closeChanges(); if (previewOpen) closePreview();
    if (state.es) { state.es.close(); state.es = null; }
    app.classList.remove('sidebar-open'); app.classList.remove('new');
    empty.classList.remove('show'); thread.innerHTML = '<div class="muted small pad">Loading…</div>';
    renderSessions();
    try {
      const info = await api('/sessions/' + id);
      // A turn started here and still running is replayed by the live stream from
      // its prompt onwards, so the history stops just before it.
      const messages = await api(`/sessions/${id}/messages` + (info.live && info.runStartedAt ? '?before=' + info.runStartedAt : ''));
      $('#chat-title').textContent = info.title;
      applySessionSettings(info.settings);
      $('#chat-meta').textContent = info.project || '';
      $('#chat-meta').title = [info.cwd, info.branch && 'Branch: ' + info.branch].filter(Boolean).join('\n');
      state.cwd = info.cwd || state.cwd; renderProjectChip(); $('#project-btn').classList.add('locked');
      renderHistory(messages);
      // The last turn never finished (the app or the PC restarted mid-work): say so, offer to go on.
      if (info.interrupted) {
        const n = el('div', 'interrupted');
        n.appendChild(el('span', null, info.interrupted.kind === 'tool_call' ? 'This turn stopped in the middle of a tool call' + (info.interrupted.at ? ' (' + relTime(Date.parse(info.interrupted.at)) + ' ago)' : '') + '. The app or the computer was restarted before Claude finished.' : 'This turn stopped before Claude answered' + (info.interrupted.at ? ' (' + relTime(Date.parse(info.interrupted.at)) + ' ago)' : '') + '.'));
        const b = el('button', 'btn btn-ghost', 'Continue where it left off'); b.type = 'button';
        b.addEventListener('click', () => { n.remove(); input.value = 'Continue where you left off. Check what was already done before redoing anything, then finish the task.'; input.dispatchEvent(new Event('input')); submit(); });
        n.appendChild(b); thread.appendChild(n);
      }
      stickToBottom = true; scroll.scrollTop = scroll.scrollHeight;
      setRunning(false); setElsewhere(false);
      markRead(id);
      subscribe(id); // streams our own turn, or follows the file if another window is working
      restoreDraft(id);
      usage.context = info.context || null; paintUsage(); refreshGit(); $('#session-menu-btn').classList.remove('hidden'); $('#new-bar').classList.add('hidden');
      input.placeholder = 'Type / for commands';
      api(`/sessions/${id}/usage`).then((u) => { usage.context = u.context || usage.context; usage.limits = u.limits || usage.limits; paintUsage(); }).catch(() => {});
    } catch (e) { thread.innerHTML = ''; thread.appendChild(el('div', 'note error', e.message)); }
    input.focus();
  }
  function openNew() {
    state.current = null; state.live = null; state.tasks = []; hiddenTasks.clear(); paintTasks(); if (changesOpen) closeChanges();
    if (state.es) { state.es.close(); state.es = null; }
    app.classList.remove('sidebar-open');
    thread.innerHTML = ''; empty.classList.add('show'); app.classList.add('new');
    $('#chat-title').textContent = 'New session'; $('#chat-meta').textContent = '';
    restoreDeviceDefaults();
    $('#project-btn').classList.remove('locked'); renderProjectChip();
    setRunning(false); setElsewhere(false); renderSessions(); updatePinButton(); restoreDraft(null);
    $('#session-bar').classList.add('hidden'); $('#new-bar').classList.remove('hidden'); $('#session-menu-btn').classList.add('hidden'); usage.context = null; paintUsage();
    input.placeholder = 'Describe a task or ask a question';
    const h = new Date().getHours();
    $('#greeting-text').textContent = (h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening') + (state.userName ? ', ' + state.userName : '');
    input.focus();
  }
  const isPhone = () => window.matchMedia('(max-width: 860px)').matches;
  let cameBack = false, hadSession = false;
  window.addEventListener('popstate', () => { cameBack = true; });
  function route() {
    const m = location.hash.match(/^#\/s\/([0-9a-f-]{36})$/i);
    if (m) { openSession(m[1]); hadSession = true; }
    else {
      openNew();
      // Back from a session on the phone lands on the session list, like the mobile app.
      if (isPhone() && cameBack && hadSession) app.classList.add('sidebar-open');
      hadSession = false;
    }
    cameBack = false;
  }
  window.addEventListener('hashchange', route);
  // Swipe from the left edge opens the list; swipe the list to the left closes it.
  let sw = null;
  document.addEventListener('touchstart', (e) => { if (!isPhone()) return; const t = e.touches[0]; sw = { x: t.clientX, y: t.clientY, edge: t.clientX < 28, inSidebar: !!e.target.closest('#sidebar') }; }, { passive: true });
  document.addEventListener('touchmove', (e) => {
    if (!sw) return; const t = e.touches[0]; const dx = t.clientX - sw.x, dy = t.clientY - sw.y;
    if (Math.abs(dy) > 50) { sw = null; return; }
    if (sw.edge && dx > 60 && !app.classList.contains('sidebar-open')) { app.classList.add('sidebar-open'); sw = null; }
    else if (sw.inSidebar && dx < -60 && app.classList.contains('sidebar-open')) { app.classList.remove('sidebar-open'); sw = null; }
  }, { passive: true });
  document.addEventListener('touchend', () => { sw = null; }, { passive: true });

  // ---------- boot ----------
  // The window reloads as soon as the server says it is restarting, so the first
  // fetches often land while it is still coming up. Retry, with a note, instead
  // of leaving a dead page that only a full restart of the app clears.
  function bootNote(text) {
    let n = $('#boot-note');
    if (!text) { n?.remove(); return; }
    if (!n) { n = el('div', 'boot-note'); n.id = 'boot-note'; document.body.appendChild(n); }
    n.textContent = text;
  }
  async function untilServer(fn, seconds = 45) {
    let last;
    for (let i = 0; i <= seconds; i++) {
      try { const v = await fn(); bootNote(''); return v; } catch (e) { last = e; }
      bootNote(i < 2 ? 'Connecting…' : 'Waiting for the server to come back… ' + i + 's');
      await new Promise((r) => setTimeout(r, 1000));
    }
    bootNote('');
    throw last;
  }
  async function boot() {
    // No app password configured? Then no login screen: just fetch the session token.
    if (!state.token) {
      let cfg = {};
      try { cfg = await untilServer(async () => (await fetch('/api/config')).json()); } catch { return showLogin(); }
      if (cfg.passwordRequired) return showLogin();
      try { await untilServer(() => login('')); } catch { return showLogin(); }
    }
    let me;
    try { me = await untilServer(() => refreshMe()); } catch { return showLogin(); }
    $('#login').classList.add('hidden'); $('#app').classList.remove('hidden');
    try { const o = await api('/order'); state.order = { projects: o.projects || [], sessions: o.sessions || {}, pinned: o.pinned || [] }; } catch {}
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
