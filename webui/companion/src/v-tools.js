// Tools: ping (who is in radio range), discovery, radio statistics, the node console, and this node's sensors.
(function (root) {
  'use strict';
  var el = UI.el, W = root.W, S = W.S, box, page, tab = W.store.get('mcw2:toolstab', 'ping'), statTimer = 0;
  var TYPE = { 1: 'Companion', 2: 'Repeater', 3: 'Room', 4: 'Sensor' };

  // ---- Cayenne LPP: the sensor format used for telemetry ----
  var LPP = { 0: ['Digital in', 1], 1: ['Digital out', 1], 2: ['Analog in', 2, 100, 1], 3: ['Analog out', 2, 100, 1], 101: ['Light', 2, 1, 0, 'lx'], 102: ['Presence', 1],
    103: ['Temperature', 2, 10, 1, '°C'], 104: ['Humidity', 1, 2, 0, '%'], 115: ['Pressure', 2, 10, 0, 'hPa'], 116: ['Voltage', 2, 100, 0, 'V'], 117: ['Current', 2, 1000, 1, 'A'],
    120: ['Percentage', 1, 1, 0, '%'], 121: ['Altitude', 2, 1, 1, 'm'], 125: ['Concentration', 2, 1, 0, 'ppm'], 128: ['Power', 2, 1, 0, 'W'], 130: ['Distance', 4, 1000, 0, 'm'],
    132: ['Direction', 2, 1, 0, '°'], 136: ['Position', 9], 142: ['Switch', 1] };
  function lpp(d) {
    var out = [], i = 0;
    while (i + 2 <= d.length) {
      var ch = d[i], ty = d[i + 1], def = LPP[ty]; i += 2;
      if (!def) break; var n = def[1]; if (i + n > d.length) break;
      var val;
      if (ty === 136) { var la = (d[i] << 16 | d[i + 1] << 8 | d[i + 2]) << 8 >> 8, lo = (d[i + 3] << 16 | d[i + 4] << 8 | d[i + 5]) << 8 >> 8; val = (la / 1e4).toFixed(4) + ', ' + (lo / 1e4).toFixed(4); }
      else {
        var v = 0; for (var k = 0; k < n; k++) v = v * 256 + d[i + k];
        if (def[3] && n === 2 && v > 32767) v -= 65536;
        var dec = def[2] === 2 ? 1 : Math.round(Math.log(def[2]) / Math.LN10);
        val = (v / def[2]).toFixed(dec) + (def[4] ? ' ' + def[4] : '');
      }
      out.push({ ch: ch, name: def[0], value: val }); i += n;
    }
    return out;
  }
  W.lpp = lpp;
  function lppTable(rows) {
    if (!rows.length) return el('p', { class: 'dim', text: 'No readings.' });
    return el('table', { class: 't' }, [el('tr', {}, [el('th', { text: 'Channel' }), el('th', { text: 'Reading' }), el('th', { text: 'Value' })])].concat(rows.map(function (r) { return el('tr', {}, [el('td', { text: r.ch }), el('td', { text: r.name }), el('td', { text: r.value })]); })));
  }

  // ---- ping ----
  var pingRes = [], pinging = false;
  function pingCard() {
    var supported = S.dev && S.dev.pingVisible != null;
    var types = [[1, 'People'], [2, 'Repeaters'], [3, 'Rooms'], [4, 'Sensors']], checks = {};
    var typeRow = el('div', { class: 'btnrow' }, types.map(function (t) {
      var cb = el('input', { type: 'checkbox', checked: true }); checks[t[0]] = cb; return el('label', { class: 'tag' }, [cb, ' ' + t[1]]);
    }));
    var win = el('select', { class: 'sel', 'aria-label': 'Reply window' }, [1, 3, 5, 10, 20, 60].map(function (n) { return el('option', { value: n, text: n + ' s', selected: n === 3 }); }));
    var prob = el('select', { class: 'sel', 'aria-label': 'Share of nodes that answer' }, [[255, 'Every node'], [128, 'About half'], [64, 'About a quarter']].map(function (o) { return el('option', { value: o[0], text: o[1] }); }));
    var go = UI.btn('Ping', { icon: 'signal', kind: 'primary', disabled: !supported || S.status !== 'online', onclick: run });
    var out = el('div');
    function mask() { var m = 0; Object.keys(checks).forEach(function (k) { if (checks[k].checked) m |= 1 << +k; }); return m || 0xFF; }
    function paint() {
      UI.clear(out);
      if (!pingRes.length) { out.appendChild(el('p', { class: 'dim', text: pinging ? 'Listening for answers…' : 'No answers yet.' })); return; }
      var rows = pingRes.slice().sort(function (a, b) { return b.ourSnr - a.ourSnr; });
      out.appendChild(el('table', { class: 't' }, [el('tr', {}, ['Name', 'Kind', 'Id', 'They hear me', 'I hear them', 'Strength'].map(function (h) { return el('th', { text: h }); }))].concat(rows.map(function (r) {
        var known = Object.keys(S.contacts).filter(function (k) { return k.indexOf(r.key8) === 0; })[0];
        return el('tr', {}, [el('td', { text: r.name || (known ? S.contacts[known].name : '(hidden)') }), el('td', { text: TYPE[r.nodeType] || '?' }), el('td', { class: 'mono', text: r.key8.slice(0, 8) }),
          el('td', { text: r.theirSnr + ' dB' }), el('td', { text: r.ourSnr + ' dB' }), el('td', { text: r.rssi + ' dBm' })]);
      }))));
      out.appendChild(el('p', { class: 'dim', text: pingRes.length + (pingRes.length === 1 ? ' node answered.' : ' nodes answered.') }));
    }
    function run() {
      if (pinging) return;
      var tag = (Math.random() * 0xffffffff) >>> 0, secs = +win.value; pinging = true; pingRes = []; go.disabled = true; paint();
      var off = W.bus.on('push', function (m) { if (m.t === 'pingReply' && m.tag === tag && !pingRes.some(function (r) { return r.key8 === m.key8; })) { pingRes.push({ key8: m.key8, name: m.name, nodeType: m.nodeType, theirSnr: m.theirSnr, ourSnr: m.snr, rssi: m.rssi, fw: m.fwVer }); paint(); } });
      W.req(MC.enc.ping(tag, mask(), +prob.value, secs), ['ok']).then(function () {
        setTimeout(function () { off(); pinging = false; go.disabled = false; paint(); }, secs * 1000 + 2500);
      }, function (e) { off(); pinging = false; go.disabled = false; UI.toast(e.message, 'bad'); paint(); });
    }
    paint();
    return el('section', { class: 'card' }, [el('h2', {}, ['Ping', el('small', { text: 'who is in radio range?' })]),
      el('p', { class: 'dim', text: 'Sends one short message that only nodes able to hear this radio directly will answer, and only if their owners allow it. Nothing is passed on by repeaters.' }),
      supported ? null : el('p', { class: 'tag warn', text: 'This node\'s firmware has no ping support.' }),
      typeRow, el('div', { class: 'btnrow', style: 'margin:10px 0' }, [el('label', { class: 'dim', text: 'Answers spread over ' }), win, prob, go]), out]);
  }

  // ---- discovery ----
  var discRes = [];
  function discoverCard() {
    var kinds = el('select', { class: 'sel', 'aria-label': 'Which nodes' }, [[(1 << 2), 'Repeaters'], [(1 << 1) | (1 << 3) | (1 << 4), 'Everything but repeaters'], [0x1e, 'Every kind']].map(function (o) { return el('option', { value: o[0], text: o[1] }); }));
    var out = el('div'), go = UI.btn('Look around', { icon: 'search', kind: 'primary', disabled: S.status !== 'online', onclick: run });
    function paint() {
      UI.clear(out);
      if (!discRes.length) { out.appendChild(el('p', { class: 'dim', text: 'Nothing found yet.' })); return; }
      out.appendChild(el('table', { class: 't' }, [el('tr', {}, ['Kind', 'Id', 'They hear me', 'I hear them'].map(function (h) { return el('th', { text: h }); }))].concat(discRes.map(function (r) {
        var known = Object.keys(S.contacts).filter(function (k) { return k.indexOf(r.key) === 0; })[0];
        return el('tr', {}, [el('td', { text: (known ? S.contacts[known].name + ' · ' : '') + (TYPE[r.nodeType] || '?') }), el('td', { class: 'mono', text: r.key.slice(0, 12) }), el('td', { text: r.theirSnr + ' dB' }), el('td', { text: r.snr + ' dB' })]);
      }))));
    }
    function run() {
      var tag = (Math.random() * 0xffffffff) >>> 0; discRes = []; go.disabled = true; paint();
      var off = W.bus.on('push', function (m) { if (m.t === 'discoverReply' && m.tag === tag && !discRes.some(function (r) { return r.key === m.key; })) { discRes.push(m); paint(); } });
      W.req(MC.enc.discover(tag, +kinds.value, true), ['ok']).then(function () { setTimeout(function () { off(); go.disabled = false; }, 8000); }, function (e) { off(); go.disabled = false; UI.toast(e.message, 'bad'); });
    }
    paint();
    return el('section', { class: 'card' }, [el('h2', {}, ['Discover', el('small', { text: 'nodes near this radio' })]),
      el('p', { class: 'dim', text: 'Asks nearby nodes to introduce themselves. Nodes found here that you have not added show up under Contacts → Discovered.' }),
      el('div', { class: 'btnrow', style: 'margin-bottom:10px' }, [kinds, go]), out]);
  }

  // ---- statistics ----
  var stats = {};
  function statsCard() {
    var out = el('div'), auto = true;
    function fmt(n) { return n.toLocaleString(); }
    function paint() {
      UI.clear(out);
      var c = stats.core, r = stats.radio, p = stats.packets;
      if (!c && !r && !p) { out.appendChild(el('p', { class: 'dim', text: S.status === 'online' ? 'Reading…' : 'Not connected.' })); return; }
      function tile(v, l) { return el('div', {}, [el('b', { text: v }), el('span', { text: l })]); }
      if (c) out.appendChild(el('div', { class: 'stat' }, [tile((c.mv / 1000).toFixed(2) + ' V', 'battery'), tile(UI.dur(c.uptime), 'running for'), tile(String(c.queue), 'waiting to send'), tile(c.errFlags ? '0x' + c.errFlags.toString(16) : 'none', 'error flags')]));
      if (r) out.appendChild(el('div', { class: 'stat', style: 'margin-top:10px' }, [tile(r.noise + ' dBm', 'noise floor'), tile(r.rssi + ' dBm', 'last signal'), tile(r.snr + ' dB', 'last signal to noise'), tile(UI.dur(r.txAir), 'sending time'), tile(UI.dur(r.rxAir), 'listening time')]));
      if (p) out.appendChild(el('div', { class: 'stat', style: 'margin-top:10px' }, [tile(fmt(p.recv), 'packets heard'), tile(fmt(p.sent), 'packets sent'), tile(fmt(p.recvFlood) + ' / ' + fmt(p.recvDirect), 'heard flood / direct'), tile(fmt(p.sentFlood) + ' / ' + fmt(p.sentDirect), 'sent flood / direct'), tile(fmt(p.recvErrors), 'damaged')]));
    }
    async function poll() {
      if (S.status !== 'online') return;
      try { for (var k = 0; k < 3; k++) { var r = await W.req(MC.enc.getStats(k), ['stats']); stats[r.kind] = r; paint(); } } catch (e) { /* firmware without statistics */ if (!stats.core) { UI.clear(out); out.appendChild(el('p', { class: 'dim', text: 'This firmware does not report statistics.' })); } }
    }
    clearInterval(statTimer); statTimer = setInterval(function () { if (auto && tab === 'stats' && App.current() && App.current().id === 'tools' && !document.hidden) poll(); }, 5000);
    paint(); poll();
    return el('section', { class: 'card' }, [el('h2', {}, ['Radio statistics', el('small', { text: 'updates every 5 s' })]), out]);
  }

  // ---- console ----
  var conLog = [], hist = [], hpos = 0;
  function consoleCard() {
    var log = el('div', { class: 'console', role: 'log' }), inp = el('input', { type: 'text', placeholder: 'get name · set name <text> · ver · board · get wifi.status · reboot', 'aria-label': 'Command', autocomplete: 'off', spellcheck: 'false', style: 'flex:1;padding:9px 11px;border:1px solid var(--line);border-radius:10px;background:var(--panel2)' });
    function paint() { UI.clear(log); conLog.forEach(function (l) { log.appendChild(el('div', { class: l[0], text: l[1] })); }); log.scrollTop = log.scrollHeight; }
    function add(k, t) { conLog.push([k, t]); if (conLog.length > 300) conLog.shift(); paint(); }
    var form = el('form', { class: 'btnrow', style: 'margin-top:8px;flex-wrap:nowrap', onsubmit: function (e) {
      e.preventDefault(); var c = inp.value.trim(); if (!c) return; inp.value = ''; hist.push(c); hpos = hist.length; add('in', '> ' + c);
      W.req(MC.enc.cli(c), ['cli']).then(function (r) { add('', r.text.replace(/^\s*>?\s*/, '') || '(no output)'); }, function (er) { add('err', er.message === 'not supported by this firmware' ? 'This firmware has no console.' : er.message); });
    } }, [inp, UI.btn('Run', { kind: 'primary', type: 'submit' })]);
    inp.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowUp' && hist.length) { hpos = Math.max(0, hpos - 1); inp.value = hist[hpos]; e.preventDefault(); }
      if (e.key === 'ArrowDown' && hist.length) { hpos = Math.min(hist.length, hpos + 1); inp.value = hist[hpos] || ''; e.preventDefault(); }
    });
    if (!conLog.length) conLog.push(['', 'Commands run on this node. For a repeater, open it under Contacts.']);
    paint();
    return el('section', { class: 'card' }, [el('h2', { text: 'Console' }), log, form]);
  }

  // ---- this node's sensors ----
  function sensorsCard() {
    var out = el('div', {}, [el('p', { class: 'dim', text: 'Reads the battery and any sensors connected to this board.' })]);
    var go = UI.btn('Read sensors', { icon: 'sensor', kind: 'primary', disabled: S.status !== 'online', onclick: function () {
      go.disabled = true;
      var off = W.bus.on('push', function (m) { if (m.t === 'telemetry') { off(); clearTimeout(t); UI.clear(out); out.appendChild(lppTable(lpp(m.data))); go.disabled = false; } });
      var t = setTimeout(function () { off(); go.disabled = false; UI.toast('No answer', 'bad'); }, 8000);
      W.send(MC.enc.selfTelemetry());
    } });
    return el('section', { class: 'card' }, [el('h2', { text: 'This node\'s sensors' }), out, el('div', { class: 'btnrow', style: 'margin-top:8px' }, [go])]);
  }

  var TABS = [['ping', 'Ping', pingCard], ['discover', 'Discover', discoverCard], ['stats', 'Statistics', statsCard], ['console', 'Console', consoleCard], ['sensors', 'Sensors', sensorsCard]];
  function render() {
    if (!box) return;
    UI.clear(box); page = el('div', { class: 'page' });
    page.appendChild(el('h1', { text: 'Tools', style: 'font-size:22px' }));
    var seg = el('div', { class: 'seg', role: 'tablist', style: 'flex-wrap:wrap' }, TABS.map(function (t) {
      return el('button', { type: 'button', role: 'tab', class: tab === t[0] ? 'sel' : '', text: t[1], onclick: function () { tab = t[0]; W.store.set('mcw2:toolstab', tab); render(); } });
    }));
    page.appendChild(seg);
    var def = TABS.filter(function (t) { return t[0] === tab; })[0] || TABS[0]; page.appendChild(def[2]());
    box.appendChild(page);
  }
  App.register({ id: 'tools', title: 'Tools', icon: 'tools', mount: function (b) { box = b; W.bus.on('self', function () { if (App.current() && App.current().id === 'tools') render(); }); W.bus.on('status', function () { if (App.current() && App.current().id === 'tools') render(); }); render(); }, show: render });
})(window);
