// Repeater planner: estimates what the repeaters you know about cover, and suggests where new ones would help most.
// Terrain comes from Mapterhorn elevation tiles (needs the internet, like the map). The model is in geo.js.
(function (root) {
  'use strict';
  var el = UI.el, W = root.W, S = W.S, G = root.Geo;

  var ENV = [['0', 'Open country'], ['6', 'Light trees or houses'], ['12', 'Suburbs'], ['18', 'Dense trees or city']];
  var DEFAULTS = {
    freq: 910.525, bw: 62.5, sf: 8, repDbm: 22, repGain: 3, repH: 10, cable: 1, cliDbm: 20, cliGain: 0, cliH: 2, env: '6', fade: 10, range: 15, count: 3,
    link: true
  };
  var saved = W.store.get('mcw2:plan', null) || {};
  var P = Object.assign({}, DEFAULTS, saved.p || {}), mine = saved.sites || [], off = saved.off || {}, heights = saved.heights || {};
  var map, panel, status, resultsEl, sitesEl, adding = false, run = null, busy = false, offscreen = null, nextId = saved.nextId || 1;

  function persist() { W.store.set('mcw2:plan', { p: P, sites: mine, off: off, heights: heights, nextId: nextId }); }

  function existing() {
    return Object.keys(S.contacts).map(function (k) { return S.contacts[k]; }).filter(function (c) { return c.type === 2 && (c.lat || c.lon); })
      .map(function (c) { return { id: 'r:' + c.key, name: c.name, lat: c.lat, lon: c.lon, existing: true }; });
  }
  function allSites() { return existing().concat(mine.map(function (s) { return Object.assign({ existing: false }, s); })); }
  function siteH(s) { return s.existing ? (heights[s.id] || P.repH) : (s.h || P.repH); }
  function asSite(s) { return { lat: s.lat, lon: s.lon, h: +siteH(s), dbm: +P.repDbm, gain: +P.repGain, cable: +P.cable, name: s.name }; }
  function active() { return allSites().filter(function (s) { return !off[s.id]; }); }
  function params() {
    return { fMHz: +P.freq, sf: +P.sf, bwKHz: +P.bw, clientDbm: +P.cliDbm, clientGain: +P.cliGain, rxH: +P.cliH, clutter: +P.env, fade: +P.fade, rangeM: +P.range * 1000, linkClutter: 0 };
  }
  function fmtKm(km) { return W.settings.units === 'imperial' ? (km / 1.609344).toFixed(1) + ' mi' : km.toFixed(1) + ' km'; }
  function fmtArea(km2) { return W.settings.units === 'imperial' ? (km2 / 2.58999).toFixed(0) + ' sq mi' : km2.toFixed(0) + ' km²'; }
  function fmtM(m) { return W.settings.units === 'imperial' ? Math.round(m * 3.28084) + ' ft' : Math.round(m) + ' m'; }

  // ---- terrain tiles ----
  // Mapterhorn serves 512-pixel Terrarium tiles; the planner's 256-pixel tile (z, x, y) is one quarter of tile (z-1, x/2, y/2).
  var big = {}, bigOrder = [];
  function bigTile(z, x, y) {
    var key = z + '/' + x + '/' + y;
    if (!big[key]) {
      big[key] = new Promise(function (resolve) {
        var im = new Image(); im.crossOrigin = 'anonymous';
        im.onload = function () {
          try {
            var c = document.createElement('canvas'); c.width = im.width; c.height = im.height;
            var g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(im, 0, 0);
            var px = g.getImageData(0, 0, im.width, im.height).data, out = new Float32Array(im.width * im.height);
            for (var i = 0; i < out.length; i++) out[i] = G.terrariumHeight(px[i * 4], px[i * 4 + 1], px[i * 4 + 2]);
            resolve({ w: im.width, data: out });
          } catch (e) { resolve(null); }
        };
        im.onerror = function () { resolve(null); };
        im.src = 'https://tiles.mapterhorn.com/' + z + '/' + x + '/' + y + '.webp';
      });
      bigOrder.push(key); if (bigOrder.length > 60) delete big[bigOrder.shift()];
    }
    return big[key];
  }
  async function fetchTile(z, x, y) {
    var t = await bigTile(Math.max(0, z - 1), x >> 1, y >> 1); if (!t) return null;
    var scale = t.w / 512, out = new Float32Array(65536), ox = (x & 1) * 256 * scale, oy = (y & 1) * 256 * scale;
    for (var j = 0; j < 256; j++) for (var i = 0; i < 256; i++) out[j * 256 + i] = t.data[Math.floor(oy + j * scale) * t.w + Math.floor(ox + i * scale)];
    return out;
  }

  // ---- drawing ----
  function paint() {
    if (!run) { offscreen = null; map.setOverlay(null); return; }
    var g = run.grid, c = document.createElement('canvas'); c.width = g.cols; c.height = g.rows;
    var ctx = c.getContext('2d'), img = ctx.createImageData(g.cols, g.rows), d = img.data, m = run.margin, f = +P.fade;
    function put(i, r, gr, b, a) { d[i * 4] = r; d[i * 4 + 1] = gr; d[i * 4 + 2] = b; d[i * 4 + 3] = a; }
    for (var i = 0; i < m.length; i++) {
      if (m[i] >= f + 10) put(i, 46, 170, 80, 120); else if (m[i] >= f) put(i, 140, 190, 40, 120); else if (m[i] >= 0) put(i, 230, 150, 30, 70);
    }
    run.picks.forEach(function (p) { for (var j = 0; j < p.cells.length; j++) put(p.cells[j], 40, 110, 230, 135); });
    ctx.putImageData(img, 0, 0); offscreen = c;
    map.setOverlay(function (g2, w, h, api) {
      var origin = api.toScreen(G.latOf(g.y0, g.z), G.lonOf(g.x0, g.z)), s = Math.pow(2, api.z - g.z) * g.cp;
      g2.imageSmoothingEnabled = false; g2.drawImage(offscreen, origin.x, origin.y, g.cols * s, g.rows * s);
    });
  }
  function markers() {
    var out = allSites().map(function (s) {
      return { lat: s.lat, lon: s.lon, label: s.name, color: off[s.id] ? '#8a96a3' : s.existing ? '#c77a12' : '#2a74c9', title: s.name + (s.existing ? ' (repeater)' : ' (planned)'),
        onclick: function () { siteMenu(s); } };
    });
    if (run) run.picks.forEach(function (p, i) { out.push({ lat: p.lat, lon: p.lon, label: '#' + (i + 1), color: '#1a9a55', title: 'Suggested site ' + (i + 1), onclick: function () { showPick(i); } }); });
    map.setMarkers(out);
  }
  function siteMenu(s) {
    var anchor = map.el;
    UI.menu(anchor, [
      { label: off[s.id] ? 'Use this site' : 'Leave this site out', icon: 'check', run: function () { off[s.id] = !off[s.id]; persist(); refresh(); } },
      s.existing ? null : { label: 'Remove', icon: 'x', danger: true, run: function () { mine = mine.filter(function (m) { return m.id !== s.id; }); delete off[s.id]; persist(); refresh(); } }
    ]);
  }

  // ---- running ----
  function say(t) { status.textContent = t; }
  async function go(count) {
    if (busy) return;
    var sites = active(); if (!count && !sites.length) { UI.toast('Add a site, or wait for repeaters with a position to be heard', 'bad'); return; }
    var p = params(), rangeDeg = P.range / 111, vb = map.bounds(), bbox;
    var pts = sites.map(function (s) { return { lat: s.lat, lon: s.lon }; });
    if (count) pts.push({ lat: vb.north, lon: vb.west }, { lat: vb.south, lon: vb.east });
    var la = pts.map(function (q) { return q.lat; }), lo = pts.map(function (q) { return q.lon; }), mid = (Math.min.apply(0, la) + Math.max.apply(0, la)) / 2;
    bbox = { south: Math.min.apply(0, la) - rangeDeg, north: Math.max.apply(0, la) + rangeDeg, west: Math.min.apply(0, lo) - rangeDeg / Math.cos(mid * Math.PI / 180), east: Math.max.apply(0, lo) + rangeDeg / Math.cos(mid * Math.PI / 180) };
    busy = true; resultsEl.textContent = ''; say('Loading terrain…');
    try {
      var dem = await G.loadDem(bbox, fetchTile, { onProgress: function (a, b) { say('Loading terrain… ' + a + ' of ' + b + ' tiles'); } });
      if (dem.z < 10) throw new Error('That area is too large. Zoom in, or lower the range.');
      var live = 0, total = 0; for (var i = 0; i < dem.data.length; i += 997) { total++; if (dem.data[i] === dem.data[i]) live++; }
      if (live < total * 0.5) throw new Error('No terrain data came back. The planner needs the internet for it.');
      var cp = Math.max(1, Math.round(120 / G.mPerPx(mid, dem.z))), grid = G.makeGrid(dem, cp);
      var res = await G.plan({ dem: dem, grid: grid, p: p, existing: sites.map(asSite), count: count, area: vb, requireLink: P.link,
        nodes: Object.keys(S.contacts).map(function (k) { return S.contacts[k]; }).filter(function (c) { return c.type !== 2 && (c.lat || c.lon); }),
        repeater: { h: +P.repH, dbm: +P.repDbm, gain: +P.repGain, cable: +P.cable }, onProgress: function (t, f) { say(t + ' · ' + Math.round(f * 100) + '%'); } });
      run = { grid: grid, dem: dem, margin: res.margin, picks: res.picks, p: p, sites: sites.map(asSite) };
      var cov = 0; for (var k = 0; k < res.covered.length; k++) cov += res.covered[k];
      say('Existing repeaters cover about ' + fmtArea(cov * G.cellKm2(grid, mid)) + (count ? '. ' + res.picks.length + ' site' + (res.picks.length === 1 ? '' : 's') + ' suggested.' : '.'));
      paint(); markers(); listPicks();
      if (count && !res.picks.length) resultsEl.appendChild(el('p', { class: 'dim', text: 'No place in view adds coverage and can reach a repeater. Move the map, lower the signal margin, or turn off "must reach a repeater".' }));
    } catch (e) { say(''); UI.toast(e.message, 'bad'); }
    busy = false;
  }

  function listPicks() {
    UI.clear(resultsEl);
    if (!run || !run.picks.length) return;
    resultsEl.appendChild(el('h3', { text: 'Suggested sites' }));
    run.picks.forEach(function (p, i) {
      var lines = [p.lat.toFixed(5) + ', ' + p.lon.toFixed(5) + ' · ground ' + fmtM(p.elev), 'Adds about ' + fmtArea(p.newKm2) + (p.newNodes ? ' and ' + p.newNodes + ' known node' + (p.newNodes === 1 ? '' : 's') : '')];
      if (p.link) lines.push('Reaches ' + p.link.with.name + ' (' + fmtKm(p.link.km) + ', ' + Math.round(p.link.margin) + ' dB to spare)');
      resultsEl.appendChild(el('div', { class: 'pick card' }, [
        el('div', { class: 'ph' }, [el('b', { text: '#' + (i + 1) }), el('span', { class: 'dim', text: lines[0] })]),
        el('div', {}, lines.slice(1).map(function (t) { return el('div', { text: t }); })),
        el('div', { class: 'btnrow' }, [
          UI.btn('Show', { kind: 'small', onclick: function () { showPick(i); } }),
          UI.btn('Add to my sites', { kind: 'small', onclick: function () { addSite(p.lat, p.lon, 'Site ' + nextId); UI.toast('Added'); } }),
          p.link ? UI.btn('Path', { kind: 'small', onclick: function () { profile(p.site, p.link.with); } }) : null,
          UI.btn('Copy', { kind: 'small', onclick: function () { UI.copy(p.lat.toFixed(6) + ', ' + p.lon.toFixed(6)); } })])]));
    });
  }
  function showPick(i) { var p = run.picks[i]; map.setView(p.lat, p.lon, Math.max(map.view.z, 11)); }

  function addSite(lat, lon, name) {
    mine.push({ id: 'm:' + nextId++, name: name || 'Site ' + nextId, lat: lat, lon: lon, h: +P.repH }); persist(); refresh();
  }

  // ---- a link between two sites ----
  function profile(a, b) {
    if (!run) return;
    var pr = G.linkMargin(run.dem, a, b, run.p);
    if (!pr) { UI.toast('No terrain data under that path', 'bad'); return; }
    var cv = el('canvas', { width: 600, height: 250, style: 'width:100%;max-width:600px;border:1px solid var(--line);border-radius:8px;background:var(--panel2)' }), g = cv.getContext('2d');
    var lo = Infinity, hi = -Infinity;
    pr.ground.forEach(function (v, i) { lo = Math.min(lo, v); hi = Math.max(hi, v, pr.los[i] + pr.fresnel[i]); });
    lo -= 20; hi += 20;
    var X = function (d) { return 10 + d / pr.dist[pr.dist.length - 1] * 580; }, Y = function (h) { return 235 - (h - lo) / (hi - lo) * 220; };
    g.fillStyle = 'rgba(70,140,230,.18)'; g.beginPath();
    pr.dist.forEach(function (d, i) { g[i ? 'lineTo' : 'moveTo'](X(d), Y(pr.los[i] + pr.fresnel[i])); });
    for (var i = pr.dist.length - 1; i >= 0; i--) g.lineTo(X(pr.dist[i]), Y(pr.los[i] - pr.fresnel[i]));
    g.fill();
    g.fillStyle = '#8b7355'; g.beginPath(); g.moveTo(X(0), 240);
    pr.dist.forEach(function (d, i) { g.lineTo(X(d), Y(pr.ground[i])); });
    g.lineTo(X(pr.dist[pr.dist.length - 1]), 240); g.closePath(); g.fill();
    g.strokeStyle = '#d6342a'; g.lineWidth = 1.5; g.beginPath(); pr.dist.forEach(function (d, i) { g[i ? 'lineTo' : 'moveTo'](X(d), Y(pr.los[i])); }); g.stroke();
    var body = el('div', {}, [cv, el('p', { text: fmtKm(pr.km) + ' · path loss ' + pr.loss.toFixed(0) + ' dB · ' + (pr.margin >= 0 ? Math.round(pr.margin) + ' dB to spare' : Math.round(-pr.margin) + ' dB short') +
      (pr.nu > -0.78 ? ' · terrain gets within the first Fresnel zone ' + Math.round(pr.blockedAt * 100) + '% of the way along' : ' · clear line of sight') }),
      el('p', { class: 'dim', text: 'Red is the straight line between the antennas, blue the zone that should stay clear, brown the ground (raised by earth curvature).' })]);
    UI.alert((a.name || 'Site') + ' to ' + (b.name || 'site'), body);
  }
  function checkLink() {
    var list = active(); if (list.length < 2) { UI.toast('Turn on at least two sites first', 'bad'); return; }
    if (!run) { UI.toast('Estimate coverage first so there is terrain loaded', 'bad'); return; }
    var opts = list.map(function (s) { return { value: s.id, label: s.name }; });
    UI.form('Check a link', [{ name: 'a', label: 'From', options: opts, value: opts[0].value }, { name: 'b', label: 'To', options: opts, value: opts[1].value }], 'Show').then(function (v) {
      if (!v || v.a === v.b) return;
      var a = list.filter(function (s) { return s.id === v.a; })[0], b = list.filter(function (s) { return s.id === v.b; })[0];
      var A = asSite(a), B = asSite(b); profile(A, B);
    });
  }

  // ---- the panel ----
  function field(label, key, o) {
    o = o || {};
    var inp = o.options ? el('select', { 'aria-label': label, onchange: function () { P[key] = inp.value; persist(); } }, o.options.map(function (x) { return el('option', { value: x[0], text: x[1], selected: String(P[key]) === String(x[0]) }); }))
      : el('input', { type: 'number', step: o.step || 'any', min: o.min, max: o.max, value: P[key], 'aria-label': label, onchange: function () { var v = parseFloat(inp.value); if (isFinite(v)) { P[key] = v; persist(); } else inp.value = P[key]; } });
    return el('label', { class: 'pf' }, [el('span', { text: label }), inp]);
  }
  function refresh() {
    UI.clear(sitesEl);
    var list = allSites();
    if (!list.length) sitesEl.appendChild(el('p', { class: 'dim', text: 'No repeaters with a position have been heard yet. Add a site by tapping "Add a site", then the map.' }));
    list.forEach(function (s) {
      var cb = el('input', { type: 'checkbox', checked: !off[s.id], 'aria-label': 'Use ' + s.name, onchange: function () { off[s.id] = !cb.checked; persist(); markers(); } });
      var h = el('input', { type: 'number', min: 1, max: 100, value: siteH(s), title: 'Antenna height above ground', 'aria-label': 'Height of ' + s.name, class: 'hin', onchange: function () {
        var v = parseFloat(h.value); if (!isFinite(v) || v < 1) { h.value = siteH(s); return; }
        if (s.existing) heights[s.id] = v; else mine.forEach(function (m) { if (m.id === s.id) m.h = v; }); persist(); } });
      sitesEl.appendChild(el('div', { class: 'siterow' }, [cb, el('button', { type: 'button', class: 'nm', onclick: function () { map.setView(s.lat, s.lon, Math.max(map.view.z, 11)); }, title: 'Show on the map' },
        [el('b', { text: s.name }), el('small', { text: s.existing ? 'Repeater you can hear' : 'Planned' })]), h, el('small', { class: 'dim', text: 'm' }),
        s.existing ? null : UI.btn('', { icon: 'x', kind: 'ghost small', title: 'Remove', onclick: function () { mine = mine.filter(function (m) { return m.id !== s.id; }); delete off[s.id]; persist(); refresh(); } })]));
    });
    markers();
  }

  function mount(box) {
    box.classList.add('plan');
    sitesEl = el('div', { class: 'sites' }); resultsEl = el('div', { class: 'results' }); status = el('div', { class: 'dim pstatus', role: 'status', 'aria-live': 'polite' });
    var addBtn = UI.btn('Add a site', { icon: 'plus', kind: 'small', onclick: function () { adding = !adding; addBtn.classList.toggle('primary', adding); say(adding ? 'Tap the map where the site would go.' : ''); } });
    var count = el('select', { 'aria-label': 'How many sites', onchange: function () { P.count = +count.value; persist(); } }, [1, 2, 3, 4, 5].map(function (n) { return el('option', { value: n, text: n, selected: +P.count === n }); }));
    var fromNode = UI.btn('Use my node\'s radio settings', { kind: 'small', onclick: function () {
      if (!S.self) { UI.toast('Not connected to the node', 'bad'); return; }
      P.freq = S.self.freqMHz; P.bw = S.self.bwKHz; P.sf = S.self.sf; if (S.self.txPower) P.cliDbm = S.self.txPower; persist(); build();
    } });
    panel = el('div', { class: 'planpanel' });
    function build() {
      UI.clear(panel);
      panel.appendChild(el('div', { class: 'dtop' }, [el('h1', { text: 'Repeater planner', style: 'font-size:19px' })]));
      panel.appendChild(el('div', { class: 'pbody' }, [
        el('p', { class: 'dim', text: 'Shows where your repeaters should be heard and where a new one would add the most coverage. It is an estimate from terrain and a radio model; check a site on the ground before you build.' }),
        el('div', { class: 'card' }, [el('div', { class: 'ctitle' }, [el('b', { text: 'Sites' }), addBtn]), sitesEl]),
        el('div', { class: 'card' }, [el('b', { text: 'Radio' }), el('div', { class: 'pgrid' }, [
          field('Frequency (MHz)', 'freq'), field('Bandwidth (kHz)', 'bw', { options: [[7.8, '7.8'], [10.4, '10.4'], [15.6, '15.6'], [20.8, '20.8'], [31.25, '31.25'], [41.7, '41.7'], [62.5, '62.5'], [125, '125'], [250, '250'], [500, '500']] }),
          field('Spreading factor', 'sf', { options: [5, 6, 7, 8, 9, 10, 11, 12].map(function (n) { return [n, 'SF' + n]; }) }),
          field('Required margin (dB)', 'fade', { min: 0, max: 30 })]), fromNode]),
        el('div', { class: 'card' }, [el('b', { text: 'Repeater antennas' }), el('div', { class: 'pgrid' }, [
          field('Power (dBm)', 'repDbm', { min: 0, max: 30 }), field('Antenna gain (dBi)', 'repGain', { min: -5, max: 20 }), field('Height (m)', 'repH', { min: 1, max: 100 }), field('Cable loss (dB)', 'cable', { min: 0, max: 10 })])]),
        el('div', { class: 'card' }, [el('b', { text: 'Handheld radios and surroundings' }), el('div', { class: 'pgrid' }, [
          field('Power (dBm)', 'cliDbm', { min: 0, max: 30 }), field('Antenna gain (dBi)', 'cliGain', { min: -5, max: 10 }), field('Height (m)', 'cliH', { min: 0.5, max: 20 }),
          field('Surroundings', 'env', { options: ENV }), field('Range (km)', 'range', { min: 2, max: 40 })])]),
        el('div', { class: 'btnrow' }, [UI.btn('Estimate coverage', { kind: 'primary', onclick: function () { go(0); } }),
          UI.btn('Find sites', { onclick: function () { go(+count.value); } }), el('label', { class: 'pf inline' }, [el('span', { text: 'up to' }), count]),
          UI.btn('Check a link', { onclick: checkLink })]),
        el('label', { class: 'tag' }, [el('input', { type: 'checkbox', checked: P.link, onchange: function (e) { P.link = e.target.checked; persist(); } }), ' New sites must reach a repeater already in the plan']),
        status, resultsEl,
        el('div', { class: 'legend' }, [el('i', { style: 'background:rgba(46,170,80,.6)' }), ' strong ', el('i', { style: 'background:rgba(140,190,40,.6)' }), ' usable ', el('i', { style: 'background:rgba(230,150,30,.45)' }), ' marginal ',
          el('i', { style: 'background:rgba(40,110,230,.6)' }), ' added by a suggested site']),
        el('p', { class: 'dim', style: 'font-size:12px' }, [document.createTextNode('Terrain: '), el('a', { href: 'https://mapterhorn.com/attribution', target: '_blank', rel: 'noopener noreferrer', text: 'Mapterhorn' }),
          document.createTextNode('. Coverage means a handheld at the height above is heard both ways. Suggestions are the high points of the map view; buildings, trees and land access are not known.')])]));
    }
    build();
    var first = existing()[0] || (S.self && (S.self.lat || S.self.lon) ? S.self : null), mp = W.store.get('mcw2:map', null);
    map = Slippy.create({ lat: first ? first.lat : mp ? mp.lat : 39, lon: first ? first.lon : mp ? mp.lon : -98, z: first || mp ? 10 : 4, label: 'Planner map',
      onClick: function (lat, lon) { if (adding) { adding = false; say(''); addSite(lat, lon, 'Site ' + nextId); } } });
    box.appendChild(panel); box.appendChild(map.el);
    W.bus.on('contacts', function () { if (App.current() && App.current().id === 'plan') refresh(); });
    refresh();
  }
  function show() { setTimeout(function () { map.redraw(); refresh(); }, 30); }

  root.Plan = { run: function (n) { return go(n); }, state: function () { return { run: run, P: P, mine: mine }; } };
  App.register({ id: 'plan', title: 'Planner', icon: 'antenna', mount: mount, show: show });
})(window);
