// Repeater hub: sign in to a repeater (or room server) and read its status, neighbours and sensors, set its features, and
// run commands on it. Commands travel as text messages of a special type; the answer comes back as a message from the repeater.
(function (root) {
  'use strict';
  var el = UI.el, W = root.W, S = W.S;
  var session = {};   // key -> { admin, at }

  function hub(box, c, opts) {
    var tab = 'status', dead = false, offs = [], busy = Promise.resolve(), body = el('div', { class: 'page' }), top = el('div', { class: 'dtop' });
    UI.clear(box); box.appendChild(top); box.appendChild(body);

    function renderTop() {
      UI.clear(top);
      top.appendChild(UI.btn('', { icon: 'back', kind: 'ghost back', title: 'Back', onclick: opts.onBack }));
      var av = UI.avatar(c.name, { icon: c.type === 3 ? 'door' : 'cell' }); av.classList.add('t' + c.type); top.appendChild(av);
      var s = session[c.key];
      top.appendChild(el('div', { class: 't' }, [el('b', { text: c.name }), el('small', { text: (c.type === 3 ? 'Room server' : 'Repeater') + ' · ' + W.pathLabel(S.contacts[c.key] || c) + (s ? ' · signed in' + (s.admin ? ' as admin' : ' as guest') : '') })]));
      if (s) top.appendChild(UI.btn('Sign out', { kind: 'small', onclick: function () { delete session[c.key]; W.req(MC.enc.logout(c.key), ['ok']).catch(function () { }); renderTop(); render(); } }));
      if (opts.menu) { var mb = UI.btn('', { icon: 'more', kind: 'ghost', title: 'More' }); mb.onclick = function () { UI.menu(mb, opts.menu()); }; top.appendChild(mb); }
    }

    // run one command on the repeater and resolve with its answer
    function cli(text) {
      var job = busy.then(function () {
        return new Promise(function (res, rej) {
          var off, t;
          function fin(fn, v) { clearTimeout(t); off(); fn(v); }
          off = W.bus.on('msg', function (e) { if (e.incoming && e.conv === c.key && e.msg.cli) fin(res, e.msg.text); });
          t = setTimeout(function () { fin(rej, new Error('No answer from the repeater. Out of range, or the route is not known yet.')); }, 30000);
          var msg = W.addMsg(c.key, { me: true, cli: true, channel: false, text: text, ts: W.devNow(), status: 'sent' });
          W.bus.emit('msg', { conv: c.key, msg: msg });
          W.req(MC.enc.remoteCli(c.key, text, msg.ts, 0), ['sent']).catch(function (e) { msg.status = 'failed'; fin(rej, e); });
        });
      });
      busy = job.then(function () { }, function () { });
      return job;
    }

    function signInCard() {
      var pw = el('input', { type: 'password', placeholder: 'Password (empty for guest)', maxlength: 15, autocomplete: 'off' }), msg = el('p', { class: 'dim', text: 'Repeaters answer status requests to guests; changing settings needs the admin password.' });
      var go = UI.btn('Sign in', { kind: 'primary', onclick: attempt });
      function attempt() {
        go.disabled = true; msg.textContent = 'Signing in…';
        W.login(c, pw.value).then(function (r) { session[c.key] = { admin: r.admin, at: Date.now() }; renderTop(); render(); }, function (e) { msg.textContent = e.message; go.disabled = false; });
      }
      pw.addEventListener('keydown', function (e) { if (e.key === 'Enter') attempt(); });
      return el('section', { class: 'card form' }, [el('h2', { text: 'Sign in to ' + c.name }), pw, el('div', { class: 'btnrow' }, [go]), msg]);
    }

    // ---- status ----
    var lastStats = null, lastNbrs = null, lastTele = null;
    function statusCard() {
      var out = el('div');
      function paint() {
        UI.clear(out); var r = lastStats; if (!r) { out.appendChild(el('p', { class: 'dim', text: 'Not read yet.' })); return; }
        function tile(v, l) { return el('div', {}, [el('b', { text: v }), el('span', { text: l })]); }
        out.appendChild(el('div', { class: 'stat' }, [tile((r.mv / 1000).toFixed(2) + ' V', 'battery'), tile(UI.dur(r.uptime), 'running for'), tile(String(r.queue), 'waiting to send'), tile(r.noise + ' dBm', 'noise floor'), tile(r.rssi + ' dBm', 'last signal'), tile(r.snr + ' dB', 'last signal to noise'),
          tile(r.recv.toLocaleString(), 'packets heard'), tile(r.sent.toLocaleString(), 'packets sent'), tile(r.recvFlood + ' / ' + r.recvDirect, 'heard flood / direct'), tile(r.sentFlood + ' / ' + r.sentDirect, 'sent flood / direct'),
          tile(r.dupFlood + ' / ' + r.dupDirect, 'repeats seen flood / direct'), tile(UI.dur(r.txAir), 'sending time'), r.rxAir != null ? tile(UI.dur(r.rxAir), 'listening time') : null, r.recvErrors != null ? tile(String(r.recvErrors), 'damaged') : null].filter(Boolean)));
      }
      var go = UI.btn('Read status', { icon: 'refresh', kind: 'primary', onclick: function () {
        go.disabled = true;
        var off = W.bus.on('push', function (m) { if (m.t === 'status' && c.key.indexOf(m.from) === 0) { off(); clearTimeout(t); lastStats = MC.nodeStats(m.data, c.type === 3); go.disabled = false; paint(); } });
        var t = setTimeout(function () { off(); go.disabled = false; UI.toast('The repeater did not answer', 'bad'); }, 30000);
        W.req(MC.enc.statusReq(c.key), ['sent']).catch(function (e) { off(); clearTimeout(t); go.disabled = false; UI.toast(e.message, 'bad'); });
      } });
      paint();
      return el('section', { class: 'card' }, [el('h2', { text: 'Status' }), out, el('div', { class: 'btnrow', style: 'margin-top:10px' }, [go])]);
    }

    // ---- features: the hop retry / fallback / rescue / route cache / ping settings of this firmware ----
    var feat = null;
    function parseFeatures(t) {
      var f = { raw: t };
      var m = /hop-retry:(\d+|off)/.exec(t); f.retries = m ? (m[1] === 'off' ? 0 : +m[1]) : null;
      m = /fallback:(on|off)/.exec(t); f.fallback = m ? m[1] === 'on' : null;
      m = /rescue:(on|off)/.exec(t); f.rescue = m ? m[1] === 'on' : null;
      m = /route-cache:(off|\d+\/\d+)/.exec(t); f.cache = m ? m[1] !== 'off' : null; f.cacheFill = m && m[1] !== 'off' ? m[1] : '';
      m = /ping:(on|off)/.exec(t); f.ping = m ? m[1] === 'on' : null;
      m = /route:(on|off)/.exec(t); f.route = m ? m[1] === 'on' : null;
      return f;
    }
    function featuresCard() {
      var out = el('div'), text = el('pre', { class: 'console', style: 'height:auto;max-height:200px', hidden: true });
      var admin = session[c.key] && session[c.key].admin;
      function setCmd(cmd) { return cli(cmd).then(function (r) { UI.toast(/^OK/i.test(r.trim()) ? 'Saved' : r, /^OK/i.test(r.trim()) ? '' : 'bad'); return load(); }, function (e) { UI.toast(e.message, 'bad'); }); }
      function row(title, sub, ctl) { return el('div', { class: 'setrow' }, [el('div', { class: 't' }, [el('b', { text: title }), el('small', { text: sub })]), ctl]); }
      function sw(on, cmdName) { var cb = el('input', { type: 'checkbox', checked: !!on, disabled: !admin, 'aria-label': cmdName }); cb.addEventListener('change', function () { setCmd('set ' + cmdName + ' ' + (cb.checked ? 'on' : 'off')); }); return el('label', { class: 'switch' }, [cb, el('i')]); }
      function paint() {
        UI.clear(out);
        if (!feat) { out.appendChild(el('p', { class: 'dim', text: 'Not read yet.' })); return; }
        if (feat.retries == null && feat.ping == null) { out.appendChild(el('p', { class: 'tag warn', text: 'This repeater\'s firmware has none of these features.' })); text.hidden = false; text.textContent = feat.raw; return; }
        if (!admin) out.appendChild(el('p', { class: 'tag warn', text: 'Sign in with the admin password to change these.' }));
        out.appendChild(row('Resend to the next hop', 'When the next repeater is not heard passing a packet on, send it again (0 = off, up to 3 times).',
          el('select', { class: 'sel', disabled: !admin, 'aria-label': 'Hop retries', onchange: function (e) { setCmd('set hop.retries ' + e.target.value); } }, [0, 1, 2, 3].map(function (n) { return el('option', { value: n, text: n ? n + ' time' + (n > 1 ? 's' : '') : 'Off', selected: feat.retries === n }); }))));
        if (feat.retries) {
          out.appendChild(row('Flood when it still fails', 'If the next hop never answers, send the packet out by flooding instead.', sw(feat.fallback, 'hop.fallback')));
          out.appendChild(row('Take over a packet nobody forwards', 'If a neighbour was supposed to pass a packet on and did not, this repeater sends it.', sw(feat.rescue, 'hop.rescue')));
        }
        out.appendChild(row('Route cache', 'Remember routes learned from adverts.' + (feat.cacheFill ? ' Holding ' + feat.cacheFill + '.' : ''), sw(feat.cache, 'routecache')));
        out.appendChild(row('Answer pings', 'Show up when someone pings the mesh.', sw(feat.ping, 'ping')));
        if (feat.route != null) out.appendChild(row('Routed forwarding', feat.route ? 'On. Change under route.* settings in the console.' : 'Off', el('span', { class: 'tag ' + (feat.route ? 'ok' : ''), text: feat.route ? 'on' : 'off' })));
        text.hidden = false; text.textContent = feat.raw;
      }
      function load() { return cli('features').then(function (r) { feat = parseFeatures(r); paint(); }, function (e) { UI.toast(e.message, 'bad'); }); }
      var readBtn = UI.btn('Read', { icon: 'refresh', kind: 'primary', onclick: function () { readBtn.disabled = true; load().then(function () { readBtn.disabled = false; }); } });
      var rt = UI.btn('Route table', { onclick: function () { cli('routes').then(function (r) { text.hidden = false; text.textContent = r; }, function (e) { UI.toast(e.message, 'bad'); }); } });
      paint();
      return el('section', { class: 'card' }, [el('h2', { text: 'Routing features' }), out, text, el('div', { class: 'btnrow', style: 'margin-top:10px' }, [readBtn, rt])]);
    }

    // ---- neighbours ----
    function neighboursCard() {
      var out = el('div');
      function paint() {
        UI.clear(out); if (!lastNbrs) { out.appendChild(el('p', { class: 'dim', text: 'Not read yet.' })); return; }
        if (!lastNbrs.list.length) { out.appendChild(el('p', { class: 'dim', text: 'No neighbours heard.' })); return; }
        out.appendChild(el('table', { class: 't' }, [el('tr', {}, ['Node', 'Id', 'Heard', 'Signal to noise'].map(function (h) { return el('th', { text: h }); }))].concat(lastNbrs.list.map(function (n) {
          var k = Object.keys(S.contacts).filter(function (x) { return x.indexOf(n.key) === 0; })[0], ago = n.ago;
          return el('tr', {}, [el('td', { text: k ? S.contacts[k].name : '(not a contact)' }), el('td', { class: 'mono', text: n.key }), el('td', { text: ago < 90 ? ago + ' s ago' : UI.dur(ago) + ' ago' }), el('td', { text: n.snr + ' dB' })]);
        }))));
        out.appendChild(el('p', { class: 'dim', text: lastNbrs.list.length + ' of ' + lastNbrs.total + ' shown.' }));
      }
      var go = UI.btn('Read neighbours', { icon: 'refresh', kind: 'primary', onclick: async function () {
        go.disabled = true; var all = [], total = 0;
        try {
          do {
            var sent = await W.req(MC.enc.neighboursReq(c.key, 15, all.length, 0, 6), ['sent']);
            var r = await new Promise(function (res, rej) {
              var off = W.bus.on('push', function (m) { if (m.t === 'binary' && m.tag === sent.ack) { off(); clearTimeout(t); res(MC.neighbours(m.data, 6)); } });
              var t = setTimeout(function () { off(); rej(new Error('The repeater did not answer')); }, 30000);
            });
            if (!r) break; total = r.total; all = all.concat(r.list); if (!r.list.length) break;
          } while (all.length < total);
          lastNbrs = { list: all, total: total }; paint();
        } catch (e) { UI.toast(e.message, 'bad'); }
        go.disabled = false;
      } });
      paint();
      return el('section', { class: 'card' }, [el('h2', { text: 'Neighbours' }), el('p', { class: 'dim', text: 'Repeaters this one hears directly.' }), out, el('div', { class: 'btnrow', style: 'margin-top:10px' }, [go])]);
    }

    function sensorsCard() {
      var out = el('div'); if (lastTele) out.appendChild(lppTable(lastTele)); else out.appendChild(el('p', { class: 'dim', text: 'Not read yet.' }));
      var go = UI.btn('Read sensors', { icon: 'sensor', kind: 'primary', onclick: function () {
        go.disabled = true;
        var off = W.bus.on('push', function (m) { if (m.t === 'telemetry' && c.key.indexOf(m.from) === 0) { off(); clearTimeout(t); lastTele = W.lpp(m.data); UI.clear(out); out.appendChild(lppTable(lastTele)); go.disabled = false; } });
        var t = setTimeout(function () { off(); go.disabled = false; UI.toast('No answer (the repeater may not allow telemetry)', 'bad'); }, 30000);
        W.req(MC.enc.telemetryReq(c.key), ['sent']).catch(function (e) { off(); clearTimeout(t); go.disabled = false; UI.toast(e.message, 'bad'); });
      } });
      return el('section', { class: 'card' }, [el('h2', { text: 'Sensors' }), out, el('div', { class: 'btnrow', style: 'margin-top:10px' }, [go])]);
    }
    function lppTable(rows) {
      if (!rows.length) return el('p', { class: 'dim', text: 'No readings.' });
      return el('table', { class: 't' }, [el('tr', {}, [el('th', { text: 'Channel' }), el('th', { text: 'Reading' }), el('th', { text: 'Value' })])].concat(rows.map(function (r) { return el('tr', {}, [el('td', { text: r.ch }), el('td', { text: r.name }), el('td', { text: r.value })]); })));
    }

    // ---- console ----
    var QUICK = ['ver', 'clock', 'neighbors', 'features', 'routes', 'get name', 'get radio', 'get role', 'advert'];
    function consoleCard() {
      var log = el('div', { class: 'console', role: 'log' });
      function paint() {
        UI.clear(log); var l = (S.convs[c.key] || []).filter(function (m) { return m.cli; });
        if (!l.length) log.appendChild(el('div', { text: 'Type a command. Try "ver" or "features".' }));
        l.forEach(function (m) { log.appendChild(el('div', { class: m.me ? 'in' : m.status === 'failed' ? 'err' : '', text: (m.me ? '> ' : '') + m.text })); }); log.scrollTop = log.scrollHeight;
      }
      var inp = el('input', { type: 'text', placeholder: 'command', 'aria-label': 'Command', autocomplete: 'off', spellcheck: 'false', style: 'flex:1;padding:9px 11px;border:1px solid var(--line);border-radius:10px;background:var(--panel2)' });
      var form = el('form', { class: 'btnrow', style: 'margin-top:8px;flex-wrap:nowrap', onsubmit: function (e) { e.preventDefault(); var t = inp.value.trim(); if (!t) return; inp.value = ''; cli(t).catch(function (er) { UI.toast(er.message, 'bad'); }); } }, [inp, UI.btn('Run', { kind: 'primary', type: 'submit' })]);
      var quick = el('div', { class: 'btnrow', style: 'margin-bottom:8px' }, QUICK.map(function (q) { return UI.btn(q, { kind: 'small', onclick: function () { cli(q).catch(function (er) { UI.toast(er.message, 'bad'); }); } }); }));
      offs.push(W.bus.on('msg', function (e) { if (e.conv === c.key && tab === 'console') paint(); }));
      paint();
      return el('section', { class: 'card' }, [el('h2', { text: 'Console' }), quick, log, form]);
    }

    var TABS = [['status', 'Status', statusCard], ['features', 'Features', featuresCard], ['neighbours', 'Neighbours', neighboursCard], ['sensors', 'Sensors', sensorsCard], ['console', 'Console', consoleCard]];
    function render() {
      UI.clear(body);
      if (!session[c.key]) { body.appendChild(signInCard()); return; }
      body.appendChild(el('div', { class: 'seg', role: 'tablist', style: 'flex-wrap:wrap' }, TABS.map(function (t) { return el('button', { type: 'button', role: 'tab', class: tab === t[0] ? 'sel' : '', text: t[1], onclick: function () { tab = t[0]; render(); } }); })));
      body.appendChild((TABS.filter(function (t) { return t[0] === tab; })[0] || TABS[0])[2]());
    }
    renderTop(); render();
    return { destroy: function () { dead = true; offs.forEach(function (f) { f(); }); } };
  }
  W.repeaterHub = hub;
})(window);
