// Core: event bus, storage, the WebSocket link, node state and the messaging engine.
(function (root) {
  'use strict';
  var MC = root.MC;

  // ---- events ----
  var handlers = {};
  var bus = {
    on: function (ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn); return function () { bus.off(ev, fn); }; },
    off: function (ev, fn) { handlers[ev] = (handlers[ev] || []).filter(function (f) { return f !== fn; }); },
    emit: function (ev, data) { (handlers[ev] || []).slice().forEach(function (f) { try { f(data); } catch (e) { console.error(ev, e); } }); }
  };

  // ---- storage: a per-browser convenience only; every access is guarded and the page works without it ----
  var store = {
    get: function (key, dflt) { try { var v = localStorage.getItem(key); return v == null ? dflt : JSON.parse(v); } catch (e) { return dflt; } },
    set: function (key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { } },
    del: function (key) { try { localStorage.removeItem(key); } catch (e) { } }
  };

  // ---- app settings (this browser only) ----
  var DEFAULT_SETTINGS = { theme: 'auto', units: 'metric', textScale: 1, retries: 3, sound: false, showTrace: false, coords: true, clearPathOnFail: false, markRead: true };
  var settings = Object.assign({}, DEFAULT_SETTINGS, store.get('mcw2:settings', {}));
  function setSetting(k, v) { settings[k] = v; store.set('mcw2:settings', settings); bus.emit('settings', k); }

  // ---- node state ----
  var S = {
    self: null, dev: null, batt: null, contacts: {}, channels: {}, convs: {}, unread: {}, muted: {}, active: null,
    clockOff: 0, acks: {}, vars: {}, autoAdd: null, groups: {}, communities: [], regions: [], defaultRegion: '', chRegion: {},
    chOrder: [], discovered: {}, status: 'connecting', loading: { contacts: false, channels: false }, lastSync: 0, seen: {}
  };
  function nodeKey(sfx) { return 'mcw2:' + (S.self ? S.self.key.slice(0, 16) : 'x') + ':' + sfx; }
  var saveTimer = 0;
  function persist() {
    if (saveTimer) return;
    saveTimer = setTimeout(function () {
      saveTimer = 0; if (!S.self) return;
      var c = {}; for (var k in S.convs) c[k] = S.convs[k].slice(-300).map(function (m) { var o = Object.assign({}, m); delete o.timer; return o; });
      store.set(nodeKey('convs'), c); store.set(nodeKey('unread'), S.unread); store.set(nodeKey('muted'), S.muted);
      store.set(nodeKey('groups'), S.groups); store.set(nodeKey('communities'), S.communities); store.set(nodeKey('chorder'), S.chOrder);
      store.set(nodeKey('regions'), { list: S.regions, def: S.defaultRegion, per: S.chRegion });
    }, 400);
  }
  function restore() {
    S.convs = store.get(nodeKey('convs'), {}); S.unread = store.get(nodeKey('unread'), {}); S.muted = store.get(nodeKey('muted'), {});
    S.groups = store.get(nodeKey('groups'), {}); S.communities = store.get(nodeKey('communities'), []); S.chOrder = store.get(nodeKey('chorder'), []);
    var r = store.get(nodeKey('regions'), { list: [], def: '', per: {} }); S.regions = r.list || []; S.defaultRegion = r.def || ''; S.chRegion = r.per || {};
    for (var k in S.convs) S.convs[k].forEach(function (m) { if (m.status === 'sending') m.status = 'failed'; if (m.status === 'sent' && m.me && !m.channel) m.status = 'unconfirmed'; });
  }

  // ---- the link: one command, one answer, plus pushes ----
  var ws, queue = [], cur = null, retryMs = 1000, stopped = false, gen = 0;
  function req(frame, accept, opts) {
    opts = opts || {};
    return new Promise(function (res, rej) {
      queue.push({ frame: frame, accept: accept || ['ok'], res: res, rej: rej, ms: opts.ms || 8000, idle: !!opts.idle, gen: gen });
      pump();
    });
  }
  function pump() {
    if (cur || !queue.length || !ws || ws.readyState !== 1) return;
    cur = queue.shift(); arm();
    try { ws.send(cur.frame); } catch (e) { done(null, 'send failed'); }
  }
  function arm() { if (!cur) return; clearTimeout(cur.timer); cur.timer = setTimeout(function () { done(null, 'no answer from the node'); }, cur.ms); }
  function done(m, err) {
    if (!cur) return;
    clearTimeout(cur.timer); var c = cur; cur = null;
    if (err) c.rej(new Error(err)); else c.res(m);
    pump();
  }
  function onFrame(m) {
    bus.emit('frame', m);
    if (cur && cur.idle) arm();                     // long answers (contact lists) keep the wait alive while frames arrive
    if (cur && m.t === 'err') return done(null, m.text);
    if (cur && cur.accept.indexOf(m.t) >= 0) return done(m);
    push(m);
  }
  function setStatus(s, text) { S.status = s; S.statusText = text || s; bus.emit('status', s); }

  function connect() {
    if (stopped) return;
    setStatus('connecting');
    var my = ++gen;
    ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
    ws.binaryType = 'arraybuffer';
    ws.onopen = function () {
      retryMs = 1000;
      init(my).catch(function (e) { if (my === gen) { setStatus('error', 'Setup failed: ' + e.message); try { ws.close(); } catch (x) { } } });
    };
    ws.onmessage = function (ev) { if (my === gen) onFrame(MC.dec(new Uint8Array(ev.data))); };
    ws.onclose = function () {
      if (my !== gen) return;
      setStatus('offline'); if (cur) done(null, 'connection closed');
      while (queue.length) queue.shift().rej(new Error('connection closed'));
      setTimeout(connect, retryMs); retryMs = Math.min(retryMs * 2, 15000);
    };
  }
  function send(frame) { if (ws && ws.readyState === 1) ws.send(frame); }

  // ---- startup ----
  function devNow() { return Math.floor(Date.now() / 1000) + S.clockOff; }
  async function syncClock(force) {
    var t = await req(MC.enc.getTime(), ['time']), now = Math.floor(Date.now() / 1000);
    if (force || now - t.secs > 120) { try { await req(MC.enc.setTime(now), ['ok']); t.secs = now; } catch (e) { if (force) throw e; } }
    S.clockOff = t.secs - now; bus.emit('clock');
  }
  async function init(my) {
    S.dev = await req(MC.enc.deviceQuery(), ['device']);
    S.self = await req(MC.enc.appStart('web'), ['self']);
    restore(); bus.emit('self');
    setStatus('online');
    // each of these is allowed to fail without stopping the rest: the page is useful with whatever the node answers
    var tasks = [function () { return syncClock(false); }, loadChannels, loadContacts, loadHistory, refreshBattery, loadAutoAdd, loadVars];
    for (var i = 0; i < tasks.length; i++) { try { await tasks[i](); } catch (e) { console.warn('startup step failed:', e.message); } if (my !== gen) return; }
    await syncAll();
  }
  async function refreshBattery() { try { var b = await req(MC.enc.battery(), ['battery']); S.batt = b; bus.emit('battery'); } catch (e) { } }
  async function loadAutoAdd() { try { S.autoAdd = await req(MC.enc.getAutoAdd(), ['autoAdd']); bus.emit('settings-node'); } catch (e) { S.autoAdd = null; } }
  async function loadVars() { try { S.vars = (await req(MC.enc.getVars(), ['vars'])).vars; bus.emit('settings-node'); } catch (e) { S.vars = {}; } }

  // channels: scan every slot; an unreadable or empty slot is skipped, not the end of the list
  async function loadChannels() {
    S.loading.channels = true; bus.emit('channels');
    var found = {};
    try {
      for (var i = 0; i < S.dev.maxChannels; i++) {
        try {
          var c = await req(MC.enc.getChannel(i), ['channel']);
          if (c.name || /[^0]/.test(c.secret)) found[i] = c;
        } catch (e) { if (/closed/.test(e.message)) throw e; }
      }
    } finally { S.channels = found; S.loading.channels = false; bus.emit('channels'); }
  }

  async function loadContacts() {
    S.loading.contacts = true; bus.emit('contacts');
    var fresh = {};
    var off = bus.on('frame', function (m) { if (m.t === 'contact') fresh[m.key] = m; });
    try { await req(MC.enc.getContacts(0), ['contactsEnd'], { ms: 20000, idle: true }); S.contacts = fresh; }
    finally { off(); S.loading.contacts = false; bus.emit('contacts'); }
  }

  // ---- messages ----
  var syncing = false, again = false;
  async function syncAll() {
    if (syncing) { again = true; return; }
    syncing = true;
    try { do { again = false; for (;;) { var m = await req(MC.enc.syncNext(), ['msg', 'noMore']); if (m.t === 'noMore') break; onMsg(m); } } while (again); }
    catch (e) { /* the next MSG_WAITING push starts it again */ } finally { syncing = false; }
  }
  function findContact(prefix) { for (var k in S.contacts) if (k.indexOf(prefix) === 0) return S.contacts[k]; return null; }
  function addMsg(conv, msg) {
    var list = S.convs[conv] = S.convs[conv] || [];
    msg.id = msg.id || (Date.now().toString(36) + Math.random().toString(36).slice(2, 7));
    list.push(msg); if (list.length > 400) list.shift();
    return msg;
  }
  function splitSender(text) {   // channel texts arrive as "Name: message"
    var i = text.indexOf(': ');
    return i > 0 && i <= 40 ? { who: text.slice(0, i), text: text.slice(i + 2) } : { who: '', text: text };
  }
  function parseReply(text) {    // "@[Name] message" is how a reply is written on the wire
    var m = /^@\[([^\]]{1,40})\]\s?([\s\S]*)$/.exec(text);
    return m ? { replyTo: m[1], text: m[2] } : { text: text };
  }
  // history kept on the node: merged into the conversations without touching unread counts or sounds.
  // A node without the log answers with an error, and the page just carries on with what the browser has.
  async function loadHistory() {
    var first = 0, added = 0;
    for (;;) {
      var h = await req(MC.enc.getHistory(first), ['history']);
      h.recs.forEach(function (r) { if (mergeRecord(r)) added++; });
      first += h.recs.length;
      if (!h.recs.length || first >= h.total) break;
    }
    if (added) { for (var k in S.convs) S.convs[k].sort(function (a, b) { return a.ts - b.ts; }); persist(); bus.emit('history'); }
  }
  function mergeRecord(r) {
    if (r.txt !== 0 || /^r:[0-9a-f]{4}:[0-9a-f]{2}$/.test(r.text)) return false;
    var conv, who = '', text = r.text, extra = {};
    if (r.channel) {
      conv = 'ch:' + r.idx;
      if (!r.sent) { var sp = splitSender(text); who = sp.who; text = sp.text; }
      var rp = parseReply(text); text = rp.text; if (rp.replyTo) extra.replyTo = rp.replyTo;
    } else {
      var c = findContact(r.target); conv = c ? c.key : r.target; who = r.sent ? '' : (c ? c.name : r.target);
    }
    var list = S.convs[conv] = S.convs[conv] || [];
    if (list.some(function (x) { return !!x.me === r.sent && x.ts === r.ts && x.text === text && (r.sent || x.who === who); })) return false;
    var base = r.sent ? { me: true, channel: r.channel, text: text, ts: r.ts, status: 'sent', tries: 1 }
      : { me: false, channel: r.channel, text: text, ts: r.ts, who: who, snr: r.snr, hops: r.pathLen === 255 ? -1 : r.pathLen & 63, recvAt: r.ts };
    addMsg(conv, Object.assign(base, extra));
    return true;
  }
  function onMsg(m) {
    var conv, who = '', text = m.text, extra = {};
    if (m.channel) {
      conv = 'ch:' + m.idx; var sp = splitSender(text); who = sp.who; text = sp.text;
      var rp = parseReply(text); text = rp.text; if (rp.replyTo) extra.replyTo = rp.replyTo;
    } else {
      var c = findContact(m.from); conv = c ? c.key : m.from; who = c ? c.name : m.from;
    }
    if (reactionOf(conv, who, text, m.ts)) { persist(); return; }
    var dup = (S.convs[conv] || []).some(function (x) { return !x.me && x.ts === m.ts && x.text === text && x.who === who; });
    if (dup) return;
    var msg = addMsg(conv, Object.assign({ me: false, channel: !!m.channel, text: text, ts: m.ts, who: who, snr: m.snr, hops: m.pathLen === 255 ? -1 : m.pathLen & 63, cli: !m.channel && (m.kind >> 2) === 1, recvAt: Math.floor(Date.now() / 1000) }, extra));
    if (msg.cli) { /* an answer to a command typed at a repeater: it belongs to the console, not the unread count */ }
    else if (S.active !== conv || document.hidden) { S.unread[conv] = (S.unread[conv] || 0) + 1; }
    persist(); bus.emit('msg', { conv: conv, msg: msg, incoming: true });
  }
  // a reaction is a message of its own: "r:<4 hex of the target hash>:<2 hex emoji index>"
  var EMOJI = ['👍', '❤️', '😂', '🎉', '👏', '🔥', '😮', '😢', '🙏', '👀', '✅', '❌'];
  function msgHash(msg) {
    var s = (msg.ts + ':' + (msg.who || '') + ':' + msg.text), h = 0;
    for (var i = 0; i < s.length; i++) h = (h * 33 + s.charCodeAt(i)) >>> 0;
    return ('0000' + (h & 0xffff).toString(16)).slice(-4);
  }
  function reactionOf(conv, who, text, ts) {
    var m = /^r:([0-9a-f]{4}):([0-9a-f]{2})$/.exec(text); if (!m) return false;
    var idx = parseInt(m[2], 16), target = (S.convs[conv] || []).slice().reverse().filter(function (x) { return msgHash(x) === m[1]; })[0];
    if (target && EMOJI[idx]) { (target.reactions = target.reactions || []).push({ e: EMOJI[idx], who: who }); bus.emit('msg', { conv: conv, msg: target, incoming: false }); }
    return true;
  }

  // ---- a short beep for new messages (opt-in; browsers only allow audio after the page has been clicked once) ----
  var actx = null;
  document.addEventListener('click', function () { if (!actx) { try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { } } }, { once: true });
  function beep() {
    if (!actx || !settings.sound) return;
    try { var o = actx.createOscillator(), g = actx.createGain(); o.frequency.value = 880; g.gain.value = 0.05; o.connect(g); g.connect(actx.destination); o.start(); o.stop(actx.currentTime + 0.12); } catch (e) { }
  }
  bus.on('msg', function (e) { if (e.incoming && e.msg && !e.msg.cli && !S.muted[e.conv] && (S.active !== e.conv || document.hidden)) beep(); });

  // ---- push events ----
  function push(m) {
    switch (m.t) {
      case 'contact': S.contacts[m.key] = m; S.seen[m.key] = Date.now(); bus.emit('contacts'); break;
      case 'newAdvert':
        // unknown node heard: it is a contact only if the node stored it (auto-add), otherwise it waits in the discovered list
        S.discovered[m.key] = m; S.seen[m.key] = Date.now(); bus.emit('advert', m); bus.emit('contacts');
        setTimeout(function () { refreshContact(m.key); }, 700); break;
      case 'advert': if (S.contacts[m.key]) { S.contacts[m.key].lastAdvert = Math.floor(Date.now() / 1000); bus.emit('contacts'); } break;
      case 'pathUpdated': refreshContact(m.key); break;
      case 'msgWaiting': syncAll(); break;
      case 'delivered': onDelivered(m); break;
      case 'contactDeleted': delete S.contacts[m.key]; delete S.discovered[m.key]; bus.emit('contacts'); break;
      case 'contactsFull': UI.toast('The node\'s contact list is full', 'bad'); break;
      default: bus.emit('push', m);
    }
  }
  async function refreshContact(key) {
    try { var c = await req(MC.enc.getContactByKey(key), ['contact']); S.contacts[c.key] = c; delete S.discovered[c.key]; bus.emit('contacts'); } catch (e) { }
  }

  // ---- sending ----
  function maxDmBytes() { return 156; }
  function maxChannelBytes() { var n = Math.min(31, MC.byteLen((S.self && S.self.name) || '') || 31); return Math.max(10, 160 - n - 2); }
  async function sendDm(key, text, existing) {
    var c = S.contacts[key]; if (!c) throw new Error('unknown contact');
    var msg = existing || addMsg(key, { me: true, channel: false, text: text, ts: devNow(), status: 'sending', tries: 0 });
    msg.status = 'sending'; msg.error = ''; bus.emit('msg', { conv: key, msg: msg });
    await attempt(c, msg); persist();
    return msg;
  }
  async function attempt(c, msg) {
    msg.tries = (msg.tries || 0) + 1;
    try {
      var r = await req(MC.enc.sendText(c.key, msg.text, msg.ts, msg.tries - 1), ['sent']);
      msg.flood = r.flood; msg.status = 'sent'; msg.sentAt = Date.now();
      msg.ackIds = (msg.ackIds || []).concat([r.ack]); S.acks[r.ack] = { msg: msg, conv: c.key, at: Date.now() };
      var wait = Math.min(45000, Math.max(r.timeoutMs * 1.5, 5000));
      clearTimeout(msg.timer);
      msg.timer = setTimeout(function () { onNoAck(c, msg); }, wait);
    } catch (e) { msg.status = 'failed'; msg.error = e.message; clearTimeout(msg.timer); }
    bus.emit('msg', { conv: c.key, msg: msg });
  }
  function onNoAck(c, msg) {
    if (msg.status === 'delivered') return;
    if (msg.tries < settings.retries && S.status === 'online') { msg.status = 'retrying'; bus.emit('msg', { conv: c.key, msg: msg }); setTimeout(function () { if (msg.status === 'retrying') attempt(c, msg); }, 1000 * Math.pow(2, msg.tries - 1)); }
    else {
      msg.status = 'failed'; msg.error = 'no acknowledgement'; bus.emit('msg', { conv: c.key, msg: msg });
      if (settings.clearPathOnFail) req(MC.enc.resetPath(c.key), ['ok']).catch(function () { });
      persist();
    }
  }
  function onDelivered(m) {
    var hit = S.acks[m.ack]; if (!hit) return;
    var msg = hit.msg; clearTimeout(msg.timer);
    msg.status = 'delivered'; msg.ms = m.tripMs; msg.error = '';
    bus.emit('msg', { conv: hit.conv, msg: msg }); persist();
  }
  async function sendChannel(idx, text, opts) {
    opts = opts || {};
    var conv = 'ch:' + idx, body = opts.replyTo ? '@[' + opts.replyTo + '] ' + text : text;
    var msg = addMsg(conv, { me: true, channel: true, text: text, replyTo: opts.replyTo || '', ts: devNow(), status: 'sending', who: S.self.name });
    bus.emit('msg', { conv: conv, msg: msg });
    try {
      var scope = regionFor(idx, opts.region);
      if (scope) await req(MC.enc.setScope(MCrypto.regionKey(scope)), ['ok']);
      try { await req(MC.enc.sendChannel(idx, body, msg.ts), ['ok']); msg.status = 'sent'; msg.region = scope || ''; }
      finally { if (scope) req(MC.enc.setScope(null), ['ok']).catch(function () { }); }
    } catch (e) { msg.status = 'failed'; msg.error = e.message; }
    bus.emit('msg', { conv: conv, msg: msg }); persist();
    return msg;
  }
  function regionFor(idx, override) { return override != null ? override : (S.chRegion[idx] || S.defaultRegion || ''); }
  async function sendReaction(conv, target, emojiIdx) {
    var body = 'r:' + msgHash(target) + ':' + ('0' + emojiIdx.toString(16)).slice(-2);
    if (conv.indexOf('ch:') === 0) await req(MC.enc.sendChannel(+conv.slice(3), body, devNow()), ['ok']);
    else await req(MC.enc.sendText(conv, body, devNow(), 0), ['sent']);
    (target.reactions = target.reactions || []).push({ e: EMOJI[emojiIdx], who: S.self.name, mine: true });
    bus.emit('msg', { conv: conv, msg: target }); persist();
  }
  function clearConv(conv) { delete S.convs[conv]; S.unread[conv] = 0; persist(); bus.emit('msg', { conv: conv, cleared: true }); }
  function markRead(conv) { if (S.unread[conv]) { S.unread[conv] = 0; persist(); bus.emit('unread'); } }
  function unreadTotal(prefix) { var n = 0; for (var k in S.unread) if (!prefix || k.indexOf(prefix) === 0 || (prefix === 'dm' && k.indexOf('ch:') !== 0)) n += S.unread[k] || 0; return n; }

  root.W = { bus: bus, store: store, settings: settings, setSetting: setSetting, S: S, req: req, send: send, connect: connect, devNow: devNow,
    syncClock: syncClock, loadHistory: loadHistory, loadContacts: loadContacts, loadChannels: loadChannels, refreshBattery: refreshBattery, loadAutoAdd: loadAutoAdd, loadVars: loadVars,
    syncAll: syncAll, findContact: findContact, sendDm: sendDm, sendChannel: sendChannel, sendReaction: sendReaction, EMOJI: EMOJI, msgHash: msgHash,
    clearConv: clearConv, markRead: markRead, unreadTotal: unreadTotal, persist: persist, maxChannelBytes: maxChannelBytes, maxDmBytes: maxDmBytes,
    regionFor: regionFor, nodeKey: nodeKey, attempt: attempt, addMsg: addMsg };
})(window);
