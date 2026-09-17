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
  // Images in an answer that point at files on the PC (`![card](out/share.png)`,
  // `C:\...\shot.png`) are fetched through the server, so they show like in Desktop.
  const localFileUrl = (href) => `/api/file?token=${encodeURIComponent(state.token || '')}&cwd=${encodeURIComponent(state.cwd || '')}&path=${encodeURIComponent(href)}`;
  const isWebUrl = (h) => /^(https?:|data:|blob:)/i.test(h || '');
  const escapeAttr = (s) => String(s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const isVideo = (h) => /\.(mp4|webm|mov|m4v)(\?|#|$)/i.test(h || ''), isAudio = (h) => /\.(mp3|m4a|wav|ogg)(\?|#|$)/i.test(h || '');
  const mediaSrc = (href) => isWebUrl(href) ? href : localFileUrl(href.replace(/^file:\/\/\/?/i, ''));
  // Video and audio files an answer points at play inline (Desktop shows a player); images show as images.
  marked.use({ renderer: {
    image({ href, title, text }) {
      if (isVideo(href)) return `<video controls preload="metadata" class="md-video" src="${escapeAttr(mediaSrc(href))}"></video>`;
      if (isAudio(href)) return `<audio controls class="md-audio" src="${escapeAttr(mediaSrc(href))}"></audio>`;
      return `<img src="${escapeAttr(mediaSrc(href))}" alt="${escapeAttr(text)}"${title ? ` title="${escapeAttr(title)}"` : ''} loading="lazy" class="md-img">`;
    },
    link({ href, title, tokens }) {
      const inner = this.parser.parseInline(tokens);
      if (isVideo(href)) return `<video controls preload="metadata" class="md-video" src="${escapeAttr(mediaSrc(href))}"></video>`;
      if (isAudio(href)) return `<audio controls class="md-audio" src="${escapeAttr(mediaSrc(href))}"></audio>`;
      return `<a href="${escapeAttr(href)}"${title ? ` title="${escapeAttr(title)}"` : ''} target="_blank" rel="noopener">${inner}</a>`;
    },
  } });
  const md = (text) => DOMPurify.sanitize(marked.parse(text || ''), { USE_PROFILES: { html: true }, ADD_TAGS: ['video', 'audio'], ADD_ATTR: ['loading', 'controls', 'preload', 'target'] });
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

  // Right-click on a session row: the Desktop context menu.
  const ctx = $('#ctx-menu');
  function showCtxMenu(s, x, y) {
    ctx.innerHTML = '';
    const add = (label, hint, fn, cls) => { const b = item(label, '', false, () => { ctx.classList.add('hidden'); fn(); }, { hint }); if (cls) b.classList.add(cls); ctx.appendChild(b); };
    add('Open', '', () => { location.hash = '#/s/' + s.id; });
    ctx.appendChild(el('div', 'menu-sep'));
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

  function sessionRow(s) {
    const onBranch = s.branch && !/^(main|master)$/i.test(s.branch);
    const a = el('a', 'session-item' + (s.id === state.current ? ' active' : '') + (s.pinned ? ' pinned' : '') + (onBranch ? ' on-branch' : '') + (s.live || s.working ? ' working' : ''));
    a.href = '#/s/' + s.id; a.title = s.title + (s.branch ? '\nBranch: ' + s.branch : '');
    a.addEventListener('contextmenu', (e) => { e.preventDefault(); showCtxMenu(s, e.clientX, e.clientY); });
    // Long-press on the phone opens the same menu; the tap that ends it must not open the session.
    let pressTimer = null, pressed = false;
    a.addEventListener('touchstart', (e) => { pressed = false; const t = e.touches[0]; pressTimer = setTimeout(() => { pressed = true; showCtxMenu(s, t.clientX, t.clientY); if (navigator.vibrate) navigator.vibrate(10); }, 450); }, { passive: true });
    for (const evn of ['touchend', 'touchmove', 'touchcancel']) a.addEventListener(evn, () => clearTimeout(pressTimer), { passive: true });
    a.addEventListener('click', (e) => { if (pressed) { e.preventDefault(); e.stopPropagation(); pressed = false; } });
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
    const q = (state.search || '').trim().toLowerCase();
    const groups = new Map();
    for (const s of state.sessions) {
      if (q && !(s.title + ' ' + s.project + ' ' + s.branch).toLowerCase().includes(q)) continue;
      const k = s.project || 'Other'; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(s);
    }
    for (const [name, items] of groups) {
      const g = el('details', 'project-group'); g.open = q ? true : !collapsed.has(name);
      const sm = el('summary'); sm.innerHTML = CHEV_SVG; sm.appendChild(el('span', null, name)); sm.appendChild(el('span', 'cnt', String(items.length)));
      // "+" on the project row: a new session in that folder, like Desktop
      const add = el('button', 'proj-add'); add.type = 'button'; add.title = 'New session in ' + name;
      add.innerHTML = '<svg viewBox="0 0 20 20" width="14" height="14"><path d="M10 4v12M4 10h12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
      add.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); state.cwd = items[0].cwd; localStorage.setItem('cr.cwd', state.cwd); location.hash = '#/'; renderProjectChip(); });
      sm.appendChild(add);
      sm.title = items[0].cwd; g.appendChild(sm);
      for (const s of items) g.appendChild(sessionRow(s));
      g.addEventListener('toggle', () => { if (!q) rememberCollapsed(name, !g.open); });
      list.appendChild(g);
    }
    if (!state.sessions.length) list.appendChild(el('div', 'muted small pad', 'No sessions yet.'));
    if (q && !groups.size) list.appendChild(el('div', 'muted small pad', 'No sessions match.'));
    updatePinButton();
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
  // A change made while Claude is working is pushed to the running process and
  // takes effect for the next tool call / model request, like Shift+Tab in the CLI.
  async function pushControls(patch) {
    if (!state.current || !state.running) return;
    try { await api(`/sessions/${state.current}/controls`, { method: 'POST', body: JSON.stringify(patch) }); }
    catch (e) { thread.appendChild(el('div', 'note error', e.message)); }
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
      $('#sb-added').textContent = '+' + g.added; $('#sb-removed').textContent = '−' + g.removed;
      $('#sb-diff').classList.toggle('hidden', !g.dirty);
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
    m.appendChild(el('div', 'menu-sep'));
    m.appendChild(item(s.archived ? 'Unarchive' : 'Archive', '', false, async () => { m.classList.add('hidden'); try { await api(`/sessions/${state.current}/archive`, { method: 'POST', body: JSON.stringify({ archived: !s.archived }) }); await loadSessions(); if (!s.archived) location.hash = '#/'; } catch (e) { alert(e.message); } }, { hint: 'A' }));
    const del = item('Delete', '', false, async () => { m.classList.add('hidden'); if (!confirm('Delete this session from this computer? This cannot be undone.')) return; try { await api(`/sessions/${state.current}`, { method: 'DELETE' }); await loadSessions(); location.hash = '#/'; } catch (e) { alert(e.message); } }, { hint: 'D' });
    del.classList.add('danger'); m.appendChild(del);
  });

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
  const TOOL_KIND = { Bash: 'command', PowerShell: 'command', Read: 'read', Glob: 'search', Grep: 'search', Edit: 'edit', Write: 'write', NotebookEdit: 'edit', Agent: 'agent', WebFetch: 'web', WebSearch: 'web' };
  const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);
  function groupLabel(names) {
    const c = {}; for (const n of names) { const k = TOOL_KIND[n] || 'tool'; c[k] = (c[k] || 0) + 1; }
    const parts = [];
    if (c.command) parts.push('Ran ' + plural(c.command, 'command', 'commands'));
    if (c.read) parts.push('Read ' + plural(c.read, 'file', 'files'));
    if (c.search) parts.push('Searched ' + plural(c.search, 'time', 'times'));
    if (c.edit) parts.push('Edited ' + plural(c.edit, 'file', 'files'));
    if (c.write) parts.push('Wrote ' + plural(c.write, 'file', 'files'));
    if (c.agent) parts.push('Ran ' + plural(c.agent, 'agent', 'agents'));
    if (c.web) parts.push('Fetched ' + plural(c.web, 'page', 'pages'));
    if (c.tool) parts.push('Used ' + plural(c.tool, 'tool', 'tools'));
    if (!parts.length) return 'Worked';
    return parts.map((p, i) => i ? p[0].toLowerCase() + p.slice(1) : p).join(', ');
  }
  function toolGroupFor(msg) {
    if (msg.group && msg.group === msg.body.lastElementChild) return msg.group;
    const g = el('details', 'tool-group'); g.appendChild(el('summary', null, 'Working')); g.appendChild(el('div', 'group-body'));
    g._names = []; msg.body.appendChild(g); msg.group = g; return g;
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
        const g = toolGroupFor(msg); g.querySelector('.group-body').appendChild(node); g._names.push(block.name); if (!g._fromCli) setGroupSummary(g, groupLabel(g._names));
        msg.blocks.set(index, node); msg.tools.set(block.id, node);
      }
      node.querySelector('.arg').textContent = toolSummary(block.name, block.input);
      const b = node.querySelector('.step-body'); b.innerHTML = '';
      b.appendChild(el('div', 'label', 'Input'));
      const pre = el('pre', null, typeof block.input === 'string' ? block.input : JSON.stringify(block.input, null, 2)); b.appendChild(pre);
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
      const media = el(isAudio(p) ? 'audio' : 'video', isAudio(p) ? 'md-audio' : 'md-video');
      media.controls = true; media.preload = 'metadata'; media.src = localFileUrl(p);
      media.addEventListener('error', () => media.remove(), { once: true });
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

  function userMsg(text, { queued = false, id = null, images = [] } = {}) {
    const m = el('div', 'msg user' + (queued ? ' queued' : ''));
    if (id) m.dataset.promptId = id;
    m.appendChild(el('div', 'msg-avatar', (state.userName || 'U')[0].toUpperCase()));
    const b = el('div', 'msg-body'); b.dir = 'auto';
    if (images.length) {
      const strip = el('div', 'msg-images');
      for (const img of images) { const im = el('img'); im.src = typeof img === 'string' ? img : dataUrl(img); im.alt = 'attachment'; im.addEventListener('click', () => window.open(im.src, '_blank')); strip.appendChild(im); }
      b.appendChild(strip);
    }
    if (text) b.appendChild(el('div', 'msg-text', text));
    m.appendChild(b);
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
        if (text || images.length) { if (group) addActions(group, lastAt); thread.appendChild(userMsg(text, { images })); group = null; }
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
          const g = state.live?.group; if (g && ev.summary) { g._fromCli = true; setGroupSummary(g, ev.summary); }
          break;
        }
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
          if (state.live) addActions(state.live, Date.now());
          state.live = null; statusStop(); refreshGit();
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
  $('#attach-btn').addEventListener('click', () => $('#file-input').click());
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
    state.current = id; state.live = null;
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
      $('#chat-meta').textContent = info.project || '';
      $('#chat-meta').title = [info.cwd, info.branch && 'Branch: ' + info.branch].filter(Boolean).join('\n');
      state.cwd = info.cwd || state.cwd; renderProjectChip(); $('#project-btn').classList.add('locked');
      renderHistory(messages);
      stickToBottom = true; scroll.scrollTop = scroll.scrollHeight;
      setRunning(false); setElsewhere(false);
      subscribe(id); // streams our own turn, or follows the file if another window is working
      restoreDraft(id);
      usage.context = info.context || null; paintUsage(); refreshGit(); $('#session-menu-btn').classList.remove('hidden'); $('#new-bar').classList.add('hidden');
      input.placeholder = 'How can I help you today?';
    } catch (e) { thread.innerHTML = ''; thread.appendChild(el('div', 'note error', e.message)); }
    input.focus();
  }
  function openNew() {
    state.current = null; state.live = null;
    if (state.es) { state.es.close(); state.es = null; }
    app.classList.remove('sidebar-open');
    thread.innerHTML = ''; empty.classList.add('show'); app.classList.add('new');
    $('#chat-title').textContent = 'New session'; $('#chat-meta').textContent = '';
    $('#project-btn').classList.remove('locked'); renderProjectChip();
    setRunning(false); setElsewhere(false); renderSessions(); updatePinButton(); restoreDraft(null);
    $('#session-bar').classList.add('hidden'); $('#new-bar').classList.remove('hidden'); $('#session-menu-btn').classList.add('hidden'); usage.context = null; paintUsage();
    input.placeholder = 'Describe a task or ask a question';
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
