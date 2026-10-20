// Settings: this node (name, position, radio, privacy, contacts, regions), actions, and this browser's own preferences.
(function (root) {
  'use strict';
  var el = UI.el, W = root.W, S = W.S, box;
  var BWS = [7.8, 10.4, 15.6, 20.8, 31.25, 41.7, 62.5, 125, 250, 500];
  var TELE = [[0, 'Nobody'], [1, 'Contacts I allow'], [2, 'Everyone']];
  var AUTO = [[0x02, 'People (companions)'], [0x04, 'Repeaters'], [0x08, 'Room servers'], [0x10, 'Sensors'], [0x01, 'Replace the oldest when full']];

  function fail(e) { UI.toast(e.message, 'bad'); }
  async function refreshSelf() { S.self = await W.req(MC.enc.appStart('web'), ['self']); W.bus.emit('self'); render(); }
  async function refreshDevice() { S.dev = await W.req(MC.enc.deviceQuery(), ['device']); render(); }
  function row(title, sub, ctl, onclick) {
    var r = el('div', { class: 'setrow' + (onclick ? ' click' : ''), onclick: onclick, tabindex: onclick ? 0 : null, role: onclick ? 'button' : null }, [el('div', { class: 't' }, [el('b', { text: title }), sub ? el('small', { text: sub }) : null]), ctl]);
    if (onclick) r.addEventListener('keydown', function (e) { if (e.key === 'Enter') onclick(); });
    return r;
  }
  function toggle(on, change) {
    var cb = el('input', { type: 'checkbox', checked: !!on, 'aria-label': 'toggle' });
    cb.addEventListener('change', function () { change(cb.checked, cb); });
    return el('label', { class: 'switch' }, [cb, el('i')]);
  }
  function card(title, kids, sub) { return el('section', { class: 'card' }, [el('h2', {}, [title, sub ? el('small', { text: sub }) : null]), kids]); }
  function live() { return S.status === 'online' && S.self; }

  // ---- node ----
  function editName() {
    UI.form('Node name', [{ name: 'n', label: 'Name', value: S.self.name, maxlength: 31, required: true, hint: 'Shown to others when you advertise.' }], 'Save').then(function (v) {
      if (v) W.req(MC.enc.setName(v.n.trim()), ['ok']).then(function () { S.self.name = v.n.trim(); W.bus.emit('self'); render(); UI.toast('Name saved. Send an advert so others see it.'); }, fail);
    });
  }
  function editPosition() {
    UI.form('Position', [
      { name: 'lat', label: 'Latitude', value: S.self.lat ? S.self.lat.toFixed(6) : '', placeholder: '33.448400', validate: function (v) { v = v.trim(); return v === '' || (!isNaN(+v) && Math.abs(+v) <= 90) ? '' : 'Latitude is between -90 and 90'; } },
      { name: 'lon', label: 'Longitude', value: S.self.lon ? S.self.lon.toFixed(6) : '', placeholder: '-112.074000', validate: function (v) { v = v.trim(); return v === '' || (!isNaN(+v) && Math.abs(+v) <= 180) ? '' : 'Longitude is between -180 and 180'; } }
    ], 'Save', 'Leave both empty to remove the position. It is only shared if "Share position in adverts" is on.').then(function (v) {
      if (!v) return; var lat = v.lat.trim() === '' ? 0 : +v.lat, lon = v.lon.trim() === '' ? 0 : +v.lon;
      W.req(MC.enc.setLatLon(lat, lon), ['ok']).then(function () { S.self.lat = lat; S.self.lon = lon; render(); UI.toast('Position saved'); }, fail);
    });
  }
  function editRadio() {
    var s = S.self, maxTx = s.maxTxPower || 22, found = -1;
    PRESETS.forEach(function (p, i) { if (Math.abs(p[1] - s.freqMHz) < 0.002 && p[2] === s.bwKHz && p[3] === s.sf && p[4] === s.cr) found = i; });
    var presetOpts = [{ value: -1, label: found < 0 ? 'Custom' : 'Choose a preset…' }].concat(PRESETS.map(function (p, i) { return { value: i, label: p[0] + ' (' + p[1] + ' MHz)' }; }));
    var fields = [
      { name: 'preset', label: 'Preset', options: presetOpts, value: found },
      { name: 'freq', label: 'Frequency (MHz)', value: (s.freqMHz).toFixed(3), validate: function (v) { v = +v; return v >= 150 && v <= 2500 ? '' : 'Frequency is between 150 and 2500 MHz'; } },
      { name: 'bw', label: 'Bandwidth (kHz)', options: BWS.map(function (b) { return { value: b, label: String(b) }; }), value: s.bwKHz },
      { name: 'sf', label: 'Spreading factor', options: [5, 6, 7, 8, 9, 10, 11, 12].map(function (n) { return { value: n, label: 'SF' + n }; }), value: s.sf },
      { name: 'cr', label: 'Coding rate', options: [5, 6, 7, 8].map(function (n) { return { value: n, label: '4/' + n }; }), value: s.cr },
      { name: 'tx', label: 'Transmit power (dBm)', type: 'number', min: -9, max: maxTx, value: s.txPower, validate: function (v) { return v !== '' && +v >= -9 && +v <= maxTx ? '' : 'Power is between -9 and ' + maxTx + ' dBm'; }, hint: 'This board allows up to ' + maxTx + ' dBm.' }
    ];
    if (S.dev && S.dev.fwVer >= 9) fields.push({ name: 'rep', label: 'Client repeat (off-grid only: 433, 869 or 918 MHz)', type: 'check', value: !!S.dev.repeat });
    UI.form('Radio settings', fields, 'Apply', 'Every node on the mesh must use the same frequency, bandwidth, spreading factor and coding rate to hear each other.').then(function (v) {
      if (!v) return;
      var tx = +v.tx;
      W.req(MC.enc.setRadio(+v.freq, +v.bw, +v.sf, +v.cr, S.dev && S.dev.fwVer >= 9 ? v.rep : null), ['ok'])
        .then(function () { return W.req(MC.enc.setTxPower(tx), ['ok']); })
        .then(function () { UI.toast('Radio settings applied'); return refreshSelf().then(refreshDevice); }, fail);
    });
    var pre = document.getElementById('f-preset');
    if (pre) pre.addEventListener('change', function () {
      var p = PRESETS[+pre.value]; if (!p) return;
      document.getElementById('f-freq').value = p[1].toFixed(3); document.getElementById('f-bw').value = p[2]; document.getElementById('f-sf').value = p[3]; document.getElementById('f-cr').value = p[4];
    });
  }
  function setHash(mode) { W.req(MC.enc.setHashMode(mode), ['ok']).then(function () { S.dev.pathHashMode = mode; render(); UI.toast('Route detail set to ' + (mode + 1) + ' byte' + (mode ? 's' : '') + ' per hop'); }, fail); }
  function editPrivacy() {
    var s = S.self, dev = S.dev;
    var fields = [
      { name: 'loc', label: 'Share my position in adverts', type: 'check', value: s.advertLoc === 1 },
      { name: 'multi', label: 'Extra acknowledgements', options: [0, 1, 2, 3].map(function (n) { return { value: n, label: n ? n + ' extra' : 'Off' }; }), value: s.multiAcks, hint: 'Repeats acknowledgements to improve delivery over weak links, at the cost of airtime.' },
      { name: 'tb', label: 'Who may read my battery level', options: TELE.map(function (t) { return { value: t[0], label: t[1] }; }), value: s.teleBase },
      { name: 'tl', label: 'Who may read my position by telemetry', options: TELE.map(function (t) { return { value: t[0], label: t[1] }; }), value: s.teleLoc },
      { name: 'te', label: 'Who may read my sensors', options: TELE.map(function (t) { return { value: t[0], label: t[1] }; }), value: s.teleEnv }
    ];
    if (dev && dev.pingVisible != null) fields.push({ name: 'ping', label: 'Answer pings (let others see I am in range)', type: 'check', value: !!dev.pingVisible, hint: 'Off by default. Pings only reach nodes that hear this radio directly.' });
    UI.form('Privacy', fields, 'Save').then(function (v) {
      if (!v) return;
      var tele = (+v.tb) | (+v.tl) << 2 | (+v.te) << 4;
      W.req(MC.enc.setOther(s.manualAdd, tele, v.loc ? 1 : 0, +v.multi, dev && dev.pingVisible != null ? v.ping : null), ['ok'])
        .then(function () { return refreshSelf().then(refreshDevice); }).then(function () { UI.toast('Saved'); }, fail);
    });
  }
  function setAuto(flag, on) {
    var cur = S.autoAdd ? S.autoAdd.flags : 0, next = on ? cur | flag : cur & ~flag, hops = S.autoAdd ? S.autoAdd.maxHops : 0;
    var p = W.req(MC.enc.setAutoAdd(next, hops), ['ok']);
    if (!S.self.manualAdd) p = p.then(function () { return W.req(MC.enc.setOther(1, S.self.telemetry, S.self.advertLoc, S.self.multiAcks, S.dev && S.dev.pingVisible != null ? !!S.dev.pingVisible : null), ['ok']); });
    p.then(function () { S.autoAdd = { t: 'autoAdd', flags: next, maxHops: hops }; S.self.manualAdd = 1; render(); }, function (e) { fail(e); W.loadAutoAdd().then(render); });
  }
  function editMaxHops() {
    UI.form('Automatic adding: distance', [{ name: 'h', label: 'Only add nodes up to this many hops away (0 = any distance)', type: 'number', min: 0, max: 64, value: S.autoAdd ? S.autoAdd.maxHops : 0 }], 'Save').then(function (v) {
      if (v) W.req(MC.enc.setAutoAdd(S.autoAdd ? S.autoAdd.flags : 0, +v.h), ['ok']).then(function () { S.autoAdd.maxHops = +v.h; render(); }, fail);
    });
  }

  // ---- regions ----
  function validRegion(v) { return /^[a-z0-9-]{1,30}$/.test(v) ? '' : 'Use lower case letters, digits and hyphens, up to 30'; }
  function addRegion() {
    UI.form('Add a region', [{ name: 'r', label: 'Region name', required: true, maxlength: 31, validate: function (v) { v = v.trim().replace(/^#/, '').toLowerCase(); return validRegion(v) || (S.regions.indexOf(v) >= 0 ? 'Already in the list' : ''); }, hint: 'Use the exact name your local repeater operators set.' }], 'Add').then(function (v) {
      if (!v) return; S.regions.push(v.r.trim().replace(/^#/, '').toLowerCase()); W.persist(); render();
    });
  }
  function setDefaultRegion(name) {
    // the node keeps a default flood scope of its own, which it uses when the app sets none
    var p = name ? W.req(MC.enc.setDefaultScope(name, MCrypto.regionKey(name)), ['ok']) : W.req(MC.enc.setDefaultScope('', null), ['ok']);
    p.then(function () { S.defaultRegion = name; W.persist(); render(); }, function (e) { S.defaultRegion = name; W.persist(); render(); UI.toast('Saved here; the node did not take it (' + e.message + ')', 'bad'); });
  }

  // ---- actions ----
  function syncTime() { W.syncClock(true).then(function () { UI.toast('Node clock set'); render(); }, fail); }
  function reboot() { UI.confirm('Restart the node', 'The node restarts now. This page reconnects by itself.', 'Restart', true).then(function (ok) { if (ok) W.send(MC.enc.reboot()); }); }
  function resetPaths() {
    UI.confirm('Forget all routes', 'The node forgets every learned route. The next message to each contact floods until a route is learned again.', 'Forget', true).then(function (ok) {
      if (!ok) return; var keys = Object.keys(S.contacts), n = 0;
      keys.reduce(function (p, k) { return p.then(function () { return W.req(MC.enc.resetPath(k), ['ok']).then(function () { n++; }, function () { }); }); }, Promise.resolve()).then(function () { return W.loadContacts(); }).then(function () { UI.toast('Cleared ' + n + ' routes'); });
    });
  }
  function exportGpx(kind) {
    var list = Object.keys(S.contacts).map(function (k) { return S.contacts[k]; }).filter(function (c) { return (c.lat || c.lon) && (kind === 'all' || (kind === 'repeaters' ? c.type === 2 || c.type === 3 : c.type === 1)); });
    if (!list.length) { UI.toast('No contacts with a position', 'bad'); return; }
    function esc(s) { return s.replace(/[<>&"']/g, function (c) { return { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]; }); }
    var xml = '<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="MeshCore node page" xmlns="http://www.topografix.com/GPX/1/1">\n' +
      list.map(function (c) { return '<wpt lat="' + c.lat.toFixed(6) + '" lon="' + c.lon.toFixed(6) + '"><name>' + esc(c.name) + '</name><desc>' + (W.typeName[c.type] || '') + '</desc></wpt>'; }).join('\n') + '\n</gpx>\n';
    UI.download('meshcore-' + kind + '.gpx', xml, 'application/gpx+xml'); UI.toast('Exported ' + list.length + ' places');
  }

  // ---- this browser ----
  function seg(key, opts) {
    var d = el('div', { class: 'seg', role: 'group' });
    opts.forEach(function (o) { d.appendChild(el('button', { type: 'button', class: W.settings[key] === o[0] ? 'sel' : '', text: o[1], onclick: function () { W.setSetting(key, o[0]); render(); } })); });
    return d;
  }
  function render() {
    if (!box) return;
    var scroll = box.scrollTop, s = S.self, d = S.dev; UI.clear(box);
    var page = el('div', { class: 'page' });
    page.appendChild(el('h1', { text: 'Settings', style: 'font-size:22px' }));
    if (!live()) page.appendChild(el('div', { class: 'card', text: S.status === 'online' ? 'Reading the node…' : 'Not connected. Node settings need a connection; settings for this browser are below.' }));
    if (s) {
      var b = S.batt, nc = Object.keys(S.contacts).length, nch = Object.keys(S.channels).length;
      page.appendChild(card('This node', el('dl', { class: 'kv' }, [
        el('dt', { text: 'Name' }), el('dd', { text: s.name }), el('dt', { text: 'Public key' }), el('dd', { class: 'mono', text: s.key }),
        el('dt', { text: 'Firmware' }), el('dd', { text: d ? d.version + ' (' + d.build + ')' : '' }), el('dt', { text: 'Board' }), el('dd', { text: d ? d.maker : '' }),
        el('dt', { text: 'Battery' }), el('dd', { text: b ? (b.mv / 1000).toFixed(2) + ' V' : 'unknown' }),
        el('dt', { text: 'Storage' }), el('dd', { text: b && b.totalKb ? Math.round(b.usedKb) + ' of ' + b.totalKb + ' KB used' : 'unknown' }),
        el('dt', { text: 'Contacts' }), el('dd', { text: nc + ' of ' + (d ? d.maxContacts : '?') }), el('dt', { text: 'Channels' }), el('dd', { text: nch + ' of ' + (d ? d.maxChannels : '?') })])));
      page.appendChild(card('Identity and position', [
        row('Node name', s.name, UI.icon('gear', 18), editName),
        row('Position', s.lat || s.lon ? s.lat.toFixed(5) + ', ' + s.lon.toFixed(5) : 'Not set', UI.icon('gear', 18), editPosition),
        S.vars && S.vars.gps !== undefined ? row('GPS receiver', 'Use the board\'s GPS for the position', toggle(S.vars.gps === '1', function (on) { W.req(MC.enc.setVar('gps', on ? '1' : '0'), ['ok']).then(function () { S.vars.gps = on ? '1' : '0'; }, function (e) { fail(e); render(); }); })) : null
      ]));
      page.appendChild(card('Radio', [
        row('Radio settings', (s.freqMHz).toFixed(3) + ' MHz · ' + s.bwKHz + ' kHz · SF' + s.sf + ' · 4/' + s.cr + ' · ' + s.txPower + ' dBm', UI.icon('antenna', 18), editRadio),
        d ? row('Route detail', 'Bytes of each repeater\'s id kept in a route. More bytes mean fewer mix-ups, shorter maximum routes.', el('select', { class: 'sel', 'aria-label': 'Route detail', onchange: function (e) { setHash(+e.target.value); } },
          [0, 1, 2].map(function (m) { return el('option', { value: m, text: (m + 1) + ' byte' + (m ? 's' : '') + ' per hop', selected: d.pathHashMode === m }); }))) : null
      ]));
      page.appendChild(card('Privacy', [row('Position, telemetry, acknowledgements' + (d && d.pingVisible != null ? ', pings' : ''), 'Position in adverts: ' + (s.advertLoc ? 'shared' : 'private') + ' · extra acks: ' + s.multiAcks + (d && d.pingVisible != null ? ' · pings: ' + (d.pingVisible ? 'answered' : 'ignored') : ''), UI.icon('lock', 18), editPrivacy)]));
      var autoRows = AUTO.map(function (a) { return row(a[1], null, toggle(S.autoAdd && (S.autoAdd.flags & a[0]), function (on) { setAuto(a[0], on); })); });
      page.appendChild(card('Adding contacts automatically', autoRows.concat([row('Distance limit', S.autoAdd && S.autoAdd.maxHops ? 'Up to ' + S.autoAdd.maxHops + ' hops' : 'Any distance', UI.icon('gear', 18), editMaxHops)]), S.autoAdd ? null : 'not available on this firmware'));
      var regs = S.regions.map(function (r) {
        return row('#' + r, S.defaultRegion === r ? 'Default' : null, el('div', { class: 'btnrow' }, [UI.btn(S.defaultRegion === r ? 'Clear default' : 'Make default', { kind: 'small', onclick: function () { setDefaultRegion(S.defaultRegion === r ? '' : r); } }),
          UI.btn('', { icon: 'trash', kind: 'ghost small danger', title: 'Remove', onclick: function () { S.regions = S.regions.filter(function (x) { return x !== r; }); if (S.defaultRegion === r) setDefaultRegion(''); Object.keys(S.chRegion).forEach(function (k) { if (S.chRegion[k] === r) delete S.chRegion[k]; }); W.persist(); render(); } })]));
      });
      page.appendChild(card('Regions', regs.concat([row('Add a region', 'A region limits which repeaters pass on your channel messages.', UI.icon('plus', 18), addRegion)])));
      page.appendChild(card('Actions', [
        row('Set the node clock from this computer', 'Node time: ' + new Date(W.devNow() * 1000).toLocaleString(), UI.icon('clock', 18), syncTime),
        row('Reload contacts', null, UI.icon('refresh', 18), function () { W.loadContacts().then(function () { UI.toast('Contacts reloaded'); }, fail); }),
        row('Forget all routes', null, UI.icon('route', 18), resetPaths),
        row('Export repeaters and rooms (GPX)', null, UI.icon('download', 18), function () { exportGpx('repeaters'); }),
        row('Export people (GPX)', null, UI.icon('download', 18), function () { exportGpx('people'); }),
        row('Restart the node', null, UI.icon('power', 18), reboot)
      ]));
    }
    page.appendChild(card('This browser', [
      row('Theme', null, seg('theme', [['auto', 'Auto'], ['light', 'Light'], ['dark', 'Dark']])),
      row('Message text size', null, seg('textScale', [[0.9, 'Small'], [1, 'Normal'], [1.2, 'Large']])),
      row('Show signal details on messages', 'Signal quality and number of hops', toggle(W.settings.showTrace, function (on) { W.setSetting('showTrace', on); })),
      row('Send tries for a direct message', 'How often an unanswered message is sent again', el('select', { class: 'sel', 'aria-label': 'Tries', onchange: function (e) { W.setSetting('retries', +e.target.value); } },
        [1, 2, 3, 4, 5, 6].map(function (n) { return el('option', { value: n, text: n, selected: W.settings.retries === n }); }))),
      row('Forget the route after the last try fails', null, toggle(W.settings.clearPathOnFail, function (on) { W.setSetting('clearPathOnFail', on); })),
      row('Clear everything kept in this browser', 'Messages, groups, communities and these preferences', UI.icon('trash', 18), function () {
        UI.confirm('Clear browser data', 'Removes messages, groups, communities, regions and preferences stored in this browser. The node keeps its own data.', 'Clear', true).then(function (ok) {
          if (!ok) return; try { Object.keys(localStorage).filter(function (k) { return k.indexOf('mcw2:') === 0; }).forEach(function (k) { localStorage.removeItem(k); }); } catch (e) { } location.reload();
        });
      })
    ]));
    page.appendChild(el('p', { class: 'dim', style: 'text-align:center', text: 'MeshCore node page · served by the node itself' }));
    box.appendChild(page); box.scrollTop = scroll;
  }

  function mount(b) {
    box = b; box.style.overflow = 'auto'; box.style.display = '';
    ['self', 'battery', 'settings-node', 'status', 'contacts', 'channels'].forEach(function (ev) { W.bus.on(ev, function () { if (App.current() && App.current().id === 'settings') render(); }); });
    render();
  }
  App.register({ id: 'settings', title: 'Settings', icon: 'gear', mount: mount, show: function () { render(); if (live()) { W.refreshBattery(); } } });
})(window);
