// A conversation pane: top bar, message thread, composer. Used for contacts (direct messages), rooms and channels.
(function (root) {
  'use strict';
  var el = UI.el, W = root.W, S = W.S;

  var STATUS = {
    sending: ['clock', 'sending'], sent: ['check', 'sent'], retrying: ['refresh', 'retrying'], delivered: ['checks', 'delivered'],
    failed: ['x', 'failed'], unconfirmed: ['check', 'sent, not confirmed']
  };
  var coarse = window.matchMedia && matchMedia('(pointer:coarse)').matches;

  // messages the apps give a special look: a shared place "m:lat,lon|label|flags" and a GIF "g:<giphy id>"
  function parseSpecial(text) {
    var t = text.trim(), m = /^m:(-?[0-9.]+),(-?[0-9.]+)\|([^|]*)\|(.*)$/.exec(t);
    if (m) { var lat = parseFloat(m[1]), lon = parseFloat(m[2]); if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) return { kind: 'pin', lat: lat, lon: lon, label: m[3].trim() }; }
    m = /^g:([A-Za-z0-9_-]+)$/.exec(t) || /^(?:https?:\/\/)?media\.giphy\.com\/media\/([A-Za-z0-9_-]+)\/giphy\.gif$/.exec(t);
    return m ? { kind: 'gif', id: m[1] } : null;
  }

  var MAX_PARTS = 8;   // a long message is sent as several; this keeps one paste from flooding the mesh

  // Cuts text into pieces of at most `limit` bytes (the first `reserve` bytes shorter), at a line break or space when there is one nearby
  // and never inside an @[Name] tag or a character.
  function splitText(text, limit, reserve) {
    var out = [], rest = String(text).trim(), lim = limit - (reserve || 0);
    while (rest) {
      if (MC.byteLen(rest) <= lim) { out.push(rest); break; }
      var i = 0, bytes = 0;
      while (i < rest.length) {
        var w = rest.codePointAt(i) > 0xffff ? 2 : 1, b = MC.byteLen(rest.slice(i, i + w));
        if (bytes + b > lim) break; bytes += b; i += w;
      }
      if (i === 0) i = 1;
      var head = rest.slice(0, i), nl = head.lastIndexOf('\n'), sp = head.lastIndexOf(' ');
      var at = nl > i * 0.3 ? nl : sp > i * 0.3 ? sp : i;
      var tag = rest.lastIndexOf('@[', at - 1);
      if (tag > 0 && rest.indexOf(']', tag) >= at) at = tag;
      out.push(rest.slice(0, at).trim()); rest = rest.slice(at).trim(); lim = limit;
    }
    return out;
  }

  // opts: conv, kind ('dm'|'channel'), title(), subtitle(), avatar(), canSend, channelIdx, menu() -> items, onBack
  function open(box, opts) {
    UI.clear(box);
    var conv = opts.conv, replyTo = null, stick = true, offs = [];
    var thread = el('div', { class: 'thread', role: 'log', 'aria-live': 'polite', 'aria-label': 'Messages' });
    var top = el('div', { class: 'dtop' });
    var input = el('textarea', { rows: 1, placeholder: opts.canSend === false ? 'You cannot send here' : 'Message', 'aria-label': 'Message', disabled: opts.canSend === false, maxlength: MAX_PARTS * 200 });
    var picker = el('div', { class: 'mentions', role: 'listbox', 'aria-label': 'People to mention', hidden: true });
    var count = el('div', { class: 'count' });
    var replybar = el('div', { class: 'replybar', hidden: true });
    var sendBtn = UI.btn('', { icon: 'send', kind: 'primary', title: 'Send', onclick: submit, disabled: opts.canSend === false });
    var jump = UI.btn('', { icon: 'back', kind: '', title: 'Jump to the newest message', onclick: function () { thread.scrollTop = thread.scrollHeight; } });
    jump.classList.add('jump'); jump.hidden = true; jump.firstChild.style.transform = 'rotate(-90deg)';
    var placeBtn = UI.btn('', { icon: 'pin', kind: 'ghost', title: 'Share a place', onclick: function () { sharePlace(); }, disabled: opts.canSend === false });
    var comp = el('form', { class: 'compose', onsubmit: function (e) { e.preventDefault(); submit(); } }, [picker, replybar, el('div', { class: 'line' }, [placeBtn, input, sendBtn]), count]);
    box.appendChild(top); box.appendChild(thread); box.appendChild(comp); box.appendChild(jump);
    box.style.position = 'relative';

    function limit() { return opts.kind === 'channel' ? W.maxChannelBytes() : W.maxDmBytes(); }
    function used() { return MC.byteLen(input.value) + (replyTo ? MC.byteLen('@[' + replyTo.who + '] ') : 0); }
    function parts() { return splitText(input.value, limit(), replyTo ? MC.byteLen('@[' + replyTo.who + '] ') : 0); }
    function updateCount() {
      var n = used(), lim = limit(), k = n > lim ? parts().length : 1;
      count.textContent = k > 1 ? n + ' bytes: sends as ' + k + ' messages' + (k > MAX_PARTS ? ' (the most is ' + MAX_PARTS + ')' : '') : n > lim * 0.6 ? n + ' / ' + lim + ' bytes' : '';
      count.className = 'count' + (k > MAX_PARTS ? ' over' : '');
      input.style.height = 'auto'; input.style.height = Math.min(120, input.scrollHeight) + 'px';
    }
    input.addEventListener('input', function () { updateCount(); showMentions(); });
    input.addEventListener('click', showMentions);
    input.addEventListener('blur', function () { setTimeout(hideMentions, 120); });
    input.addEventListener('keydown', function (e) {
      if (!picker.hidden) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); pickAt = (pickAt + (e.key === 'ArrowDown' ? 1 : -1) + pickList.length) % pickList.length; paintMentions(); return; }
        if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); chooseMention(pickList[pickAt]); return; }
        if (e.key === 'Escape') { e.preventDefault(); hideMentions(); return; }
      }
      if (e.key === 'Enter' && !e.shiftKey && !coarse) { e.preventDefault(); submit(); } });
    thread.addEventListener('scroll', function () { stick = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 80; jump.hidden = stick; });
    thread.style.setProperty('--ts', W.settings.textScale);

    // typing @ after a space (or at the start) lists the people you can tag; the pick is written as @[Name], the form MeshCore apps use
    var pickList = [], pickAt = 0, pickFrom = 0;
    function mentionNames() {
      var seen = {}, out = [];
      function add(n) { if (n && !seen[n.toLowerCase()] && !(S.self && n === S.self.name)) { seen[n.toLowerCase()] = 1; out.push(n); } }
      (S.convs[conv] || []).slice(-200).forEach(function (m) { if (!m.me && m.who) add(m.who); });
      Object.keys(S.contacts).map(function (k) { return S.contacts[k]; }).filter(function (c) { return c.type !== 2 && c.type !== 4; })
        .sort(function (a, b) { return (b.lastAdvert || 0) - (a.lastAdvert || 0); }).forEach(function (c) { add(c.name); });
      return out;
    }
    function mentionQuery() {
      var pos = input.selectionStart, m = /(^|\s)@([^@\[\]\n]{0,31})$/.exec(input.value.slice(0, pos));
      return m && m[2].charAt(0) !== ' ' ? { from: pos - m[2].length - 1, q: m[2].toLowerCase() } : null;
    }
    function showMentions() {
      var mq = opts.canSend === false ? null : mentionQuery(); if (!mq) { hideMentions(); return; }
      var all = mentionNames(), starts = all.filter(function (n) { return n.toLowerCase().indexOf(mq.q) === 0; });
      pickList = starts.concat(all.filter(function (n) { return starts.indexOf(n) < 0 && n.toLowerCase().indexOf(mq.q) > 0; })).slice(0, 8);
      if (!pickList.length) { hideMentions(); return; }
      pickFrom = mq.from; pickAt = 0; paintMentions(); picker.hidden = false;
    }
    function paintMentions() {
      UI.clear(picker);
      pickList.forEach(function (n, i) {
        var b = el('button', { type: 'button', class: 'mi' + (i === pickAt ? ' on' : ''), role: 'option', 'aria-selected': i === pickAt ? 'true' : 'false' }, [UI.avatar(n, { cls: 'sm' }), el('span', { text: n })]);
        b.addEventListener('mousedown', function (e) { e.preventDefault(); chooseMention(n); });
        picker.appendChild(b);
      });
    }
    function hideMentions() { picker.hidden = true; pickList = []; }
    function chooseMention(name) {
      var pos = input.selectionStart, ins = '@[' + name + '] ';
      input.value = input.value.slice(0, pickFrom) + ins + input.value.slice(pos);
      input.selectionStart = input.selectionEnd = pickFrom + ins.length;
      hideMentions(); updateCount(); input.focus();
    }

    function renderTop() {
      UI.clear(top);
      if (opts.onBack) top.appendChild(UI.btn('', { icon: 'back', kind: 'ghost back', title: 'Back', onclick: opts.onBack }));
      top.appendChild(opts.avatar());
      top.appendChild(el('div', { class: 't' }, [el('b', { text: opts.title() }), el('small', { text: opts.subtitle() })]));
      if (opts.menu) { var mb = UI.btn('', { icon: 'more', kind: 'ghost', title: 'More' }); mb.onclick = function () { UI.menu(mb, opts.menu()); }; top.appendChild(mb); }
    }

    function statusIcon(m) {
      var s = STATUS[m.status]; if (!s) return null;
      var i = UI.icon(s[0], 14); i.setAttribute('aria-label', s[1]); i.setAttribute('role', 'img');
      if (m.status === 'delivered') i.style.color = '#7ee2a0'; return i;
    }
    function metaFor(m) {
      var parts = [el('span', { text: UI.clock(m.ts) })];
      if (!m.me && W.settings.showTrace) {
        if (m.snr != null) parts.push(el('span', { text: 'SNR ' + m.snr }));
        if (m.hops != null) parts.push(el('span', { text: m.hops < 0 ? 'flood' : m.hops === 0 ? 'direct' : m.hops + (m.hops === 1 ? ' hop' : ' hops') }));
      }
      if (m.me && m.channel && m.region) parts.push(el('span', { text: '#' + m.region }));
      if (m.me && !m.channel) {
        if (m.flood != null && m.status !== 'sending' && W.settings.showTrace) parts.push(el('span', { text: m.flood ? 'flood' : 'direct' }));
        if (m.tries > 1) parts.push(el('span', { text: 'try ' + m.tries }));
        if (m.status === 'delivered' && m.ms) parts.push(el('span', { text: (m.ms / 1000).toFixed(1) + ' s' }));
      }
      if (m.me) { var si = statusIcon(m); if (si) parts.push(si); if (m.status === 'failed') parts.push(el('span', { text: m.error || 'failed' })); }
      return el('div', { class: 'meta' }, parts);
    }
    function bubbleMenu(m, anchor) {
      var items = [];
      if (opts.kind === 'channel' && !m.me) items.push({ label: 'Reply', icon: 'reply', run: function () { setReply(m); } });
      if (!m.me && opts.canSend !== false) items.push({ label: 'React', icon: 'star', run: function () { react(m); } });
      items.push({ label: 'Copy text', icon: 'copy', run: function () { UI.copy(m.text); } });
      items.push({ label: 'Details', icon: 'info', run: function () { details(m); } });
      if (m.me && (m.status === 'failed' || m.status === 'unconfirmed')) items.push({ label: 'Send again', icon: 'refresh', run: function () { resend(m); } });
      items.push({ sep: true });
      items.push({ label: 'Delete from this browser', icon: 'trash', danger: true, run: function () {
        S.convs[conv] = (S.convs[conv] || []).filter(function (x) { return x !== m; }); W.persist(); render();
      } });
      UI.menu(anchor, items);
    }
    function details(m) {
      var rows = [['Sent', new Date(m.ts * 1000).toLocaleString()], ['Direction', m.me ? 'outgoing' : 'incoming'], ['Status', m.status || 'received']];
      if (m.who) rows.push(['From', m.who]);
      if (m.snr != null) rows.push(['Signal to noise', m.snr + ' dB']);
      if (m.hops != null) rows.push(['Route', m.hops < 0 ? 'flood (no direct path)' : m.hops === 0 ? 'direct' : m.hops + ' hops']);
      if (m.tries) rows.push(['Attempts', String(m.tries)]);
      if (m.ms) rows.push(['Round trip', (m.ms / 1000).toFixed(2) + ' s']);
      if (m.region) rows.push(['Region', '#' + m.region]);
      if (m.error) rows.push(['Problem', m.error]);
      rows.push(['Length', MC.byteLen(m.text) + ' bytes']);
      var dl = el('dl', { class: 'kv' }); rows.forEach(function (r) { dl.appendChild(el('dt', { text: r[0] })); dl.appendChild(el('dd', { text: r[1] })); });
      UI.alert('Message details', dl);
    }
    function react(m) {
      var grid = el('div', { class: 'btnrow' }), dlg;
      W.EMOJI.forEach(function (e, i) {
        grid.appendChild(UI.btn(e, { onclick: function () { dlg._finish(); W.sendReaction(conv, m, i).catch(function (er) { UI.toast('Reaction not sent: ' + er.message, 'bad'); }); } }));
      });
      UI.dialog('React', grid, []); dlg = document.querySelector('.layer:last-child .dialog');
    }
    function setReply(m) {
      replyTo = m ? { who: m.who || 'them', text: m.text } : null;
      replybar.hidden = !replyTo; UI.clear(replybar);
      if (replyTo) { replybar.appendChild(UI.icon('reply', 16)); replybar.appendChild(el('span', { text: replyTo.who + ': ' + replyTo.text })); replybar.appendChild(UI.btn('', { icon: 'x', kind: 'ghost small', title: 'Cancel reply', onclick: function () { setReply(null); } })); input.focus(); }
      updateCount();
    }

    // text with web links made clickable and any written coordinates turned into a button that opens them on the map
    function withPlaces(m) {
      var found = W.settings.coords === false ? [] : UI.findCoords(m.text);
      if (!found.length) return UI.linkify(m.text);
      var frag = document.createDocumentFragment(), at = 0;
      found.forEach(function (c) {
        var label = c.lat.toFixed(5) + ', ' + c.lon.toFixed(5), who = m.me ? 'You' : (m.who || 'Message');
        var chip = UI.btn(label, { icon: 'pin', kind: 'small coord', title: 'Show on the map', onclick: function (e) { e.stopPropagation(); W.mapFocus(c.lat, c.lon, who + ': ' + label); } });
        if (c.link) { frag.appendChild(UI.linkify(m.text.slice(at, c.end))); frag.appendChild(document.createTextNode(' ')); }
        else { frag.appendChild(UI.linkify(m.text.slice(at, c.start))); }
        frag.appendChild(chip); at = c.end;
      });
      frag.appendChild(UI.linkify(m.text.slice(at)));
      return frag;
    }

    function render() {
      var wasStuck = stick; UI.clear(thread);
      var list = S.convs[conv] || [], lastDay = '';
      if (!list.length) thread.appendChild(el('div', { class: 'empty' }, [el('h3', { text: 'No messages yet' }), el('p', { text: opts.emptyHint || 'Say hello.' })]));
      list.forEach(function (m) {
        var d = UI.dayLabel(m.ts); if (d !== lastDay) { thread.appendChild(el('div', { class: 'day', text: d })); lastDay = d; }
        var b = el('div', { class: 'bubble' + (m.status === 'failed' ? ' failed' : ''), tabindex: 0, role: 'button', 'aria-label': 'Message options' });
        if (!m.me && opts.kind === 'channel' && m.who) { var w = el('span', { class: 'who', text: m.who }); w.style.color = 'hsl(' + UI.hueOf(m.who) + ' 55% 40%)'; if (document.documentElement.dataset.theme === 'dark') w.style.color = 'hsl(' + UI.hueOf(m.who) + ' 70% 70%)'; b.appendChild(w); }
        if (m.replyTo) b.appendChild(el('div', { class: 'quote', text: 'Reply to ' + m.replyTo }));
        var special = parseSpecial(m.text), body = el('span');
        if (special && special.kind === 'pin') {
          body.appendChild(el('div', { class: 'pincard' }, [UI.icon('pin', 18), el('div', {}, [el('b', { text: special.label || 'Shared place' }), el('small', { class: 'mono', text: special.lat.toFixed(5) + ', ' + special.lon.toFixed(5) })]),
            UI.btn('Map', { kind: 'small', onclick: function (e) { e.stopPropagation(); W.mapFocus(special.lat, special.lon, special.label || 'Shared place'); } })]));
        } else if (special && special.kind === 'gif') {
          var img = el('img', { class: 'gif', alt: 'GIF', loading: 'lazy', referrerpolicy: 'no-referrer', src: 'https://media.giphy.com/media/' + special.id + '/giphy.gif' });
          img.onerror = function () { img.replaceWith(el('span', { class: 'dim', text: 'GIF (needs internet): ' + special.id })); };
          body.appendChild(img);
        } else body.appendChild(withPlaces(m));
        b.appendChild(body);
        if (m.reactions && m.reactions.length) {
          var counts = {}; m.reactions.forEach(function (r) { counts[r.e] = (counts[r.e] || 0) + 1; });
          b.appendChild(el('div', { class: 'reacts' }, Object.keys(counts).map(function (e) { return el('span', { text: e + (counts[e] > 1 ? ' ' + counts[e] : '') }); })));
        }
        b.appendChild(metaFor(m));
        b.addEventListener('click', function (e) { if (e.target.tagName === 'A') return; bubbleMenu(m, b); });
        b.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); bubbleMenu(m, b); } });
        var row = el('div', { class: 'mrow' + (m.me ? ' me' : '') });
        if (!m.me && opts.kind === 'channel') row.appendChild(UI.avatar(m.who || '?', { cls: 'sm' }));
        row.appendChild(b); thread.appendChild(row);
      });
      if (wasStuck) thread.scrollTop = thread.scrollHeight;
    }

    function sharePlace() {
      var s = S.self || {};
      UI.form('Share a place', [
        { name: 'label', label: 'Name', value: 'My position', maxlength: 30, required: true },
        { name: 'lat', label: 'Latitude', value: s.lat ? s.lat.toFixed(6) : '', validate: function (v) { return v !== '' && Math.abs(+v) <= 90 ? '' : 'Latitude is between -90 and 90'; } },
        { name: 'lon', label: 'Longitude', value: s.lon ? s.lon.toFixed(6) : '', validate: function (v) { return v !== '' && Math.abs(+v) <= 180 ? '' : 'Longitude is between -180 and 180'; } }
      ], 'Send', 'Others see a place card that opens on their map. The position saved on your node is filled in.').then(function (v) {
        if (v) submit('m:' + (+v.lat).toFixed(6) + ',' + (+v.lon).toFixed(6) + '|' + v.label.trim().replace(/\|/g, '/') + '|');
      });
    }
    async function submit(override) {
      var text = typeof override === 'string' ? override : input.value.trim(); if (!text || opts.canSend === false) return;
      if (S.status !== 'online') { UI.toast('Not connected to the node', 'bad'); return; }
      var chunks = typeof override === 'string' ? [text] : parts();
      if (chunks.length > MAX_PARTS) { UI.toast('Too long: that would be ' + chunks.length + ' messages, the most is ' + MAX_PARTS, 'bad'); return; }
      if (typeof override === 'string' && MC.byteLen(text) > limit()) { UI.toast('That place name is too long', 'bad'); return; }
      if (typeof override !== 'string') input.value = '';
      var rp = typeof override === 'string' ? null : replyTo; if (typeof override !== 'string') setReply(null); stick = true; updateCount();
      for (var i = 0; i < chunks.length; i++) {
        var sent;
        try {
          sent = opts.kind === 'channel' ? await W.sendChannel(opts.channelIdx, chunks[i], { replyTo: i === 0 && rp ? rp.who : '' }) : await W.sendDm(conv, chunks[i]);
        } catch (e) { UI.toast(e.message, 'bad'); sent = { status: 'failed' }; }
        if (sent && sent.status === 'failed' && i + 1 < chunks.length) {   // the rest goes back in the box rather than being lost
          input.value = chunks.slice(i + 1).join(' '); updateCount(); UI.toast('Stopped: ' + (chunks.length - i - 1) + ' more part(s) were not sent', 'bad'); break;
        }
      }
    }
    async function resend(m) {
      if (opts.kind === 'channel') { S.convs[conv] = S.convs[conv].filter(function (x) { return x !== m; }); await W.sendChannel(opts.channelIdx, m.text, { replyTo: m.replyTo }); }
      else { m.tries = 0; await W.sendDm(conv, m.text, m); }
    }

    offs.push(W.bus.on('msg', function (e) { if (e.conv === conv) { render(); if (e.incoming && S.active === conv && !document.hidden) W.markRead(conv); } }));
    offs.push(W.bus.on('contacts', renderTop)); offs.push(W.bus.on('channels', renderTop));
    offs.push(W.bus.on('settings', function () { thread.style.setProperty('--ts', W.settings.textScale); render(); }));
    var vis = function () { if (!document.hidden && S.active === conv) W.markRead(conv); };
    document.addEventListener('visibilitychange', vis);
    S.active = conv; W.markRead(conv);
    renderTop(); render(); updateCount();
    thread.scrollTop = thread.scrollHeight;
    if (!coarse && opts.canSend !== false) input.focus();
    return { destroy: function () { offs.forEach(function (f) { f(); }); document.removeEventListener('visibilitychange', vis); if (S.active === conv) S.active = null; }, refresh: function () { renderTop(); render(); } };
  }
  root.Chat = { open: open, splitText: splitText };
})(window);
