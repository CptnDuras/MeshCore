// Map: contacts with a position on OpenStreetMap tiles. A small slippy map of our own (no library): drag to pan, wheel or
// pinch to zoom. Tiles come from the internet through the browser; without it the nodes are still placed on a plain grid.
(function (root) {
  'use strict';
  var el = UI.el, W = root.W, S = W.S, T = 256;
  var box, view, tilesEl, markersEl, popup, w = 600, h = 400, tiles = {}, shared = [];
  // a place someone shared in a chat: remembered for this session and shown as a pin of its own
  W.mapFocus = function (lat, lon, label) {
    if (!shared.some(function (p) { return p.lat === lat && p.lon === lon && p.label === label; })) shared.push({ lat: lat, lon: lon, label: label });
    prefs.lat = lat; prefs.lon = lon; prefs.z = Math.max(prefs.z, 15); App.go('map');
  };
  var prefs = W.store.get('mcw2:map', { lat: 20, lon: 0, z: 2, rep: true, people: true, other: true, age: 0, fitted: false });
  var COLORS = { 1: '#2a74c9', 2: '#c77a12', 3: '#a540a5', 4: '#1a9a88', 0: '#d6342a', 9: '#e0a800' };
  var NAMES = { 1: 'Companion', 2: 'Repeater', 3: 'Room', 4: 'Sensor', 9: 'Shared place' };

  function project(lat, lon, z) {
    var s = T * Math.pow(2, z), sin = Math.sin(Math.max(-85, Math.min(85, lat)) * Math.PI / 180);
    return { x: (lon + 180) / 360 * s, y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * s };
  }
  function unproject(x, y, z) {
    var s = T * Math.pow(2, z), n = Math.PI - 2 * Math.PI * y / s;
    return { lat: 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))), lon: x / s * 360 - 180 };
  }
  function dist(a, b) {
    var R = 6371000, r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
    var q = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.atan2(Math.sqrt(q), Math.sqrt(1 - q));
  }
  function fmtDist(m) {
    if (W.settings.units === 'imperial') { var mi = m / 1609.344; return mi < 0.2 ? Math.round(m * 3.28084) + ' ft' : mi.toFixed(mi < 10 ? 1 : 0) + ' mi'; }
    return m < 1000 ? Math.round(m) + ' m' : (m / 1000).toFixed(m < 10000 ? 1 : 0) + ' km';
  }

  function points() {
    var out = [], now = Math.floor(Date.now() / 1000), maxAge = prefs.age;
    Object.keys(S.contacts).forEach(function (k) {
      var c = S.contacts[k]; if (!c.lat && !c.lon) return;
      if (c.type === 2 && !prefs.rep) return; if (c.type === 1 && !prefs.people) return; if (c.type !== 1 && c.type !== 2 && !prefs.other) return;
      if (maxAge && now - c.lastAdvert > maxAge) return;
      out.push({ key: k, name: c.name, type: c.type, lat: c.lat, lon: c.lon, c: c });
    });
    if (S.self && (S.self.lat || S.self.lon)) out.push({ key: 'self', name: 'This node', type: 0, lat: S.self.lat, lon: S.self.lon });
    shared.forEach(function (p, i) { out.push({ key: 'shared' + i, name: p.label, type: 9, lat: p.lat, lon: p.lon }); });
    return out;
  }

  function render() {
    if (!view) return;
    w = view.clientWidth || 600; h = view.clientHeight || 400;
    var z = prefs.z, c = project(prefs.lat, prefs.lon, z), n = Math.pow(2, z), seen = {};
    var x0 = Math.floor((c.x - w / 2) / T), x1 = Math.floor((c.x + w / 2) / T), y0 = Math.max(0, Math.floor((c.y - h / 2) / T)), y1 = Math.min(n - 1, Math.floor((c.y + h / 2) / T));
    for (var tx = x0; tx <= x1; tx++) for (var ty = y0; ty <= y1; ty++) {
      var wx = ((tx % n) + n) % n, key = z + '/' + tx + '/' + ty; seen[key] = 1;
      var im = tiles[key];
      if (!im) {
        im = el('img', { alt: '', draggable: 'false', loading: 'lazy', src: 'https://tile.openstreetmap.org/' + z + '/' + wx + '/' + ty + '.png', referrerpolicy: 'no-referrer' });
        im.className = 'tile'; im.onerror = function () { this.style.visibility = 'hidden'; }; tiles[key] = im; tilesEl.appendChild(im);
      }
      im.style.transform = 'translate(' + Math.round(tx * T - c.x + w / 2) + 'px,' + Math.round(ty * T - c.y + h / 2) + 'px)';
    }
    Object.keys(tiles).forEach(function (k) { if (!seen[k]) { tiles[k].remove(); delete tiles[k]; } });
    UI.clear(markersEl);
    points().forEach(function (p) {
      var q = project(p.lat, p.lon, z), x = q.x - c.x + w / 2, y = q.y - c.y + h / 2;
      if (x < -60 || y < -40 || x > w + 60 || y > h + 40) return;
      var m = el('button', { class: 'pin', type: 'button', title: p.name, 'aria-label': p.name + ', ' + (NAMES[p.type] || 'this node'), style: 'transform:translate(' + Math.round(x) + 'px,' + Math.round(y) + 'px)', onclick: function (e) { e.stopPropagation(); showPopup(p); } },
        [el('i', { style: 'background:' + (COLORS[p.type] || COLORS[0]) }), el('span', { text: p.name })]);
      markersEl.appendChild(m);
    });
    persist();
  }
  var saveT = 0; function persist() { clearTimeout(saveT); saveT = setTimeout(function () { prefs.fitted = true; W.store.set('mcw2:map', prefs); }, 400); }

  function setView(lat, lon, z) { prefs.lat = Math.max(-84, Math.min(84, lat)); prefs.lon = ((lon + 540) % 360) - 180; prefs.z = Math.max(1, Math.min(18, z)); render(); }
  function zoomAt(dz, px, py) {
    var z0 = prefs.z, z1 = Math.max(1, Math.min(18, z0 + dz)); if (z1 === z0) return;
    var c = project(prefs.lat, prefs.lon, z0), x = c.x + (px - w / 2), y = c.y + (py - h / 2), g = unproject(x, y, z0);
    var nc = project(g.lat, g.lon, z1), center = unproject(nc.x - (px - w / 2), nc.y - (py - h / 2), z1); setView(center.lat, center.lon, z1);
  }
  function fit() {
    var pts = points(); if (!pts.length) { UI.toast('No nodes with a position yet'); return; }
    var minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
    pts.forEach(function (p) { minLat = Math.min(minLat, p.lat); maxLat = Math.max(maxLat, p.lat); minLon = Math.min(minLon, p.lon); maxLon = Math.max(maxLon, p.lon); });
    var z = 17; for (; z > 1; z--) { var a = project(maxLat, minLon, z), b = project(minLat, maxLon, z); if (Math.abs(b.x - a.x) < w - 120 && Math.abs(b.y - a.y) < h - 120) break; }
    setView((minLat + maxLat) / 2, (minLon + maxLon) / 2, pts.length === 1 ? 14 : z);
  }

  function showPopup(p) {
    UI.clear(popup); popup.hidden = false;
    var self = S.self && (S.self.lat || S.self.lon) ? { lat: S.self.lat, lon: S.self.lon } : null, rows = [];
    if (p.c) { rows.push(NAMES[p.type] + ' · ' + W.pathLabel(p.c) + ' · heard ' + UI.ago(p.c.lastAdvert)); }
    if (self && p.key !== 'self') rows.push(fmtDist(dist(self, p)) + ' from this node');
    rows.push(p.lat.toFixed(5) + ', ' + p.lon.toFixed(5));
    popup.appendChild(el('div', { class: 'dtop' }, [el('div', { class: 't' }, [el('b', { text: p.name }), el('small', { text: rows[0] })]), UI.btn('', { icon: 'x', kind: 'ghost', title: 'Close', onclick: function () { popup.hidden = true; } })]));
    rows.slice(1).forEach(function (r) { popup.appendChild(el('div', { class: 'dim', style: 'padding:2px 14px', text: r })); });
    var acts = el('div', { class: 'btnrow', style: 'padding:8px 14px 12px' });
    if (p.c) acts.appendChild(UI.btn(p.type === 2 ? 'Manage' : 'Open', { kind: 'primary small', onclick: function () { App.go('contacts', p.key); } }));
    acts.appendChild(UI.btn('Center here', { kind: 'small', onclick: function () { setView(p.lat, p.lon, Math.max(prefs.z, 13)); } }));
    if (p.c) acts.appendChild(UI.btn('Copy position', { kind: 'small', onclick: function () { UI.copy(p.lat.toFixed(6) + ', ' + p.lon.toFixed(6)); } }));
    popup.appendChild(acts);
  }

  function controls() {
    function chk(key, label) { var cb = el('input', { type: 'checkbox', checked: prefs[key], onchange: function () { prefs[key] = cb.checked; render(); } }); return el('label', { class: 'tag' }, [cb, ' ' + label]); }
    var age = el('select', { class: 'sel', 'aria-label': 'Heard within', onchange: function () { prefs.age = +age.value; render(); } },
      [[0, 'Any time'], [3600, 'Last hour'], [21600, 'Last 6 hours'], [86400, 'Last day'], [604800, 'Last week']].map(function (o) { return el('option', { value: o[0], text: o[1], selected: prefs.age === o[0] }); }));
    return el('div', { class: 'mapbar' }, [chk('rep', 'Repeaters'), chk('people', 'People'), chk('other', 'Rooms and sensors'), age, UI.btn('Fit all', { kind: 'small', onclick: fit }),
      UI.btn('', { icon: 'plus', kind: 'small', title: 'Zoom in', onclick: function () { zoomAt(1, w / 2, h / 2); } }), UI.btn('', { icon: 'x', kind: 'small', title: 'Zoom out', onclick: function () { zoomAt(-1, w / 2, h / 2); } })]);
  }

  function mount(b) {
    box = b; box.style.flexDirection = 'column';
    tilesEl = el('div', { class: 'tiles' }); markersEl = el('div', { class: 'markers' }); popup = el('div', { class: 'mappop card', hidden: true });
    view = el('div', { class: 'mapview', tabindex: 0, role: 'application', 'aria-label': 'Map of nodes' }, [tilesEl, markersEl, popup,
      el('a', { class: 'attr', href: 'https://www.openstreetmap.org/copyright', target: '_blank', rel: 'noopener noreferrer', text: '© OpenStreetMap contributors' })]);
    box.appendChild(el('div', { class: 'dtop' }, [el('h1', { text: 'Map', style: 'font-size:19px' })]));
    box.appendChild(controls()); box.appendChild(view);
    // drag and pinch
    var ptrs = {}, last = null, pinch = 0;
    view.addEventListener('pointerdown', function (e) { if (e.target.closest && e.target.closest('.pin,.mappop')) return; view.setPointerCapture(e.pointerId); ptrs[e.pointerId] = { x: e.clientX, y: e.clientY }; last = { x: e.clientX, y: e.clientY }; popup.hidden = true; });
    view.addEventListener('pointermove', function (e) {
      if (!ptrs[e.pointerId]) return; ptrs[e.pointerId] = { x: e.clientX, y: e.clientY };
      var ids = Object.keys(ptrs);
      if (ids.length === 2) {
        var d = Math.hypot(ptrs[ids[0]].x - ptrs[ids[1]].x, ptrs[ids[0]].y - ptrs[ids[1]].y);
        if (pinch && Math.abs(d - pinch) > 40) { var r = view.getBoundingClientRect(); zoomAt(d > pinch ? 1 : -1, (ptrs[ids[0]].x + ptrs[ids[1]].x) / 2 - r.left, (ptrs[ids[0]].y + ptrs[ids[1]].y) / 2 - r.top); pinch = d; } else if (!pinch) pinch = d;
        return;
      }
      var c = project(prefs.lat, prefs.lon, prefs.z), g = unproject(c.x - (e.clientX - last.x), c.y - (e.clientY - last.y), prefs.z); last = { x: e.clientX, y: e.clientY }; setView(g.lat, g.lon, prefs.z);
    });
    function up(e) { delete ptrs[e.pointerId]; pinch = 0; }
    view.addEventListener('pointerup', up); view.addEventListener('pointercancel', up);
    view.addEventListener('wheel', function (e) { e.preventDefault(); var r = view.getBoundingClientRect(); zoomAt(e.deltaY < 0 ? 1 : -1, e.clientX - r.left, e.clientY - r.top); }, { passive: false });
    view.addEventListener('dblclick', function (e) { var r = view.getBoundingClientRect(); zoomAt(1, e.clientX - r.left, e.clientY - r.top); });
    view.addEventListener('keydown', function (e) {
      var c = project(prefs.lat, prefs.lon, prefs.z), s = 80, d = { ArrowLeft: [-s, 0], ArrowRight: [s, 0], ArrowUp: [0, -s], ArrowDown: [0, s] }[e.key];
      if (d) { e.preventDefault(); var g = unproject(c.x + d[0], c.y + d[1], prefs.z); setView(g.lat, g.lon, prefs.z); } else if (e.key === '+' || e.key === '=') zoomAt(1, w / 2, h / 2); else if (e.key === '-') zoomAt(-1, w / 2, h / 2);
    });
    window.addEventListener('resize', function () { if (App.current() && App.current().id === 'map') render(); });
    ['contacts', 'self'].forEach(function (ev) { W.bus.on(ev, function () { if (App.current() && App.current().id === 'map') render(); }); });
  }
  function show() { setTimeout(function () { render(); if (!prefs.fitted && points().length) fit(); }, 30); }

  App.register({ id: 'map', title: 'Map', icon: 'map', mount: mount, show: show });
})(window);
