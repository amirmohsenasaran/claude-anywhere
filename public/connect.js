// The computer picker. It ships inside the app rather than being served, because it is
// what you use when the window is pointed at a machine that is not answering — and
// because the list of your computers belongs to this device, not to any server.
(() => {
  const $ = (s) => document.querySelector(s);
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const invoke = window.__TAURI__?.core?.invoke;

  let state = { active: 'local', items: [] };
  let defaultPassword = '';
  let editing = null; // id being edited, or null when adding
  // On a phone there is no Claude here to pick: the phone app is only ever a window onto
  // a computer that runs it, so the list starts empty and asks for that computer.
  let phone = false;

  // A command that fails rejects with the shell's own sentence; an Error only shows up
  // when something in here threw, and the word Error in front of it helps nobody.
  const say = (e) => String(e && e.message ? e.message : e);
  const note = (text, kind) => { const n = $('#note'); n.textContent = text || ''; n.className = 'note' + (kind ? ' ' + kind : ''); };
  // The shell brings the window back here when a computer would not load, and says why.
  // It arrives after this script has run, so it needs a door rather than a variable.
  window.__caNote = (text) => note(text, 'bad');

  if (!invoke) {
    $('#list').innerHTML = '';
    $('#list').appendChild(el('div', 'nowt', 'This page belongs to the desktop app. In a browser, you are already looking at one computer: this one.'));
    document.querySelector('.add').hidden = true;
    return;
  }

  async function load() {
    state = await invoke('connections_get');
    try { phone = ['android', 'ios'].includes((await invoke('app_version')).platform); } catch {}
    // Older shells do not have this command; an empty box is the old behaviour.
    try { defaultPassword = (await invoke('default_password')) || ''; } catch {}
    if (!editing && !$('#f-pass').value) $('#f-pass').value = defaultPassword;
    paint();
  }

  function paint() {
    const list = $('#list');
    list.innerHTML = '';
    if (!phone) list.appendChild(row({ id: 'local', name: 'This computer', url: 'Runs Claude here' }, true));
    for (const c of state.items) list.appendChild(row(c, false));
    if (!state.items.length) {
      const n = el('div', 'nowt', phone
        ? 'Add the computer that runs Claude: the address it shows under Settings → About, and its app password.'
        : 'No other computers yet. Add one below.');
      list.appendChild(n);
    }
  }

  function row(c, isLocal) {
    const r = el('div', 'row' + (state.active === c.id ? ' on' : ''));
    const who = el('div', 'who');
    who.appendChild(el('div', 'nm', c.name || c.url));
    who.appendChild(el('div', 'ad', isLocal ? c.url : c.url));
    r.appendChild(who);
    if (state.active === c.id) r.appendChild(el('span', 'tick', '✓ showing'));
    const use = el('button', 'btn' + (state.active === c.id ? '' : ' primary'), state.active === c.id ? 'Reload' : 'Use');
    use.type = 'button';
    use.addEventListener('click', async () => {
      use.disabled = true; use.textContent = 'Opening…';
      try { await invoke('connection_use', { id: c.id }); }
      catch (e) { note(say(e), 'bad'); use.disabled = false; use.textContent = 'Use'; }
    });
    r.appendChild(use);
    if (!isLocal) {
      const edit = el('button', 'btn', 'Edit'); edit.type = 'button';
      edit.addEventListener('click', () => startEdit(c));
      r.appendChild(edit);
      const rm = el('button', 'btn danger', 'Remove'); rm.type = 'button';
      rm.addEventListener('click', async () => {
        if (!confirm('Remove ' + (c.name || c.url) + ' from this list? Nothing on that computer changes.')) return;
        state = await invoke('connections_save', { items: state.items.filter((x) => x.id !== c.id) });
        if (editing === c.id) cancelEdit();
        paint();
      });
      r.appendChild(rm);
    }
    return r;
  }

  function startEdit(c) {
    editing = c.id;
    $('#f-url').value = c.url; $('#f-name').value = c.name; $('#f-pass').value = c.password || '';
    $('#add-title').textContent = 'Edit ' + (c.name || c.url);
    $('#save').textContent = 'Save';
    $('#cancel').hidden = false;
    note('');
    $('#f-url').focus();
  }
  function cancelEdit() {
    editing = null;
    $('#f-url').value = ''; $('#f-name').value = '';
    // One password, set once: a new computer starts with this one's, because that is
    // what people do anyway and typing it twice invents a second password by accident.
    $('#f-pass').value = defaultPassword;
    $('#add-title').textContent = 'Add a computer';
    $('#save').textContent = 'Add';
    $('#cancel').hidden = true;
    note(defaultPassword ? 'The password box holds this computer’s app password. Change it if that computer uses another one.' : '');
  }
  $('#cancel').addEventListener('click', cancelEdit);

  // A bare host means http and the usual port: nobody wants to type a scheme.
  function tidyUrl(raw) {
    let s = String(raw || '').trim();
    if (!s) return '';
    if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
    try {
      const u = new URL(s);
      if (!u.port && u.protocol === 'http:') u.port = '7777';
      return u.origin;
    } catch { return ''; }
  }

  $('#test').addEventListener('click', async () => {
    const url = tidyUrl($('#f-url').value);
    if (!url) return note('That does not look like an address.', 'bad');
    note('Asking ' + url + '…');
    try { note(await invoke('connection_test', { url, password: $('#f-pass').value }), 'good'); }
    catch (e) { note(say(e), 'bad'); }
  });

  $('#save').addEventListener('click', async () => {
    const url = tidyUrl($('#f-url').value);
    if (!url) return note('That does not look like an address.', 'bad');
    const item = {
      id: editing || 'c' + Date.now().toString(36),
      name: $('#f-name').value.trim() || new URL(url).hostname,
      url,
      password: $('#f-pass').value,
    };
    const items = editing ? state.items.map((x) => (x.id === editing ? item : x)) : [...state.items, item];
    state = await invoke('connections_save', { items });
    cancelEdit();
    paint();
    note('Saved. Press Use to open it.', 'good');
  });

  // The shell leaves a reason here when it could not reach the computer it was told to open.
  if (window.__caError) note(say(window.__caError), 'bad');
  load().catch((e) => note(say(e), 'bad'));
})();
