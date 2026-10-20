// Contacts: list with search, sort, filter and groups; direct messages; contact actions; discovered nodes; importing.
(function (root) {
  'use strict';
  var el = UI.el, W = root.W, S = W.S, T = MC.TYPE;
  var sp, chat = null, hub = null, prefs = W.store.get('mcw2:cprefs', { sort: 'recent', filter: 'all', group: '' });
  var TYPE_NAME = { 1: 'Companion', 2: 'Repeater', 3: 'Room', 4: 'Sensor' };
  var TYPE_ICON = { 1: null, 2: 'cell', 3: 'door', 4: 'sensor' };
  var FAV = 1;

  function pathLabel(c) {
    if (c.pathLen === MC.FLOOD) return 'Flood';
    if (c.hops === 0) return 'Direct';
    return c.hops + (c.hops === 1 ? ' hop' : ' hops');
  }
  function lastTouch(c) { var l = S.convs[c.key]; return Math.max(c.lastAdvert || 0, l && l.length ? l[l.length - 1].ts : 0); }
  function lastMsg(c) { var l = S.convs[c.key]; return l && l.length ? l[l.length - 1].ts : 0; }
  function avatarFor(c) { var a = UI.avatar(c.name, { icon: TYPE_ICON[c.type] }); if (c.type > 1) a.classList.add('t' + c.type); return a; }
  function saveSort() { W.store.set('mcw2:cprefs', prefs); }

  function filtered() {
    var q = sp.search.value.trim().toLowerCase(), g = prefs.group && S.groups[prefs.group];
    var list = Object.keys(S.contacts).map(function (k) { return S.contacts[k]; }).filter(function (c) {
      if (q && c.name.toLowerCase().indexOf(q) < 0 && c.key.indexOf(q) !== 0) return false;
      if (g && g.indexOf(c.key) < 0) return false;
      switch (prefs.filter) {
        case 'fav': return (c.flags & FAV) === FAV;
        case 'users': return c.type === T.CHAT;
        case 'repeaters': return c.type === T.REPEATER;
        case 'rooms': return c.type === T.ROOM;
        case 'sensors': return c.type === T.SENSOR;
        case 'unread': return (S.unread[c.key] || 0) > 0;
      }
      return true;
    });
    list.sort(function (a, b) {
      if (prefs.sort === 'az') return a.name.localeCompare(b.name);
      if (prefs.sort === 'msg') return lastMsg(b) - lastMsg(a) || a.name.localeCompare(b.name);
      return lastTouch(b) - lastTouch(a) || a.name.localeCompare(b.name);
    });
    return list;
  }

  function renderList() {
    UI.clear(sp.rows);
    var list = filtered(), cur = decodeURIComponent(location.hash.split('/')[2] || '');
    var disc = Object.keys(S.discovered).filter(function (k) { return !S.contacts[k]; }).length;
    if (disc) sp.rows.appendChild(el('button', { class: 'row', type: 'button', onclick: showDiscovered }, [UI.avatar('', { icon: 'search', hue: 40 }), el('div', { class: 't' }, [el('b', { text: disc + ' discovered ' + (disc === 1 ? 'node' : 'nodes') }), el('small', { text: 'Heard on the radio, not added yet' })])]));
    if (S.loading.contacts && !list.length) { sp.rows.appendChild(el('div', { class: 'empty', text: 'Reading contacts from the node…' })); return; }
    if (!list.length) {
      var hasAny = Object.keys(S.contacts).length > 0;
      sp.rows.appendChild(el('div', { class: 'empty' }, [el('h3', { text: hasAny ? 'No matches' : 'No contacts yet' }),
        el('p', { text: hasAny ? 'Try another search or filter.' : 'Send an advert from Tools, or wait to hear other nodes. Contacts appear as they advertise.' })]));
      return;
    }
    list.forEach(function (c) {
      var un = S.unread[c.key] || 0, fav = (c.flags & FAV) === FAV;
      sp.rows.appendChild(el('button', { class: 'row' + (cur === c.key ? ' sel' : ''), type: 'button', role: 'listitem', onclick: function () { App.go('contacts', c.key); } }, [
        avatarFor(c), el('div', { class: 't' }, [el('b', { text: c.name || '(no name)' }), el('small', { text: pathLabel(c) + ' · ' + UI.short(c.key) })]),
        el('div', { class: 'side' }, [el('span', { text: UI.ago(lastTouch(c)) }), el('span', { style: 'display:flex;gap:4px;align-items:center' }, [
          fav ? UI.icon('star', 14) : null, (c.lat || c.lon) ? UI.icon('pin', 14) : null, un ? el('span', { class: 'badge', text: un }) : null])])]));
    });
  }

  function show(arg) {
    var key = arg || '';
    if (chat) { chat.destroy(); chat = null; }
    if (hub) { hub.destroy(); hub = null; }
    renderList();
    var c = S.contacts[key];
    if (!c) {
      sp.open(false);
      sp.placeholder('users', key ? 'Contact not found' : 'Pick a contact', key ? 'It may not be on the node any more.' : 'Companions can be messaged, rooms joined, repeaters managed.');
      return;
    }
    sp.open(true);
    if (c.type === T.REPEATER && W.repeaterHub) { hub = W.repeaterHub(sp.detail, c, { onBack: back, menu: function () { return contactMenu(c); } }); return; }
    if (c.type === T.ROOM && !roomIn[c.key]) { roomLogin(c); return; }
    openChat(c);
  }
  function back() { App.go('contacts', ''); }
  var roomIn = {};
  function openChat(c) {
    chat = Chat.open(sp.detail, {
      conv: c.key, kind: 'dm', canSend: c.type !== T.SENSOR, emptyHint: c.type === T.ROOM ? 'Posts to this room go to everyone in it.' : 'Messages are end-to-end encrypted to ' + c.name + '.',
      title: function () { var x = S.contacts[c.key] || c; return x.name; },
      subtitle: function () { var x = S.contacts[c.key] || c; return TYPE_NAME[x.type] + ' · ' + pathLabel(x) + ' · heard ' + UI.ago(x.lastAdvert); },
      avatar: function () { return avatarFor(S.contacts[c.key] || c); }, onBack: back, menu: function () { return contactMenu(S.contacts[c.key] || c); }
    });
  }
  function roomLogin(c) {
    UI.clear(sp.detail);
    sp.detail.appendChild(el('div', { class: 'dtop' }, [UI.btn('', { icon: 'back', kind: 'ghost back', title: 'Back', onclick: back }), avatarFor(c), el('div', { class: 't' }, [el('b', { text: c.name }), el('small', { text: 'Room · sign in to join' })])]));
    var pw = el('input', { type: 'password', placeholder: 'Room password (empty for guest)', maxlength: 15, autocomplete: 'off' }), msg = el('p', { class: 'dim' });
    var go = UI.btn('Sign in', { kind: 'primary', onclick: attempt });
    function attempt() {
      go.disabled = true; msg.textContent = 'Signing in…';
      login(c, pw.value).then(function () { roomIn[c.key] = true; show(c.key); }, function (e) { msg.textContent = e.message; go.disabled = false; });
    }
    pw.addEventListener('keydown', function (e) { if (e.key === 'Enter') attempt(); });
    sp.detail.appendChild(el('div', { class: 'page' }, [el('div', { class: 'card form' }, [el('h2', { text: 'Join ' + c.name }), pw, el('div', { class: 'btnrow' }, [go]), msg])]));
    pw.focus();
  }
  // CMD login: answered by SENT, then a login push when the far side answers
  function login(c, password) {
    return new Promise(function (res, rej) {
      var off = W.bus.on('push', function (m) {
        if ((m.t === 'loginOk' || m.t === 'loginFail') && c.key.indexOf(m.from) === 0) { off(); clearTimeout(t); if (m.t === 'loginOk') res(m); else rej(new Error('Wrong password, or no permission')); }
      });
      var t = setTimeout(function () { off(); rej(new Error('No answer. Out of range, or the route is not known yet.')); }, 25000);
      W.req(MC.enc.login(c.key, password), ['sent']).catch(function (e) { off(); clearTimeout(t); rej(e); });
    });
  }
  W.login = login;

  // ---- contact actions ----
  async function setFavourite(c) {
    var flags = c.flags ^ FAV;
    try { await W.req(MC.enc.updateContact(c, { flags: flags }), ['ok']); c.flags = flags; W.bus.emit('contacts'); UI.toast(flags & FAV ? 'Added to favourites' : 'Removed from favourites'); }
    catch (e) { UI.toast(e.message, 'bad'); }
  }
  function exportUri(c) {
    return W.req(MC.enc.exportContact(c.key), ['export']).then(function (r) { return 'meshcore://' + MC.hex(r.bytes, 0, r.bytes.length); });
  }
  function contactMenu(c) {
    var fav = (c.flags & FAV) === FAV;
    return [
      { label: 'Info…', icon: 'info', run: function () { info(c); } },
      { label: fav ? 'Remove favourite' : 'Make favourite', icon: 'star', run: function () { setFavourite(c); } },
      c.type === T.REPEATER || c.type === T.ROOM ? { label: 'Open as repeater…', icon: 'cell', run: function () { if (W.repeaterHub) { if (hub) hub.destroy(); UI.clear(sp.detail); hub = W.repeaterHub(sp.detail, c, { onBack: back, menu: function () { return contactMenu(c); } }); } } } : null,
      { label: 'Groups…', icon: 'users', run: function () { editMembership(c); } },
      { label: 'Forget the route', icon: 'route', run: function () { W.req(MC.enc.resetPath(c.key), ['ok']).then(function () { c.pathLen = MC.FLOOD; c.hops = -1; c.pathBytes = new Uint8Array(0); W.bus.emit('contacts'); UI.toast('Route cleared; the next message floods'); }, function (e) { UI.toast(e.message, 'bad'); }); } },
      { label: 'Find the route', icon: 'route', run: function () { W.req(MC.enc.pathDiscovery(c.key), ['sent']).then(function () { UI.toast('Looking for a route…'); }, function (e) { UI.toast(e.message, 'bad'); }); } },
      { label: 'Copy contact link', icon: 'copy', run: function () { exportUri(c).then(UI.copy, function (e) { UI.toast(e.message, 'bad'); }); } },
      { label: 'Share with nearby nodes', icon: 'antenna', run: function () { W.req(MC.enc.shareContact(c.key), ['ok']).then(function () { UI.toast('Shared'); }, function (e) { UI.toast(e.message, 'bad'); }); } },
      { sep: true },
      { label: 'Clear history in this browser', icon: 'trash', run: function () { W.clearConv(c.key); } },
      { label: 'Delete contact', icon: 'trash', danger: true, run: function () {
        UI.confirm('Delete contact', 'Remove ' + c.name + ' from the node? Their messages kept in this browser are removed too.', 'Delete', true).then(function (ok) {
          if (!ok) return;
          W.req(MC.enc.removeContact(c.key), ['ok']).then(function () { delete S.contacts[c.key]; W.clearConv(c.key); W.bus.emit('contacts'); back(); }, function (e) { UI.toast(e.message, 'bad'); });
        });
      } }
    ].filter(Boolean);
  }
  function info(c) {
    var rows = [['Name', c.name], ['Type', TYPE_NAME[c.type] || c.type], ['Public key', c.key], ['Route', pathLabel(c)],
      ['Route hops', c.pathBytes && c.pathBytes.length ? MC.hex(c.pathBytes, 0, c.pathBytes.length).match(new RegExp('.{1,' + c.pathWidth * 2 + '}', 'g')).join(' → ') : '—'],
      ['Last heard', c.lastAdvert ? new Date(c.lastAdvert * 1000).toLocaleString() + ' (' + UI.ago(c.lastAdvert) + ')' : 'never'],
      ['Position', c.lat || c.lon ? c.lat.toFixed(5) + ', ' + c.lon.toFixed(5) : 'not shared']];
    var dl = el('dl', { class: 'kv' }); rows.forEach(function (r) { dl.appendChild(el('dt', { text: r[0] })); dl.appendChild(el('dd', { class: r[0] === 'Public key' ? 'mono' : '', text: r[1] })); });
    UI.alert('Contact info', dl);
  }

  // ---- groups: a client-side way of sorting contacts, kept in this browser ----
  function editMembership(c) {
    var names = Object.keys(S.groups);
    var box = el('div');
    names.forEach(function (n) {
      var cb = el('input', { type: 'checkbox', checked: S.groups[n].indexOf(c.key) >= 0, onchange: function () {
        var l = S.groups[n], i = l.indexOf(c.key); if (cb.checked && i < 0) l.push(c.key); else if (!cb.checked && i >= 0) l.splice(i, 1); W.persist(); } });
      box.appendChild(el('label', { class: 'setrow' }, [el('div', { class: 't', text: n }), cb]));
    });
    if (!names.length) box.appendChild(el('p', { class: 'dim', text: 'No groups yet.' }));
    box.appendChild(UI.btn('New group…', { icon: 'plus', onclick: function () { newGroup().then(function () { var l = document.querySelector('.layer:last-child'); if (l) l.remove(); editMembership(c); }); } }));
    UI.dialog('Groups for ' + c.name, box, [{ label: 'Done', kind: 'primary', value: 1 }]);
  }
  function newGroup() {
    return UI.form('New group', [{ name: 'n', label: 'Name', required: true, maxlength: 24, validate: function (v) { v = v.trim().toLowerCase(); if (v === 'all') return '"all" is reserved'; return Object.keys(S.groups).some(function (g) { return g.toLowerCase() === v; }) ? 'That group exists' : ''; } }], 'Create').then(function (v) {
      if (v) { S.groups[v.n.trim()] = []; W.persist(); renderGroups(); } return v;
    });
  }
  var groupSel;
  function renderGroups() {
    if (!groupSel) return; UI.clear(groupSel);
    groupSel.appendChild(el('option', { value: '', text: 'All contacts' }));
    Object.keys(S.groups).forEach(function (g) { groupSel.appendChild(el('option', { value: g, text: g, selected: g === prefs.group })); });
    groupSel.hidden = !Object.keys(S.groups).length;
  }

  // ---- adding contacts ----
  function importLink() {
    UI.form('Add a contact', [{ name: 'uri', label: 'Contact link', required: true, type: 'textarea', rows: 3, placeholder: 'meshcore://…', hint: 'Paste a link copied from another MeshCore app or node.' }], 'Add').then(function (v) {
      if (!v) return;
      var h = v.uri.trim().replace(/^meshcore:\/\//i, '').replace(/\s+/g, '');
      if (!/^[0-9a-f]+$/i.test(h) || h.length % 2) { UI.toast('That is not a contact link', 'bad'); return; }
      W.req(MC.enc.importContact(MC.unhex(h)), ['ok']).then(function () { UI.toast('Contact added'); return W.loadContacts(); }, function (e) { UI.toast(e.message === 'value not accepted' ? 'The node did not accept that link' : e.message, 'bad'); });
    });
  }
  function showDiscovered() {
    var box = el('div', { class: 'rows' });
    function paint() {
      UI.clear(box);
      var keys = Object.keys(S.discovered).filter(function (k) { return !S.contacts[k]; }).sort(function (a, b) { return S.discovered[b].lastAdvert - S.discovered[a].lastAdvert; });
      if (!keys.length) box.appendChild(el('p', { class: 'dim', text: 'Nothing waiting. Nodes you hear that are not contacts will show up here.' }));
      keys.forEach(function (k) {
        var m = S.discovered[k];
        box.appendChild(el('div', { class: 'row' }, [avatarFor(m), el('div', { class: 't' }, [el('b', { text: m.name || '(no name)' }), el('small', { text: TYPE_NAME[m.type] + ' · ' + UI.ago(m.lastAdvert) })]),
          UI.btn('Add', { kind: 'small primary', onclick: function () {
            W.req(MC.enc.updateContact(m, {}), ['ok']).then(function () { delete S.discovered[k]; S.contacts[k] = m; W.bus.emit('contacts'); paint(); UI.toast('Added ' + m.name); }, function (e) { UI.toast(e.message, 'bad'); });
          } }),
          UI.btn('', { icon: 'x', kind: 'ghost small', title: 'Ignore', onclick: function () { delete S.discovered[k]; paint(); renderList(); } })]));
      });
    }
    paint(); UI.dialog('Discovered nodes', box, [{ label: 'Close', value: 0 }], { wide: true });
  }
  function advertMenu(anchor) {
    UI.menu(anchor, [
      { label: 'Add contact from a link…', icon: 'plus', run: importLink },
      { label: 'Discovered nodes…', icon: 'search', run: showDiscovered },
      { sep: true },
      { label: 'Advertise to nearby nodes', icon: 'antenna', run: function () { W.req(MC.enc.advert(false), ['ok']).then(function () { UI.toast('Advert sent (nearby)'); }, function (e) { UI.toast(e.message, 'bad'); }); } },
      { label: 'Advertise across the mesh', icon: 'antenna', run: function () { W.req(MC.enc.advert(true), ['ok']).then(function () { UI.toast('Advert sent (flood)'); }, function (e) { UI.toast(e.message, 'bad'); }); } },
      { label: 'Copy my contact link', icon: 'copy', run: function () { exportUri({ key: '' }).then(UI.copy, function (e) { UI.toast(e.message, 'bad'); }); } },
      { sep: true },
      { label: 'New group…', icon: 'users', run: newGroup },
      { label: 'Reload contacts', icon: 'refresh', run: function () { W.loadContacts().catch(function (e) { UI.toast(e.message, 'bad'); }); } }
    ]);
  }

  function mount(box) {
    sp = Split.make(box, 'Contacts');
    var more = UI.btn('', { icon: 'more', kind: 'ghost', title: 'Contact tools' }); more.onclick = function () { advertMenu(more); };
    sp.head.appendChild(more);
    function sel(label, key, opts) {
      var s = el('select', { class: 'sel', 'aria-label': label, onchange: function () { prefs[key] = s.value; saveSort(); renderList(); } },
        opts.map(function (o) { return el('option', { value: o[0], text: o[1], selected: o[0] === prefs[key] }); })); return s;
    }
    sp.tools.appendChild(sel('Filter', 'filter', [['all', 'All'], ['fav', 'Favourites'], ['users', 'People'], ['repeaters', 'Repeaters'], ['rooms', 'Rooms'], ['sensors', 'Sensors'], ['unread', 'Unread']]));
    sp.tools.appendChild(sel('Sort', 'sort', [['recent', 'Heard recently'], ['msg', 'Latest message'], ['az', 'A to Z']]));
    groupSel = el('select', { class: 'sel', 'aria-label': 'Group', onchange: function () { prefs.group = groupSel.value; saveSort(); renderList(); } });
    sp.tools.appendChild(groupSel); renderGroups();
    sp.onSearch(renderList);
    ['contacts', 'msg', 'unread', 'status'].forEach(function (ev) { W.bus.on(ev, function () { if (App.current() && App.current().id === 'contacts') renderList(); }); });
    W.bus.on('self', renderGroups);
    W.bus.on('advert', function (m) { if (S.self && !App.current() || (App.current() && App.current().id !== 'contacts')) UI.toast('Heard ' + (m.name || 'a new node') + ' (' + (TYPE_NAME[m.type] || 'node') + ')'); });
  }

  App.register({ id: 'contacts', title: 'Contacts', icon: 'users', mount: mount, show: show,
    badge: function () { var n = 0; for (var k in S.unread) if (k.indexOf('ch:') !== 0) n += S.unread[k] || 0; return n; } });
  W.contactMenu = contactMenu; W.typeName = TYPE_NAME; W.pathLabel = pathLabel;
})(window);
