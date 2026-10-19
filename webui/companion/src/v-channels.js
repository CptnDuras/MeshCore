// Channels: list, add / join / edit / delete, communities, regions, and the channel conversation.
(function (root) {
  'use strict';
  var el = UI.el, W = root.W, S = W.S;
  var sp, chat = null, sortMode = W.store.get('mcw2:chsort', 'manual');

  function keyBytes(hex) { return MC.unhex(hex); }
  function hexOf(bytes) { return MC.hex(bytes, 0, bytes.length); }
  function zeros(hex) { return !/[^0]/.test(hex); }
  function normTag(s) { return s.trim().replace(/^#+/, '').replace(/\s+/g, '-'); }

  // what kind of channel is this? decided from the key, the same way every client derives them
  function kindOf(ch) {
    if (ch.secret === MCrypto.PUBLIC_KEY_HEX) return { id: 'public', icon: 'globe', label: 'Public' };
    for (var i = 0; i < S.communities.length; i++) {
      var c = S.communities[i], sec = MCrypto.unb64(c.secret);
      if (hexOf(MCrypto.communityPublicKey(sec)) === ch.secret) return { id: 'community', icon: 'users', label: c.name + ' · public', community: c };
      var tag = /#([^\s#]+)$/.exec(ch.name);
      if (tag && hexOf(MCrypto.communityKey(sec, tag[1])) === ch.secret) return { id: 'community', icon: 'users', label: c.name + ' · #' + tag[1], community: c };
    }
    if (ch.name.charAt(0) === '#' && hexOf(MCrypto.hashtagKey(ch.name)) === ch.secret) return { id: 'hashtag', icon: 'hash', label: 'Hashtag' };
    return { id: 'private', icon: 'lock', label: 'Private' };
  }
  function freeSlot() { for (var i = 0; i < S.dev.maxChannels; i++) if (!S.channels[i]) return i; return -1; }

  async function saveChannel(idx, name, key) {
    await W.req(MC.enc.setChannel(idx, name, key), ['ok']);
    var c = await W.req(MC.enc.getChannel(idx), ['channel']);
    S.channels[idx] = c; W.bus.emit('channels');
    if (S.chOrder.indexOf(idx) < 0) S.chOrder.push(idx); W.persist();
    return c;
  }
  async function removeChannel(idx) {
    await W.req(MC.enc.setChannel(idx, '', new Uint8Array(16)), ['ok']);
    delete S.channels[idx]; delete S.convs['ch:' + idx]; delete S.unread['ch:' + idx]; delete S.chRegion[idx];
    S.chOrder = S.chOrder.filter(function (i) { return i !== idx; }); W.persist(); W.bus.emit('channels');
  }

  function ordered() {
    var idxs = Object.keys(S.channels).map(Number), q = sp.search.value.trim().toLowerCase();
    idxs = idxs.filter(function (i) { return !q || S.channels[i].name.toLowerCase().indexOf(q) >= 0; });
    function last(i) { var l = S.convs['ch:' + i]; return l && l.length ? l[l.length - 1] : null; }
    if (sortMode === 'az') idxs.sort(function (a, b) { return S.channels[a].name.localeCompare(S.channels[b].name); });
    else if (sortMode === 'recent') idxs.sort(function (a, b) { return (last(b) ? last(b).ts : 0) - (last(a) ? last(a).ts : 0); });
    else if (sortMode === 'unread') idxs.sort(function (a, b) { return (S.unread['ch:' + b] || 0) - (S.unread['ch:' + a] || 0); });
    else idxs.sort(function (a, b) { var x = S.chOrder.indexOf(a), y = S.chOrder.indexOf(b); return (x < 0 ? 999 : x) - (y < 0 ? 999 : y) || a - b; });
    return idxs;
  }

  function renderList() {
    UI.clear(sp.rows);
    var idxs = ordered();
    if (S.loading.channels && !idxs.length) { sp.rows.appendChild(el('div', { class: 'empty', text: 'Reading channels from the node…' })); return; }
    if (!idxs.length) {
      sp.rows.appendChild(el('div', { class: 'empty' }, [el('h3', { text: S.status === 'online' ? 'No channels' : 'Not connected' }),
        el('p', { text: S.status === 'online' ? 'Join the public channel or make a private one with the + button.' : 'Channels appear once the node answers.' })]));
      return;
    }
    var cur = parseInt((location.hash.split('/')[2] || ''), 10);
    idxs.forEach(function (i) {
      var ch = S.channels[i], kind = kindOf(ch), conv = 'ch:' + i, list = S.convs[conv] || [], lastMsg = list[list.length - 1];
      var unread = S.unread[conv] || 0, muted = !!S.muted[conv];
      var av = UI.avatar(ch.name, { icon: kind.icon, hue: kind.id === 'public' ? 140 : kind.id === 'community' ? 300 : 210 });
      var row = el('button', { class: 'row' + (cur === i ? ' sel' : ''), role: 'listitem', type: 'button', onclick: function () { App.go('channels', String(i)); } }, [
        av, el('div', { class: 't' }, [el('b', { text: ch.name || 'Channel ' + i }),
          el('small', { text: lastMsg ? (lastMsg.me ? 'You: ' : lastMsg.who ? lastMsg.who + ': ' : '') + lastMsg.text : kind.label })]),
        el('div', { class: 'side' }, [lastMsg ? el('span', { text: UI.ago(lastMsg.ts) }) : null,
          unread ? el('span', { class: 'badge' + (muted ? ' muted' : ''), text: unread }) : (muted ? UI.icon('bellOff', 14) : null)])]);
      sp.rows.appendChild(row);
    });
  }

  function show(arg) {
    var idx = arg === '' || arg == null ? NaN : parseInt(arg, 10);
    if (chat) { chat.destroy(); chat = null; }
    renderList();
    if (isNaN(idx) || !S.channels[idx]) {
      sp.open(false);
      sp.placeholder('hash', 'Pick a channel', 'Channels are group chats everyone with the same key can read.');
      if (!isNaN(idx) && S.status === 'online' && !S.loading.channels) { App.go('channels', ''); }
      return;
    }
    sp.open(true);
    var conv = 'ch:' + idx;
    chat = Chat.open(sp.detail, {
      conv: conv, kind: 'channel', channelIdx: idx, emptyHint: 'Everyone on this channel will see what you write.',
      title: function () { var c = S.channels[idx]; return c ? c.name || 'Channel ' + idx : 'Channel ' + idx; },
      subtitle: function () {
        var c = S.channels[idx]; if (!c) return ''; var r = W.regionFor(idx);
        return kindOf(c).label + (r ? ' · region #' + r + (S.chRegion[idx] ? '' : ' (default)') : '') + ' · slot ' + idx + (S.muted[conv] ? ' · muted' : '');
      },
      avatar: function () { var c = S.channels[idx] || { name: '?', secret: '' }, k = kindOf(c); return UI.avatar(c.name, { icon: k.icon, hue: k.id === 'public' ? 140 : k.id === 'community' ? 300 : 210 }); },
      onBack: function () { App.go('channels', ''); },
      menu: function () { return channelMenu(idx); }
    });
  }

  function channelMenu(idx) {
    var conv = 'ch:' + idx, ch = S.channels[idx];
    return [
      { label: 'Region…', icon: 'pin', run: function () { pickRegion(idx); } },
      { label: S.muted[conv] ? 'Unmute' : 'Mute', icon: S.muted[conv] ? 'bell' : 'bellOff', run: function () { S.muted[conv] = !S.muted[conv]; if (!S.muted[conv]) delete S.muted[conv]; W.persist(); chat.refresh(); renderList(); App.updateBadges(); } },
      { label: 'Edit name or key…', icon: 'gear', run: function () { editChannel(idx); } },
      { label: 'Share key…', icon: 'copy', run: function () { shareChannel(idx); } },
      { label: 'Move up', icon: 'back', run: function () { move(idx, -1); } },
      { label: 'Move down', icon: 'back', run: function () { move(idx, 1); } },
      { sep: true },
      { label: 'Clear history in this browser', icon: 'trash', run: function () { UI.confirm('Clear history', 'Remove the messages kept in this browser for this channel? They stay on the mesh.', 'Clear', true).then(function (ok) { if (ok) W.clearConv(conv); }); } },
      { label: 'Delete channel from the node', icon: 'trash', danger: true, run: function () {
        UI.confirm('Delete channel', 'Delete "' + ch.name + '" from the node? You will stop receiving it until you join again.', 'Delete', true).then(function (ok) {
          if (ok) removeChannel(idx).then(function () { App.go('channels', ''); UI.toast('Channel deleted'); }, function (e) { UI.toast(e.message, 'bad'); });
        });
      } }
    ];
  }
  function move(idx, d) {
    var o = ordered().length ? Object.keys(S.channels).map(Number).sort(function (a, b) { var x = S.chOrder.indexOf(a), y = S.chOrder.indexOf(b); return (x < 0 ? 999 : x) - (y < 0 ? 999 : y) || a - b; }) : [];
    var i = o.indexOf(idx), j = i + d; if (j < 0 || j >= o.length) return;
    o.splice(j, 0, o.splice(i, 1)[0]); S.chOrder = o; sortMode = 'manual'; W.store.set('mcw2:chsort', sortMode); W.persist(); renderList();
  }
  function pickRegion(idx) {
    var opts = [{ value: '', label: S.defaultRegion ? 'Use the default (#' + S.defaultRegion + ')' : 'No region (unscoped)' }].concat(S.regions.map(function (r) { return { value: r, label: '#' + r }; }));
    UI.form('Region for this channel', [{ name: 'r', label: 'Region', options: opts, value: S.chRegion[idx] || '', hint: 'A region limits which repeaters pass your messages on. Add region names under Settings → Regions.' }], 'Use').then(function (v) {
      if (!v) return; if (v.r) S.chRegion[idx] = v.r; else delete S.chRegion[idx]; W.persist(); chat.refresh();
    });
  }
  function editChannel(idx) {
    var ch = S.channels[idx];
    UI.form('Edit channel', [
      { name: 'name', label: 'Name', value: ch.name, maxlength: 31, required: true },
      { name: 'key', label: 'Key (32 hex characters)', value: ch.secret, maxlength: 40, validate: function (v) { return v.replace(/[^0-9a-f]/gi, '').length === 32 ? '' : 'The key is 32 hex characters'; }, hint: 'Everyone on the channel needs the same key. Changing it moves you to a different channel.' }
    ], 'Save').then(function (v) {
      if (!v) return;
      saveChannel(idx, v.name.trim(), keyBytes(v.key.replace(/[^0-9a-f]/gi, ''))).then(function () { UI.toast('Saved'); if (chat) chat.refresh(); }, function (e) { UI.toast(e.message, 'bad'); });
    });
  }
  function shareChannel(idx) {
    var ch = S.channels[idx], text = 'Channel "' + ch.name + '"\nKey: ' + ch.secret;
    UI.dialog('Share channel', [el('p', { text: 'Anyone with the name and key can join and read this channel. Share it only with people you trust.' }), el('pre', { class: 'console', style: 'height:auto', text: text })],
      [{ label: 'Close', value: 0 }, { label: 'Copy', kind: 'primary', run: function () { UI.copy(text); return false; } }]);
  }

  // ---- adding channels ----
  function addChannel() {
    if (S.status !== 'online') { UI.toast('Not connected to the node', 'bad'); return; }
    if (freeSlot() < 0) { UI.alert('No free slot', el('p', { text: 'The node holds ' + S.dev.maxChannels + ' channels and all slots are used. Delete one first.' })); return; }
    var hasPublic = Object.keys(S.channels).some(function (i) { return S.channels[i].secret === MCrypto.PUBLIC_KEY_HEX; });
    var opts = [
      { label: 'Join a hashtag channel', sub: 'Anyone who types the same #name lands on the same channel.', run: joinHashtag },
      { label: 'Create a private channel', sub: 'Makes a random key you can share.', run: createPrivate },
      { label: 'Join a private channel', sub: 'You have a name and a 32-character key.', run: joinPrivate }
    ];
    if (!hasPublic) opts.unshift({ label: 'Join the public channel', sub: 'The well-known open channel.', run: joinPublic });
    opts.push({ label: 'Communities…', sub: 'Create or join a community with its own channels.', run: communities });
    var box = el('div', { class: 'rows' }), dlg;
    opts.forEach(function (o) { box.appendChild(el('button', { class: 'row', type: 'button', onclick: function () { dlg._finish(); o.run(); } }, [el('div', { class: 't' }, [el('b', { text: o.label }), el('small', { text: o.sub })])])); });
    UI.dialog('Add a channel', box, []); dlg = document.querySelector('.layer:last-child .dialog');
  }
  function done(p) { return p.then(function (c) { UI.toast('Channel added'); App.go('channels', String(Object.keys(S.channels).filter(function (i) { return S.channels[i] === c; })[0] || '')); }, function (e) { UI.toast(e.message, 'bad'); }); }
  function joinPublic() { done(saveChannel(freeSlot(), 'Public', keyBytes(MCrypto.PUBLIC_KEY_HEX))); }
  function joinHashtag() {
    UI.form('Join a hashtag channel', [{ name: 'tag', label: 'Hashtag', placeholder: 'hiking', required: true, maxlength: 30, validate: function (v) { return normTag(v) ? '' : 'Enter a name'; } }], 'Join').then(function (v) {
      if (!v) return; var t = normTag(v.tag); done(saveChannel(freeSlot(), '#' + t, MCrypto.hashtagKey(t)));
    });
  }
  function randomKey() { return MCrypto.randomBytes(16); }
  function createPrivate() {
    UI.form('Create a private channel', [{ name: 'name', label: 'Name', required: true, maxlength: 31 }], 'Create').then(function (v) {
      if (!v) return; var key = randomKey(); done(saveChannel(freeSlot(), v.name.trim(), key));
    });
  }
  function joinPrivate() {
    UI.form('Join a private channel', [{ name: 'name', label: 'Name', required: true, maxlength: 31 },
      { name: 'key', label: 'Key', required: true, maxlength: 60, hint: 'Spaces and dashes are ignored.', validate: function (v) { return v.replace(/[^0-9a-f]/gi, '').length === 32 ? '' : 'The key is 32 hex characters'; } }], 'Join').then(function (v) {
      if (!v) return; done(saveChannel(freeSlot(), v.name.trim(), keyBytes(v.key.replace(/[^0-9a-f]/gi, ''))));
    });
  }

  // ---- communities: a shared secret from which a set of channel keys is derived ----
  function communityJson(c) { return JSON.stringify({ v: 1, type: 'meshcore_community', name: c.name, k: c.secret }); }
  function communities() {
    var box = el('div');
    function paint() {
      UI.clear(box);
      if (!S.communities.length) box.appendChild(el('p', { class: 'dim', text: 'No communities yet. A community is a private namespace: only people who hold its secret can find or read its channels.' }));
      S.communities.forEach(function (c) {
        var id = hexOf(MCrypto.communityId(MCrypto.unb64(c.secret))).slice(0, 8);
        box.appendChild(el('div', { class: 'setrow' }, [UI.avatar(c.name, { icon: 'users', hue: 300 }), el('div', { class: 't' }, [el('b', { text: c.name }), el('small', { text: 'id ' + id })]),
          UI.btn('Channels', { kind: 'small', onclick: function () { communityChannels(c); } }), UI.btn('Share', { kind: 'small', onclick: function () { shareCommunity(c); } }),
          UI.btn('', { icon: 'trash', kind: 'ghost danger', title: 'Leave', onclick: function () { leaveCommunity(c).then(paint); } })]));
      });
      box.appendChild(el('div', { class: 'btnrow', style: 'margin-top:10px' }, [UI.btn('Create community', { icon: 'plus', onclick: function () { createCommunity().then(paint); } }), UI.btn('Join with a code', { onclick: function () { joinCommunity().then(paint); } })]));
    }
    paint(); UI.dialog('Communities', box, [{ label: 'Close', value: 0 }]);
  }
  function createCommunity() {
    return UI.form('Create a community', [{ name: 'name', label: 'Name', required: true, maxlength: 24 }, { name: 'pub', label: 'Also add its public channel', type: 'check', value: true }], 'Create').then(function (v) {
      if (!v) return; var c = { id: Date.now().toString(36), name: v.name.trim(), secret: MCrypto.b64(MCrypto.randomBytes(32)).replace(/\+/g, '-').replace(/\//g, '_') };
      S.communities.push(c); W.persist();
      if (v.pub && freeSlot() >= 0) saveChannel(freeSlot(), c.name + ' Public', MCrypto.communityPublicKey(MCrypto.unb64(c.secret))).catch(function (e) { UI.toast(e.message, 'bad'); });
      shareCommunity(c);
    });
  }
  function joinCommunity() {
    return UI.form('Join a community', [{ name: 'code', label: 'Community code', type: 'textarea', required: true, hint: 'Paste the text you were given: {"v":1,"type":"meshcore_community",…}' }], 'Join').then(function (v) {
      if (!v) return;
      try {
        var j = JSON.parse(v.code.trim());
        if (j.type !== 'meshcore_community' || !j.k || !j.name) throw new Error('not a community code');
        if (MCrypto.unb64(j.k).length !== 32) throw new Error('the secret is not 32 bytes');
        if (S.communities.some(function (c) { return c.secret === j.k; })) { UI.toast('You are already in that community'); return; }
        S.communities.push({ id: Date.now().toString(36), name: String(j.name).slice(0, 24), secret: j.k }); W.persist(); UI.toast('Joined ' + j.name); renderList();
      } catch (e) { UI.toast('That is not a community code: ' + e.message, 'bad'); }
    });
  }
  function shareCommunity(c) {
    var text = communityJson(c);
    UI.dialog('Share ' + c.name, [el('p', { text: 'Send this code to the people you want in the community. Anyone who has it can read the community\'s channels.' }), el('pre', { class: 'console', style: 'height:auto;word-break:break-all', text: text })],
      [{ label: 'Close', value: 0 }, { label: 'Copy', kind: 'primary', run: function () { UI.copy(text); return false; } }]);
  }
  function communityChannels(c) {
    var sec = MCrypto.unb64(c.secret);
    UI.dialog('Add a channel to ' + c.name, el('div', { class: 'rows' }, [
      el('button', { class: 'row', type: 'button', onclick: function () { document.querySelector('.layer:last-child').remove(); if (freeSlot() < 0) return UI.toast('No free slot', 'bad'); done(saveChannel(freeSlot(), c.name + ' Public', MCrypto.communityPublicKey(sec))); } }, [el('div', { class: 't' }, [el('b', { text: 'Public channel' }), el('small', { text: 'Open to every member.' })])]),
      el('button', { class: 'row', type: 'button', onclick: function () {
        document.querySelector('.layer:last-child').remove();
        UI.form('Community hashtag', [{ name: 'tag', label: 'Hashtag', required: true, maxlength: 20 }], 'Add').then(function (v) {
          if (!v) return; var t = normTag(v.tag).toLowerCase(); if (freeSlot() < 0) return UI.toast('No free slot', 'bad'); done(saveChannel(freeSlot(), c.name + ' #' + t, MCrypto.communityKey(sec, t)));
        });
      } }, [el('div', { class: 't' }, [el('b', { text: 'Hashtag channel' }), el('small', { text: 'A topic inside the community.' })])])]), [{ label: 'Close', value: 0 }]);
  }
  function leaveCommunity(c) {
    var sec = MCrypto.unb64(c.secret), mine = Object.keys(S.channels).filter(function (i) { var k = kindOf(S.channels[i]); return k.community && k.community.secret === c.secret; });
    return UI.confirm('Leave ' + c.name, 'This removes the community from this browser' + (mine.length ? ' and deletes its ' + mine.length + ' channel(s) from the node.' : '.'), 'Leave', true).then(function (ok) {
      if (!ok) return;
      return mine.reduce(function (p, i) { return p.then(function () { return removeChannel(+i); }); }, Promise.resolve()).then(function () {
        S.communities = S.communities.filter(function (x) { return x !== c; }); W.persist(); renderList();
      }, function (e) { UI.toast(e.message, 'bad'); });
    });
  }

  function mount(box) {
    sp = Split.make(box, 'Channels');
    var sort = el('select', { class: 'sel', 'aria-label': 'Sort channels', onchange: function () { sortMode = sort.value; W.store.set('mcw2:chsort', sortMode); renderList(); } },
      [['manual', 'My order'], ['recent', 'Latest message'], ['unread', 'Unread first'], ['az', 'A to Z']].map(function (o) { return el('option', { value: o[0], text: o[1], selected: o[0] === sortMode }); }));
    sp.tools.appendChild(sort);
    sp.head.appendChild(UI.btn('', { icon: 'refresh', kind: 'ghost', title: 'Read channels from the node again', onclick: function () { W.loadChannels().catch(function (e) { UI.toast(e.message, 'bad'); }); } }));
    sp.head.appendChild(UI.btn('', { icon: 'plus', kind: 'primary', title: 'Add a channel', onclick: addChannel }));
    sp.onSearch(renderList);
    ['channels', 'msg', 'unread', 'status'].forEach(function (ev) { W.bus.on(ev, function () { if (App.current() && App.current().id === 'channels') renderList(); }); });
    W.bus.on('channels', function () { if (App.current() && App.current().id === 'channels' && !chat) show(location.hash.split('/')[2]); });
  }

  App.register({ id: 'channels', title: 'Channels', icon: 'hash', mount: mount, show: show,
    badge: function () { var n = 0; for (var k in S.unread) if (k.indexOf('ch:') === 0 && !S.muted[k]) n += S.unread[k] || 0; return n; } });
  W.kindOf = kindOf; W.saveChannel = saveChannel; W.communities = communities;
})(window);
