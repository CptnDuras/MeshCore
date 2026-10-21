// Repeater planner: estimates what the repeaters you know about cover, and suggests where new ones would help most.
// Terrain comes from Mapterhorn elevation tiles (needs the internet, like the map). The model is in geo.js.
(function (root) {
  'use strict';
  var el = UI.el, W = root.W, S = W.S, G = root.Geo;

  var ENV = [['0', 'Open country'], ['6', 'Light trees or houses'], ['12', 'Suburbs'], ['18', 'Dense trees or city']];
  var DEFAULTS = {
    freq: 910.525, bw: 62.5, sf: 8, repDbm: 22, repGain: 3, repH: 10, cable: 1, cliDbm: 20, cliGain: 0, cliH: 2, env: '6', fade: 10, noise: 6, reach: 0, count: 3,
    link: true, losOnly: 'true', fresnel: '0', detail: 'normal',
    // where to look and what a new site must satisfy (distances are kept in km whatever the display units)
    area: 'view', radius: 25, centre: 'map', land: 'any', roadKm: 0, roadKind: 'roads', minLinks: 1, minLinkDb: 0
  };
  var saved = W.store.get('mcw2:plan', null) || {};
  var P = Object.assign({}, DEFAULTS, saved.p || {}), mine = saved.sites || [], off = saved.off || {}, heights = saved.heights || {};
  var rebuild, map, panel, status, resultsEl, sitesEl, adding = false, run = null, busy = false, offscreen = null, nextId = saved.nextId || 1;
  var links = [], marks = [], live = null, relayRun = null;   // links: lines drawn between sites; marks: extra map markers; live: sites can be dragged; relayRun: the last "connect two points"

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
    return { fMHz: +P.freq, sf: +P.sf, bwKHz: +P.bw, clientDbm: +P.cliDbm, clientGain: +P.cliGain, rxH: +P.cliH, clutter: +P.env, fade: +P.fade, noise: +P.noise, rangeM: 0, linkClutter: 0, losOnly: P.losOnly !== 'false', fresnel: +P.fresnel };
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

  // What one run may ask of the browser. The node's own page keeps these generous; a public page sets tighter ones (Plan.setLimits).
  // maxSites: repeaters plus planned sites in one run (0 = no limit); maxNew: suggested sites per run (0 = no limit); maxCandidates: places tried per search (0 = the engine's own).
  // maxThreads: Web Workers per run (at most 6; each holds a copy of the terrain, so a public page keeps this low).
  // capNote: what to say after "This page stops at N" when the reach was cut short.
  var limits = { maxTiles: 400, maxReachKm: 300, maxSites: 0, maxNew: 0, maxCandidates: 0, maxThreads: 6, capNote: 'the full planner on xerokuhl.com goes further.' };

  // Where the work happens. On the node's page the browser does it; the planner service replaces this with calls to its Lambda (setBackend).
  var backend = {
    // extra: { accept(site) -> Promise<bool> } is a rule a candidate site must pass (land, roads); it runs here, in the page
    run: function (req, onProgress, extra) {
      // the repeaters are spread over Web Workers (one fewer than the processors, at most 6); a long reach is capped here, the full planner has no such cap
      var threads = Math.max(2, Math.min(limits.maxThreads, (navigator.hardwareConcurrency || 4) - 1));   // each worker holds its own copy of the terrain
      return root.Planrun.run(req, fetchTile, onProgress, { maxTiles: limits.maxTiles, maxReachKm: limits.maxReachKm, maxCandidates: limits.maxCandidates || undefined,
        makePool: root.PoolWeb ? root.PoolWeb.make(threads) : null, accept: extra && extra.accept });
    },
    link: function (req) { return root.Planrun.link(req, fetchTile); },
    relays: function (req, onProgress, extra) { return root.Planrun.relays(req, fetchTile, onProgress, { maxTiles: 400, accept: extra && extra.accept }); }
  };

  // ---- drawing ----
  function paint() {
    if (!run) offscreen = null;
    else {
      var g = run.grid, c = document.createElement('canvas'); c.width = g.cols; c.height = g.rows;
      var ctx = c.getContext('2d'), img = ctx.createImageData(g.cols, g.rows), d = img.data, m = run.margin, f = +P.fade;
      var put = function (i, r, gr, b, a) { d[i * 4] = r; d[i * 4 + 1] = gr; d[i * 4 + 2] = b; d[i * 4 + 3] = a; };
      for (var i = 0; i < m.length; i++) {
        if (m[i] >= f + 10) put(i, 46, 170, 80, 120); else if (m[i] >= f) put(i, 140, 190, 40, 120); else if (m[i] >= 0) put(i, 230, 150, 30, 70);
      }
      if (!live) run.picks.forEach(function (p) { for (var j = 0; j < p.cells.length; j++) put(p.cells[j], 40, 110, 230, 135); });   // while sites are being moved, one colour map is the truth
      ctx.putImageData(img, 0, 0); offscreen = c;
    }
    drawOverlay();
  }
  // coverage picture, the search circle, and the lines between sites that can reach each other, each with its margin in dB
  function circleSpec() {
    if (P.area !== 'radius' || backend.remote) return null;
    var c = searchCentre(); return c && { lat: c.lat, lon: c.lon, km: +P.radius };
  }
  function drawOverlay() {
    var circ = circleSpec();
    if (!offscreen && !circ && !links.length) { map.setOverlay(null); return; }
    map.setOverlay(function (g2, w, h, api) {
      if (offscreen && run) {
        var g = run.grid, origin = api.toScreen(G.latOf(g.y0, g.z), G.lonOf(g.x0, g.z)), s = Math.pow(2, api.z - g.z) * g.cp;
        g2.imageSmoothingEnabled = false; g2.drawImage(offscreen, origin.x, origin.y, g.cols * s, g.rows * s);
      }
      if (circ) {
        var c0 = api.toScreen(circ.lat, circ.lon), c1 = api.toScreen(circ.lat + circ.km / 111, circ.lon);
        g2.save(); g2.setLineDash([8, 6]); g2.lineWidth = 2; g2.strokeStyle = 'rgba(30,60,160,.85)'; g2.beginPath(); g2.arc(c0.x, c0.y, Math.abs(c0.y - c1.y), 0, 7); g2.stroke(); g2.restore();
      }
      g2.save(); g2.font = 'bold 11px sans-serif'; g2.textAlign = 'center'; g2.textBaseline = 'middle'; g2.lineCap = 'round';
      links.forEach(function (l) {
        var a = api.toScreen(l.a.lat, l.a.lon), b = api.toScreen(l.b.lat, l.b.lon);
        var col = l.margin >= +P.fade ? '#1d8f48' : l.margin >= 0 ? '#d08a14' : '#c0392b';
        g2.lineWidth = 2.5; g2.strokeStyle = col; g2.beginPath(); g2.moveTo(a.x, a.y); g2.lineTo(b.x, b.y); g2.stroke();
        if (Math.hypot(a.x - b.x, a.y - b.y) < 46) return;
        var t = Math.round(l.margin) + ' dB', mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2, tw = g2.measureText(t).width + 8;
        g2.fillStyle = 'rgba(255,255,255,.92)'; g2.fillRect(mx - tw / 2, my - 8, tw, 16); g2.strokeStyle = col; g2.lineWidth = 1; g2.strokeRect(mx - tw / 2, my - 8, tw, 16);
        g2.fillStyle = '#1b2733'; g2.fillText(t, mx, my);
      });
      g2.restore();
    });
  }
  function markers() {
    var out = allSites().map(function (s) {
      var m = { lat: s.lat, lon: s.lon, label: s.name, color: off[s.id] ? '#8a96a3' : s.existing ? '#c77a12' : '#2a74c9', title: s.name + (s.existing ? ' (repeater)' : ' (planned)'),
        onclick: function () { siteMenu(s); } };
      if (live && !s.existing) { m.draggable = true; m.title += ' · drag to move'; m.ondrag = function (la, lo) { liveMove(s.id, la, lo, false); }; m.ondrop = function (la, lo) { liveMove(s.id, la, lo, true); }; }
      return m;
    });
    if (run) run.picks.forEach(function (p, i) {
      var m = { lat: p.lat, lon: p.lon, label: '#' + (i + 1), color: '#1a9a55', title: 'Suggested site ' + (i + 1), onclick: function () { showPick(i); } };
      if (live) { m.draggable = true; m.title += ' · drag to move'; m.ondrag = function (la, lo) { liveMove('p:' + i, la, lo, false); }; m.ondrop = function (la, lo) { liveMove('p:' + i, la, lo, true); }; }
      out.push(m);
    });
    marks.forEach(function (q) { out.push(q); });
    map.setMarkers(out);
  }
  function siteMenu(s) {
    var anchor = map.el;
    UI.menu(anchor, [
      { label: 'Details', icon: 'info', run: function () { siteDetails(s); } },
      { label: off[s.id] ? 'Use this site' : 'Leave this site out', icon: 'check', run: function () { off[s.id] = !off[s.id]; persist(); refresh(); } },
      s.existing ? null : { label: 'Remove', icon: 'x', danger: true, run: function () { mine = mine.filter(function (m) { return m.id !== s.id; }); delete off[s.id]; persist(); refresh(); } }
    ]);
  }

  // ---- running ----
  function say(t) { status.textContent = t; }
  async function go(count) {
    if (busy) return;
    var sites = active(); if (!count && !sites.length) { UI.toast('Add a site, or wait for repeaters with a position to be heard', 'bad'); return; }
    if (limits.maxSites && sites.length > limits.maxSites) { UI.toast('This planner works on up to ' + limits.maxSites + ' sites at a time; switch some off (you have ' + sites.length + ')', 'bad'); return; }
    if (limits.maxNew && count > limits.maxNew) count = limits.maxNew;
    liveStop(); links = []; marks = []; relayRun = null;
    var vb = map.bounds(), centre = count && P.area === 'radius' && !backend.remote ? searchCentre() : null;
    var req = { sites: sites.map(asSite), p: params(), repeater: { h: +P.repH, dbm: +P.repDbm, gain: +P.repGain, cable: +P.cable }, reachKm: +P.reach, detail: P.detail, count: count, link: P.link, view: vb,
      minLinks: Math.max(1, +P.minLinks || 1), minLinkDb: +P.minLinkDb || 0, within: centre ? { lat: centre.lat, lon: centre.lon, km: +P.radius } : null,
      nodes: Object.keys(S.contacts).map(function (k) { return S.contacts[k]; }).filter(function (c) { return c.type !== 2 && (c.lat || c.lon); })
        .map(function (c) { return { lat: c.lat, lon: c.lon, name: c.name }; }) };
    var rule = count ? ruleCheck() : null;
    busy = true; resultsEl.textContent = ''; say('Loading terrain…');
    try {
      var r = await backend.run(req, function (t, f) { say(t + (f ? ' · ' + Math.round(f * 100) + '%' : '')); }, rule ? { accept: rule.accept } : undefined);
      run = { grid: r.grid, margin: r.margin, picks: r.picks, p: r.p, sites: req.sites, dem: r.dem, reachKm: r.reachKm, covKm2: r.covKm2 };
      meshLinks();
      say(r.used + ' repeater' + (r.used === 1 ? '' : 's') + (r.skipped ? ' (' + r.skipped + ' too far from the map view were left out)' : '') + ' cover about ' + fmtArea(r.covKm2) + (count ? '. ' + r.picks.length + ' site' + (r.picks.length === 1 ? '' : 's') + ' suggested.' : '.') +
        ' Reach used: ' + fmtKm(r.reachKm) + (+P.reach > 0 ? '' : ' (from the signal budget)') + '.' +
        (r.capped ? ' This page stops at ' + fmtKm(r.reachKm) + (limits.capNote ? '; ' + limits.capNote : '.') : '') +
        (r.resM > 250 ? ' The area is large, so terrain is sampled every ' + fmtM(r.resM) + ' and small hills are missed. Zoom in for detail.' : '') + (rule ? ruleNote(rule) : ''));
      paint(); markers(); listPicks(); heardCheck(r.heard);
      if (count && !r.picks.length) resultsEl.appendChild(el('p', { class: 'dim', text: 'No place in view adds coverage and can reach a repeater. Move the map, lower the signal margin, or turn off "must reach a repeater".' }));
    } catch (e) { say(''); UI.toast(e.message, 'bad'); }
    busy = false;
  }

  // A check against reality: the people and rooms your node has heard that have a position, and whether the estimate says they are in reach.
  // Those the estimate misses are where it is too pessimistic (or they were heard through another repeater).
  function heardCheck(heard) {
    var inside = heard.inside, outside = heard.outside;
    if (!inside.length && !outside.length) return;
    resultsEl.appendChild(el('div', { class: 'card' }, [el('b', { text: 'Against the nodes you have heard' }),
      el('p', { text: inside.length + ' of ' + (inside.length + outside.length) + ' contacts with a position are inside the estimate.' }),
      outside.length ? el('p', { class: 'dim', text: 'Outside it: ' + outside.slice(0, 8).join(', ') + (outside.length > 8 ? ' and ' + (outside.length - 8) + ' more' : '') + '. They may have been heard through another repeater, or the estimate is too cautious there.' }) : null]));
  }

  // ---- rules a new site must satisfy: land, roads, and how many repeaters it must reach ----
  function kmIn(v) { return W.settings.units === 'imperial' ? v * 1.609344 : v; }
  function kmOut(km) { return W.settings.units === 'imperial' ? km / 1.609344 : km; }
  function unitKm() { return W.settings.units === 'imperial' ? 'mi' : 'km'; }
  function searchCentre() {
    if (P.centre && P.centre !== 'map') { var s = allSites().filter(function (x) { return x.id === P.centre; })[0]; if (s) return { lat: s.lat, lon: s.lon, name: s.name }; }
    return { lat: map.view.lat, lon: map.view.lon, name: 'the map centre' };
  }
  // The land and road rules as a function the planner asks about each candidate, best first. null when no rule is set.
  var RULE_LOOKUPS = 80;
  function ruleCheck() {
    var needLand = P.land !== 'any', needRoad = +P.roadKm > 0;
    if (backend.remote || (!needLand && !needRoad)) return null;
    var st = { looked: 0, failed: 0, limited: false, land: needLand, road: needRoad };
    st.accept = async function (site) {
      if (st.looked >= RULE_LOOKUPS) { st.limited = true; return false; }
      st.looked++;
      if (needLand) {
        var l = await root.Land.at(site.lat, site.lon);
        if (l.failed) { st.failed++; return false; }
        site.land = l;
        if (P.land === 'public' ? !root.Land.isPublic(l) : l.cls !== 'federal') return false;
      }
      if (needRoad) {
        var r = await root.Roads.nearest(site.lat, site.lon, (+P.roadKm) * 1000, P.roadKind === 'tracks');
        if (r.failed) { st.failed++; return false; }
        if (r.none) return false;
        site.road = r;
      }
      return true;
    };
    return st;
  }
  function ruleNote(st) {
    return (st.limited ? ' Stopped after checking ' + RULE_LOOKUPS + ' places against your land and road rules; loosen them or search a smaller area.' : '') +
      (st.failed ? ' ' + st.failed + ' place' + (st.failed === 1 ? '' : 's') + ' could not be checked (the land or road service did not answer) and were left out.' : '');
  }
  function roadText(r) { return r.none ? 'No public road in range' : r.failed ? 'Could not look up roads (' + r.error + ')' : fmtM(r.dist) + ' from ' + (r.name || r.ref || 'an unnamed ' + r.highway + ' road'); }
  function landTag(info) {
    return el('span', { class: 'landtag ' + (root.Land.isPublic(info) ? 'pub' : info.cls === 'private' ? 'pvt' : ''), text: info.label });
  }
  // Fills `box` with the land under a point (and the nearest road when asked), looked up when the card is shown.
  function landLine(box, site, withRoad) {
    var l = site.land ? Promise.resolve(site.land) : root.Land.at(site.lat, site.lon);
    box.appendChild(el('span', { class: 'dim', text: 'Land: looking up…' }));
    l.then(function (info) {
      site.land = info.failed ? null : info; UI.clear(box); box.appendChild(document.createTextNode('Land: ')); box.appendChild(landTag(info));
      if (!withRoad) return;
      var rd = site.road ? Promise.resolve(site.road) : +P.roadKm > 0 ? root.Roads.nearest(site.lat, site.lon, (+P.roadKm) * 1000, P.roadKind === 'tracks') : null;
      if (rd) rd.then(function (r) { if (!r.failed) site.road = r; box.appendChild(el('div', { text: 'Road: ' + roadText(r) })); });
    });
  }

  // ---- lines between sites that can reach each other, with the margin on each ----
  function netSites() {
    var out = active().map(function (s) { return { id: s.id, name: s.name, lat: s.lat, lon: s.lon, site: asSite(s) }; });
    if (run) run.picks.forEach(function (p, i) { out.push({ id: 'p:' + i, name: '#' + (i + 1), lat: p.lat, lon: p.lon, site: p.site }); });
    return out;
  }
  // onlyId: only the pairs that include that site are worked out again (a marker is being moved)
  function meshLinks(onlyId) {
    if (!run || !run.dem) { links = []; return; }
    var net = netSites(); if (net.length > 60) { links = []; return; }
    var out = onlyId ? links.filter(function (l) { return l.ia !== onlyId && l.ib !== onlyId; }) : [], reachM = Math.min(300, run.reachKm || 100) * 1000;
    for (var i = 0; i < net.length; i++) for (var j = i + 1; j < net.length; j++) {
      if (onlyId && net[i].id !== onlyId && net[j].id !== onlyId) continue;
      if (G.haversine(net[i], net[j]) > reachM) continue;
      var lm = G.linkMargin(run.dem, net[i].site, net[j].site, run.p);
      if (lm && lm.ok) out.push({ a: { lat: net[i].lat, lon: net[i].lon }, b: { lat: net[j].lat, lon: net[j].lon }, margin: lm.margin, ia: net[i].id, ib: net[j].id, na: net[i].name, nb: net[j].name, km: lm.km });
    }
    links = out;
  }

  // ---- moving sites with the coverage following ----
  function liveStart() {
    if (live) return;
    if (!run || !run.dem) { UI.toast('Estimate coverage or find sites first; moving sites needs the terrain this page has loaded', 'bad'); return; }
    if (!root.PoolWeb || !root.PoolWeb.supported()) { UI.toast('This browser cannot run the background workers moving sites needs', 'bad'); return; }
    var net = netSites();
    live = { pool: root.PoolWeb.make(2)(run.dem, run.grid, run.p), maps: {}, busy: false, pending: {}, ready: false };
    var mine0 = live;
    say('Preparing live coverage…'); markers(); paint(); setLiveButton();
    mine0.pool.maps(net.map(function (n) { return n.site; }), function (d) { say('Preparing live coverage (' + d + ' of ' + net.length + ')…'); }).then(function (maps) {
      if (live !== mine0) return;
      net.forEach(function (n, i) { mine0.maps[n.id] = maps[i]; });
      mine0.ready = true; liveCombine(); say('Drag a planned or suggested site (the dashed ones) and the coverage and links follow.');
    }).catch(function (e) { if (live === mine0) { UI.toast(e.message, 'bad'); liveStop(); } });
  }
  function liveStop() {
    if (!live) return;
    live.pool.close(); live = null; markers(); paint(); setLiveButton();
  }
  function liveCombine() {
    var net = netSites(), N = run.grid.cols * run.grid.rows, best = new Float32Array(N).fill(-Infinity), f = +P.fade;
    net.forEach(function (n) {
      var m = live.maps[n.id]; if (!m) return;
      for (var i = 0; i < N; i++) { var v = m[i]; if (v !== -128 && v > best[i]) best[i] = v; }
    });
    var cov = 0; for (var k = 0; k < N; k++) if (best[k] >= f) cov++;
    var g = run.grid;
    run.margin = best; run.covKm2 = cov * G.cellKm2(g, G.latOf(g.y0 + g.rows * g.cp / 2, g.z));
    paint();
    say('Moving sites: the sites cover about ' + fmtArea(run.covKm2) + ' and ' + links.length + ' link' + (links.length === 1 ? '' : 's') + ' between them reach each other.');
  }
  function setSitePos(id, lat, lon) {
    if (id.slice(0, 2) === 'p:') { var p = run.picks[+id.slice(2)]; p.lat = lat; p.lon = lon; p.site.lat = lat; p.site.lon = lon; p.site.land = null; p.site.road = null; return; }
    mine.forEach(function (m) { if (m.id === id) { m.lat = lat; m.lon = lon; } });
  }
  function liveMove(id, lat, lon, final) {
    if (!live) return;
    setSitePos(id, lat, lon);
    if (final) { persist(); refresh(); listPicks(); }
    if (!live.ready) return;
    live.pending[id] = 1;
    if (!live.busy) liveWork();
  }
  async function liveWork() {
    var me = live; me.busy = true;
    try {
      while (live === me && Object.keys(me.pending).length) {
        var id = Object.keys(me.pending)[0]; delete me.pending[id];
        var n = netSites().filter(function (x) { return x.id === id; })[0]; if (!n) continue;
        var m = (await me.pool.maps([n.site]))[0];
        if (live !== me) return;
        me.maps[id] = m; meshLinks(id); liveCombine();
      }
    } catch (e) { if (live === me) UI.toast(e.message, 'bad'); }
    me.busy = false;
  }
  var liveBtn;
  function setLiveButton() { if (liveBtn) { liveBtn.classList.toggle('primary', !!live); liveBtn.lastChild.textContent = live ? 'Stop moving sites' : 'Move sites'; } }

  function listPicks() {
    UI.clear(resultsEl);
    if (!run || !run.picks.length) return;
    resultsEl.appendChild(el('h3', { text: 'Suggested sites' }));
    run.picks.forEach(function (p, i) {
      var lines = [p.lat.toFixed(5) + ', ' + p.lon.toFixed(5) + ' · ground ' + fmtM(p.elev), 'Adds about ' + fmtArea(p.newKm2) + (p.newNodes ? ' and ' + p.newNodes + ' known node' + (p.newNodes === 1 ? '' : 's') : '')];
      if (p.link) {
        var all = (p.link.all || [{ with: p.link.with, margin: p.link.margin, km: p.link.km }]).slice(0, 4);
        lines.push('Reaches ' + all.map(function (l) { return (l.with.name || 'a site') + ' (' + fmtKm(l.km) + ', ' + Math.round(l.margin) + ' dB)'; }).join(', ') + (p.link.all && p.link.all.length > 4 ? ' and ' + (p.link.all.length - 4) + ' more' : ''));
      }
      var landBox = el('div', { class: 'landline' });
      if (!backend.remote) landLine(landBox, p.site, true);
      resultsEl.appendChild(el('div', { class: 'pick card' }, [
        el('div', { class: 'ph' }, [el('b', { text: '#' + (i + 1) }), el('span', { class: 'dim', text: lines[0] })]),
        el('div', {}, lines.slice(1).map(function (t) { return el('div', { text: t }); })), landBox,
        el('div', { class: 'btnrow' }, [
          UI.btn('Show', { kind: 'small', onclick: function () { showPick(i); } }),
          UI.btn('Add to my sites', { kind: 'small', onclick: function () { addSite(p.lat, p.lon, 'Site ' + nextId); UI.toast('Added'); } }),
          p.link ? UI.btn('Path', { kind: 'small', onclick: function () { profile(p.site, p.link.with); } }) : null,
          UI.btn('Copy', { kind: 'small', onclick: function () { UI.copy(p.lat.toFixed(6) + ', ' + p.lon.toFixed(6)); } })])]));
    });
  }
  // ---- sites that join two points ----
  function fit(pts) {
    var la = pts.map(function (q) { return q.lat; }), lo = pts.map(function (q) { return q.lon; }), W0 = map.el.clientWidth || 600, H0 = map.el.clientHeight || 400, z = 16;
    var n = Math.max.apply(0, la), s = Math.min.apply(0, la), e = Math.max.apply(0, lo), w = Math.min.apply(0, lo);
    for (; z > 3; z--) { var a = root.Slippy.project(n, w, z), b = root.Slippy.project(s, e, z); if (b.x - a.x < W0 * 0.75 && b.y - a.y < H0 * 0.75) break; }
    map.setView((n + s) / 2, (e + w) / 2, z);
  }
  function parseLatLon(t) {
    var m = String(t).trim().match(/^([-+]?\d+(?:\.\d+)?)\s*[, ;]\s*([-+]?\d+(?:\.\d+)?)$/);
    return m && num(+m[1], -90, 90) && num(+m[2], -180, 180) ? { lat: +m[1], lon: +m[2] } : null;
  }
  function connectPoints() {
    if (backend.remote || !backend.relays) { UI.toast('Connecting two points runs on the node\'s page', 'bad'); return; }
    var list = active(), opts = [{ value: '', label: 'Type coordinates below' }].concat(list.map(function (s) { return { value: s.id, label: s.name }; }));
    UI.form('Connect two points', [
      { name: 'a', label: 'From', options: opts, value: opts[1] ? opts[1].value : '' }, { name: 'ac', label: '… or coordinates (latitude, longitude)', placeholder: '33.4484, -112.0740' },
      { name: 'b', label: 'To', options: opts, value: opts[2] ? opts[2].value : '' }, { name: 'bc', label: '… or coordinates (latitude, longitude)', placeholder: '34.5, -111.2' },
      { name: 'corridor', label: 'Relays may be up to this far from the straight line (' + unitKm() + ')', type: 'number', min: 1, max: 100, step: 'any', value: Math.round(kmOut(+P.corridor || 10) * 10) / 10 },
      { name: 'n', label: 'How many options to find', type: 'number', min: 1, max: 10, value: 3 },
      { name: 'hops', label: 'Relays in a row', options: [{ value: 1, label: 'One' }, { value: 2, label: 'One, or two if one cannot do it' }], value: 2 },
      { name: 'min', label: 'Each hop must have at least this many dB to spare', type: 'number', min: 0, max: 40, step: 'any', value: P.fade }],
      'Find relays', 'Looks for places along the way that can hear both ends. Land and road rules from the settings apply.').then(function (v) {
      if (!v) return;
      var end = function (id, coords, label) {
        if (coords.trim()) { var c = parseLatLon(coords); if (!c) throw new Error('Could not read the ' + label + ' coordinates; use "latitude, longitude".'); return { lat: c.lat, lon: c.lon, h: +P.repH, dbm: +P.repDbm, gain: +P.repGain, cable: +P.cable, name: label === 'first' ? 'Point A' : 'Point B' }; }
        var s = list.filter(function (x) { return x.id === id; })[0]; if (!s) throw new Error('Choose the ' + label + ' point or type its coordinates.');
        return asSite(s);
      };
      try { findRelays(end(v.a, v.ac, 'first'), end(v.b, v.bc, 'second'), { corridorKm: kmIn(parseFloat(v.corridor) || 10), count: +v.n || 3, hops: +v.hops || 1, minMargin: parseFloat(v.min) }); }
      catch (e) { UI.toast(e.message, 'bad'); connectPoints(); }
    });
  }
  async function findRelays(a, b, o) {
    if (busy) return;
    liveStop(); busy = true; links = []; marks = []; relayRun = null; P.corridor = o.corridorKm; persist();
    var rule = ruleCheck(); resultsEl.textContent = ''; say('Loading terrain…');
    try {
      var r = await backend.relays({ a: a, b: b, p: params(), repeater: { h: +P.repH, dbm: +P.repDbm, gain: +P.repGain, cable: +P.cable }, count: o.count, hops: o.hops, corridorKm: o.corridorKm, minMargin: o.minMargin },
        function (t, f) { say(t + (f ? ' · ' + Math.round(f * 100) + '%' : '')); }, rule ? { accept: rule.accept } : undefined);
      relayRun = { a: a, b: b, res: r };
      run = null; offscreen = null;
      say((r.relays.length ? r.relays.length + ' way' + (r.relays.length === 1 ? '' : 's') + ' to join the two points found, out of ' + r.tried + ' places tried.' : 'No place joins the two points with that much margin (' + r.tried + ' places tried).') + (rule ? ruleNote(rule) : ''));
      listRelays(); showRelay(0);
    } catch (e) { say(''); UI.toast(e.message, 'bad'); }
    busy = false;
  }
  function listRelays() {
    UI.clear(resultsEl); var rr = relayRun; if (!rr) return;
    var d = rr.res.direct;
    resultsEl.appendChild(el('h3', { text: rr.a.name + ' to ' + rr.b.name }));
    resultsEl.appendChild(el('p', { class: 'dim', text: d ? (d.ok ? 'They can reach each other directly: ' + fmtKm(d.km) + ', ' + Math.round(d.margin) + ' dB to spare.' : 'They cannot reach each other directly (' + fmtKm(d.km) + (d.clear ? '' : ', the line of sight is blocked') + ').') : 'No terrain for a direct check.' }));
    if (!rr.res.relays.length) resultsEl.appendChild(el('p', { class: 'dim', text: 'Try a wider strip, two relays in a row, a lower margin, taller masts, or fewer land and road rules.' }));
    rr.res.relays.forEach(function (o, i) {
      var landBox = el('div', { class: 'landline' });
      resultsEl.appendChild(el('div', { class: 'pick card' }, [
        el('div', { class: 'ph' }, [el('b', { text: 'Option ' + (i + 1) }), el('span', { class: 'dim', text: (o.chain.length === 1 ? 'one relay' : 'two relays') + ' · weakest hop ' + Math.round(o.min) + ' dB to spare' })]),
        el('div', {}, o.legs.map(function (l) { return el('div', { text: l.from + ' to ' + l.to + ': ' + fmtKm(l.km) + ', ' + Math.round(l.margin) + ' dB' }); })),
        el('div', {}, o.chain.map(function (q, k) { return el('div', { class: 'dim', text: 'Relay ' + (k + 1) + ': ' + q.lat.toFixed(5) + ', ' + q.lon.toFixed(5) + ' · ground ' + fmtM(q.elev) }); })), landBox,
        el('div', { class: 'btnrow' }, [UI.btn('Show', { kind: 'small', onclick: function () { showRelay(i); } }),
          UI.btn('Add to my sites', { kind: 'small', onclick: function () { o.chain.forEach(function (q, k) { addSite(q.lat, q.lon, 'Relay ' + (i + 1) + (o.chain.length > 1 ? String.fromCharCode(97 + k) : '')); }); UI.toast('Added'); } }),
          UI.btn('Copy', { kind: 'small', onclick: function () { UI.copy(o.chain.map(function (q) { return q.lat.toFixed(6) + ', ' + q.lon.toFixed(6); }).join('\n')); } })])]));
      if (!backend.remote) landLine(landBox, o.chain[0].site, true);
    });
  }
  function showRelay(i) {
    var rr = relayRun; if (!rr) return;
    var o = rr.res.relays[i], pts = [rr.a, rr.b];
    marks = [{ lat: rr.a.lat, lon: rr.a.lon, label: rr.a.name, color: '#6a3fb5', title: rr.a.name }, { lat: rr.b.lat, lon: rr.b.lon, label: rr.b.name, color: '#6a3fb5', title: rr.b.name }];
    links = [];
    if (o) {
      var seq = [rr.a].concat(o.chain).concat([rr.b]);
      o.chain.forEach(function (q, k) { pts.push(q); marks.push({ lat: q.lat, lon: q.lon, label: 'R' + (k + 1), color: '#1a9a55', title: 'Relay ' + (k + 1) }); });
      o.legs.forEach(function (l, k) { links.push({ a: { lat: seq[k].lat, lon: seq[k].lon }, b: { lat: seq[k + 1].lat, lon: seq[k + 1].lon }, margin: l.margin }); });
    } else if (rr.res.direct) links.push({ a: { lat: rr.a.lat, lon: rr.a.lon }, b: { lat: rr.b.lat, lon: rr.b.lon }, margin: rr.res.direct.margin });
    fit(pts); markers(); drawOverlay();
  }
  function showPick(i) { var p = run.picks[i]; map.setView(p.lat, p.lon, Math.max(map.view.z, 11)); }

  function addSite(lat, lon, name) {
    mine.push({ id: 'm:' + nextId++, name: name || 'Site ' + nextId, lat: lat, lon: lon, h: +P.repH }); persist(); refresh();
  }

  // ---- coordinates typed or pasted in, and the details of a site ----
  // One site per line: "lat, lon", "name, lat, lon" or "name, lat, lon, height". Commas, semicolons, tabs or spaces separate the
  // values; a first line of column titles, blank lines and lines starting with # are skipped.
  function parseCoordLines(text) {
    var out = [];
    text.split(/\r?\n/).forEach(function (raw, i) {
      var line = raw.trim(); if (!line || line[0] === '#') return;
      var parts = line.indexOf(',') >= 0 || line.indexOf(';') >= 0 || line.indexOf('\t') >= 0 ? line.split(/[,;\t]/) : line.split(/\s+/);
      parts = parts.map(function (t) { return t.trim().replace(/^"|"$/g, ''); });
      var n = parts.map(parseFloat), k = isFinite(n[0]) && /^[-+]?\d/.test(parts[0]) ? 0 : 1;   // a name comes first when the first value is not a number
      var lat = n[k], lon = n[k + 1], h = n[k + 2];
      if (!out.length && /lat/i.test(line) && !isFinite(lat)) return;   // column titles
      if (!num(lat, -90, 90) || !num(lon, -180, 180)) throw new Error('Line ' + (i + 1) + ': expected a latitude (-90 to 90) and a longitude (-180 to 180).');
      out.push({ name: (k ? parts[0] : '').slice(0, 40) || 'Site ' + (out.length + 1), lat: lat, lon: lon, h: num(h, 1, 100) ? h : null,
        use: parts[k + 3] !== 'false', repeater: parts[k + 4] === 'true' });   // the last two columns are what exportCsv writes
    });
    if (!out.length) throw new Error('No coordinates found. Use one site per line, like: Hilltop, 33.4484, -112.0740, 12');
    if (out.length > 200) throw new Error('Too many sites (more than 200).');
    return out;
  }
  function addByCoordinates() {
    UI.form('Add sites by coordinates', [{ name: 'text', label: 'Coordinates', type: 'textarea', rows: 7, placeholder: 'Hilltop, 33.4484, -112.0740\n33.5, -112.1\nName, lat, lon, antenna height (m)',
      hint: 'One site per line: latitude, longitude, with a name in front and a height after if you like.' }], 'Add').then(function (v) {
      if (!v) return;
      try {
        var sites = parseCoordLines(v.text);
        sites.forEach(function (s) { mine.push({ id: 'm:' + nextId++, name: s.name, lat: s.lat, lon: s.lon, h: s.h || +P.repH }); });
        persist(); refresh(); map.setView(sites[0].lat, sites[0].lon, Math.max(map.view.z, 10));
        UI.toast('Added ' + sites.length + ' site' + (sites.length === 1 ? '' : 's'));
      } catch (e) { UI.toast(e.message, 'bad'); addByCoordinates(); }
    });
  }
  function csvCell(t) { t = String(t); return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; }
  function exportCsv() {
    var rows = [['name', 'lat', 'lon', 'height_m', 'use', 'repeater']].concat(allSites().map(function (s) {
      return [s.name, s.lat.toFixed(6), s.lon.toFixed(6), +siteH(s), !off[s.id], !!s.existing]; }));
    UI.download('meshcore-sites-' + stamp() + '.csv', rows.map(function (r) { return r.map(csvCell).join(','); }).join('\n') + '\n', 'text/csv');
    UI.toast('Saved ' + (rows.length - 1) + ' site' + (rows.length === 2 ? '' : 's'));
  }
  function dms(v, pos, neg) {
    var a = Math.abs(v), d = Math.floor(a), m = Math.floor((a - d) * 60), s = ((a - d) * 60 - m) * 60;
    return d + '° ' + m + '′ ' + s.toFixed(1) + '″ ' + (v >= 0 ? pos : neg);
  }
  function siteDetails(s) {
    var planned = mine.filter(function (m) { return m.id === s.id; })[0];
    var rows = [['Position', s.lat.toFixed(6) + ', ' + s.lon.toFixed(6)], ['Degrees', dms(s.lat, 'N', 'S') + '  ' + dms(s.lon, 'E', 'W')],
      ['Antenna height', fmtM(+siteH(s)) + ' above ground'], ['In the plan', off[s.id] ? 'Left out' : 'Used']];
    if (s.existing) {
      var c = S.contacts[s.id.slice(2)];
      if (c) rows.push(['Public key', c.key.slice(0, 16) + '…'], ['Last heard', UI.ago(c.lastAdvert)], ['Route', c.pathLen === 255 ? 'Flood (no stored path)' : c.pathLen === 0 ? 'Direct' : (c.pathLen & 63) + ' hop' + ((c.pathLen & 63) === 1 ? '' : 's')]);
    } else rows.push(['Source', 'Planned site']);
    var landBox = el('div', { class: 'landline' });
    if (!backend.remote) landLine(landBox, { lat: s.lat, lon: s.lon }, true);
    var body = el('div', {}, [el('dl', { class: 'kv' }, rows.reduce(function (a, r) { a.push(el('dt', { text: r[0] }), el('dd', { text: r[1] })); return a; }, [])), landBox,
      backend.remote ? null : el('p', { class: 'dim', text: 'Land comes from the BLM\'s Surface Management Agency data (United States). It shows who manages the land, not parcel owners: ask the owner before you build.' }),
      s.existing ? el('p', { class: 'dim', text: 'The position comes from the repeater\'s own advert. To try a different spot, add a planned site.' }) : null]);
    var btns = [{ label: 'Copy position', value: 'copy' }, { label: 'Show on map', value: 'map' }];
    if (planned) btns.push({ label: 'Edit', value: 'edit' });
    btns.push({ label: 'Close', kind: 'primary', value: null });
    UI.dialog(s.name, body, btns).then(function (r) {
      if (r === 'copy') UI.copy(s.lat.toFixed(6) + ', ' + s.lon.toFixed(6));
      else if (r === 'map') map.setView(s.lat, s.lon, Math.max(map.view.z, 12));
      else if (r === 'edit') editSite(planned);
    });
  }
  function editSite(m) {
    UI.form('Edit ' + m.name, [{ name: 'name', label: 'Name', value: m.name, maxlength: 40, required: true },
      { name: 'lat', label: 'Latitude', type: 'number', step: 'any', min: -90, max: 90, value: m.lat },
      { name: 'lon', label: 'Longitude', type: 'number', step: 'any', min: -180, max: 180, value: m.lon },
      { name: 'h', label: 'Antenna height above ground (m)', type: 'number', min: 1, max: 100, step: 'any', value: m.h }], 'Save').then(function (v) {
      if (!v) return;
      var lat = parseFloat(v.lat), lon = parseFloat(v.lon), h = parseFloat(v.h);
      if (!num(lat, -90, 90) || !num(lon, -180, 180) || !num(h, 1, 100)) { UI.toast('Check the latitude, longitude and height', 'bad'); editSite(m); return; }
      m.name = v.name.trim().slice(0, 40) || m.name; m.lat = lat; m.lon = lon; m.h = h; persist(); refresh();
    });
  }

  // ---- plan file (JSON) and picture (PNG) ----
  var FILE_APP = 'meshcore-planner';
  function stamp() { return new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-'); }
  function planFile() {
    var v = map.view;
    return { app: FILE_APP, version: 1, saved: new Date().toISOString(), params: P, view: { lat: +v.lat.toFixed(5), lon: +v.lon.toFixed(5), z: v.z },
      sites: allSites().map(function (s) { return { name: s.name, lat: s.lat, lon: s.lon, height: +siteH(s), use: !off[s.id], repeater: !!s.existing }; }) };
  }
  function exportPlan() {
    var f = planFile(); UI.download('meshcore-plan-' + stamp() + '.json', JSON.stringify(f, null, 2), 'application/json');
    UI.toast('Saved ' + f.sites.length + ' site' + (f.sites.length === 1 ? '' : 's'));
  }
  function num(x, lo, hi) { return typeof x === 'number' && isFinite(x) && x >= lo && x <= hi; }
  // Checks a plan file and returns what it holds, or throws a sentence the person can read.
  function parseGpx(text) {
    var doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) throw new Error('That file is not a valid GPX file.');
    var pts = Array.prototype.slice.call(doc.getElementsByTagName('wpt'));
    if (!pts.length) throw new Error('That GPX file has no waypoints.');
    if (pts.length > 200) throw new Error('That GPX file has too many waypoints (more than 200).');
    return { params: {}, view: null, sites: pts.map(function (w, i) {
      var lat = parseFloat(w.getAttribute('lat')), lon = parseFloat(w.getAttribute('lon')), n = w.getElementsByTagName('name')[0];
      if (!num(lat, -90, 90) || !num(lon, -180, 180)) throw new Error('Waypoint ' + (i + 1) + ' has no valid position.');
      return { name: ((n && n.textContent) || 'Site ' + (i + 1)).trim().slice(0, 40), lat: lat, lon: lon, h: null, use: true, repeater: false };
    }) };
  }
  function parsePlan(text) {
    if (/^\s*</.test(text)) return parseGpx(text);
    if (!/^\s*[{[]/.test(text)) return { sites: parseCoordLines(text), params: {}, view: null };   // a CSV or text list of coordinates
    var f; try { f = JSON.parse(text); } catch (e) { throw new Error('That file is not a plan (it is not valid JSON).'); }
    if (!f || f.app !== FILE_APP || !Array.isArray(f.sites)) throw new Error('That file is not a planner file.');
    if (f.sites.length > 200) throw new Error('That plan has too many sites (more than 200).');
    var sites = f.sites.map(function (s, i) {
      if (!s || !num(s.lat, -90, 90) || !num(s.lon, -180, 180)) throw new Error('Site ' + (i + 1) + ' has no valid position.');
      return { name: String(s.name || 'Site').slice(0, 40), lat: s.lat, lon: s.lon, h: num(s.height, 1, 100) ? s.height : null, use: s.use !== false, repeater: !!s.repeater };
    });
    var p = {}; Object.keys(DEFAULTS).forEach(function (k) {
      var v = f.params && f.params[k]; if (typeof v === typeof DEFAULTS[k] && (typeof v !== 'number' || isFinite(v))) p[k] = v;
    });
    if (f.params && typeof f.params.env === 'string' && ENV.some(function (e) { return e[0] === f.params.env; })) p.env = f.params.env;
    return { sites: sites, params: p, view: f.view && num(f.view.lat, -85, 85) && num(f.view.lon, -180, 180) && num(f.view.z, 2, 17) ? f.view : null };
  }
  function applyPlan(plan) {
    var heard = existing();
    Object.assign(P, plan.params);
    mine = []; var matched = 0, added = 0;
    plan.sites.forEach(function (s) {
      var hit = s.repeater ? heard.filter(function (h) { return Math.abs(h.lat - s.lat) < 0.001 && Math.abs(h.lon - s.lon) < 0.001; })[0] : null;
      if (hit) { matched++; off[hit.id] = !s.use; if (s.h) heights[hit.id] = s.h; return; }
      var id = 'm:' + nextId++; mine.push({ id: id, name: s.name, lat: s.lat, lon: s.lon, h: s.h || +P.repH }); off[id] = !s.use; added++;
    });
    run = null; persist(); paint(); rebuild(); refresh(); listPicks();
    if (plan.view) map.setView(plan.view.lat, plan.view.lon, plan.view.z);
    else if (plan.sites.length) map.setView(plan.sites[0].lat, plan.sites[0].lon, Math.max(map.view.z, 10));
    UI.toast('Loaded ' + added + ' planned site' + (added === 1 ? '' : 's') + (matched ? ' and settings for ' + matched + ' repeater' + (matched === 1 ? '' : 's') + ' you can hear' : ''));
  }
  function importPlan() {
    var inp = el('input', { type: 'file', accept: 'application/json,.json,application/gpx+xml,.gpx,text/csv,.csv,text/plain,.txt', style: 'display:none' });
    inp.onchange = function () {
      var file = inp.files && inp.files[0]; inp.remove(); if (!file) return;
      if (file.size > 1000000) { UI.toast('That file is too large to be a plan', 'bad'); return; }
      file.text().then(function (text) {
        var plan = parsePlan(text);
        var go2 = function () { applyPlan(plan); };
        if (mine.length) UI.confirm('Load plan', 'This replaces your ' + mine.length + ' planned site' + (mine.length === 1 ? '' : 's') + ' and the radio settings with the file\'s. Export first if you want to keep them.', 'Load', true).then(function (ok) { if (ok) go2(); });
        else go2();
      }).catch(function (e) { UI.toast(e.message, 'bad'); });
    };
    document.body.appendChild(inp); inp.click();
  }
  // The plan travels in the address fragment, which the browser never sends to a server.
  var FULL_PLANNER = 'https://xerokuhl.com/planner/';
  function openFull() {
    var json = JSON.stringify(planFile()), b64 = btoa(unescape(encodeURIComponent(json))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    window.open(FULL_PLANNER + '#plan=' + b64, '_blank', 'noopener');
  }
  function exportPng() {
    var rows = ['Repeater coverage estimate · ' + new Date().toLocaleString(),
      P.freq + ' MHz · BW ' + P.bw + ' kHz · SF' + P.sf + ' · repeaters ' + P.repDbm + ' dBm, ' + P.repGain + ' dBi, ' + P.repH + ' m · handhelds ' + P.cliDbm + ' dBm, ' + P.cliH + ' m · ' + P.fade + ' dB margin'];
    var legend = [['rgba(46,170,80,.7)', 'strong'], ['rgba(140,190,40,.7)', 'usable'], ['rgba(230,150,30,.6)', 'marginal']];
    if (run && run.picks.length) legend.push(['rgba(40,110,230,.7)', 'added by a suggested site']);
    var c;
    try {
      c = map.snapshot(2, function (g, w, h) {
        g.font = '12px sans-serif'; g.textBaseline = 'top';
        var bw = Math.min(w - 12, Math.max.apply(0, rows.map(function (t) { return g.measureText(t).width; })) + 16);
        g.fillStyle = 'rgba(255,255,255,.88)'; g.fillRect(6, 6, bw, 40); g.fillStyle = '#1b2733';
        g.font = 'bold 12px sans-serif'; g.fillText(rows[0], 14, 12, bw - 16); g.font = '11px sans-serif'; g.fillText(rows[1], 14, 28, bw - 16);
        if (run) {
          var lw = legend.reduce(function (a, l) { return a + g.measureText(l[1]).width + 30; }, 8);
          g.fillStyle = 'rgba(255,255,255,.88)'; g.fillRect(6, h - 56, lw, 22); var x = 14;
          legend.forEach(function (l) { g.fillStyle = l[0]; g.fillRect(x, h - 51, 12, 12); g.fillStyle = '#1b2733'; g.fillText(l[1], x + 18, h - 51); x += g.measureText(l[1]).width + 30; });
        }
        g.font = '10px sans-serif'; g.textBaseline = 'alphabetic'; var at = '© OpenStreetMap contributors · terrain: Mapterhorn', aw = g.measureText(at).width + 10;
        g.fillStyle = 'rgba(255,255,255,.85)'; g.fillRect(w - aw, h - 16, aw, 16); g.fillStyle = '#333'; g.fillText(at, w - aw + 5, h - 5);
      });
    } catch (e) { UI.toast('Could not draw the picture: ' + e.message, 'bad'); return; }
    c.toBlob(function (b) {
      if (!b) { UI.toast('The map tiles block saving a picture in this browser', 'bad'); return; }
      UI.download('meshcore-coverage-' + stamp() + '.png', b, 'image/png'); UI.toast('Saved the picture' + (run ? '' : ' (no coverage estimate yet, just the sites)'));
    }, 'image/png');
  }

  // ---- a link between two sites ----
  async function profile(a, b) {
    var out;
    try { say('Loading the path…'); out = await backend.link({ a: a, b: b, p: params() }); say(''); } catch (e) { say(''); UI.toast(e.message, 'bad'); return; }
    var pr = out.profile, app = out.app;
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
    var sight = pr.blockedBy > 0 ? 'Line of sight blocked by ' + fmtM(pr.blockedBy) + ' of ground ' + fmtKm(pr.blockedKm) + ' from ' + (a.name || 'the first site')
      : pr.nu > -0.78 ? 'Line of sight is clear, but terrain gets within the first Fresnel zone ' + Math.round(pr.blockedAt * 100) + '% of the way along' : 'Line of sight is clear';
    var verdict = !app.hasData ? 'The MeshCore app\'s check has no terrain for this path.' : app.isClear ? 'The MeshCore app\'s line-of-sight check: clear.'
      : 'The MeshCore app\'s line-of-sight check: blocked by up to ' + fmtM(app.maxObstructionM) + ', first ' + fmtKm(app.firstObstructionM / 1000) + ' from ' + (a.name || 'the first site') + '.';
    var body = el('div', {}, [cv, el('p', { text: sight + ' (earth radius factor ' + pr.k.toFixed(2) + ').' }), el('p', { text: verdict }),
      el('p', { text: fmtKm(pr.km) + ' · path loss ' + pr.loss.toFixed(0) + ' dB · ' + (pr.margin >= 0 ? Math.round(pr.margin) + ' dB to spare' : Math.round(-pr.margin) + ' dB short') }),
      el('p', { class: 'dim', text: 'Red is the straight line between the antennas, blue the zone that should stay clear, brown the ground (raised by earth curvature).' })]);
    UI.alert((a.name || 'Site') + ' to ' + (b.name || 'site'), body);
  }
  function checkLink() {
    var list = active(); if (list.length < 2) { UI.toast('Turn on at least two sites first', 'bad'); return; }
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
    // o.dist: the value is kept in km but shown in the display units; o.after runs once a change is stored
    var shown = function () { return o.dist ? Math.round(kmOut(+P[key]) * 10) / 10 : P[key]; }, done = function () { persist(); if (o.after) o.after(); };
    var inp = o.options ? el('select', { 'aria-label': label, onchange: function () { P[key] = inp.value; done(); } }, o.options.map(function (x) { return el('option', { value: x[0], text: x[1], selected: String(P[key]) === String(x[0]) }); }))
      : el('input', { type: 'number', step: o.step || 'any', min: o.min, max: o.max, value: shown(), 'aria-label': label, onchange: function () { var v = parseFloat(inp.value); if (isFinite(v) && (!o.dist || v >= 0)) { P[key] = o.dist ? kmIn(v) : v; done(); } else inp.value = shown(); } });
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
        UI.btn('', { icon: 'info', kind: 'ghost small', title: 'Details and coordinates of ' + s.name, onclick: function () { siteDetails(s); } }),
        s.existing ? null : UI.btn('', { icon: 'x', kind: 'ghost small', title: 'Remove', onclick: function () { mine = mine.filter(function (m) { return m.id !== s.id; }); delete off[s.id]; persist(); refresh(); } })]));
    });
    markers(); fillRules();
  }

  // The rules card: where to look, what a new site must be near, and how well connected it must be.
  var rulesEl;
  var rulesSig = '';
  function fillRules(force) {
    if (!rulesEl) return;
    var centres = [['map', 'The centre of the map']].concat(allSites().map(function (s) { return [s.id, s.name]; })), local = !backend.remote;
    var sig = centres.map(function (c) { return c[0] + c[1]; }).join('|') + P.area + W.settings.units + P.minLinks;
    if (!force && sig === rulesSig) return;   // the list of sites changes with every advert; only rebuild the card when it matters
    rulesSig = sig; UI.clear(rulesEl);
    var redraw = function () { drawOverlay(); };
    rulesEl.appendChild(el('b', { text: 'Rules for new sites' }));
    rulesEl.appendChild(el('label', { class: 'tag' }, [el('input', { type: 'checkbox', checked: P.link, onchange: function (e) { P.link = e.target.checked; persist(); } }), ' New sites must reach repeaters already in the plan']));
    rulesEl.appendChild(el('div', { class: 'pgrid' }, [
      field('Each must reach at least', 'minLinks', { options: [[1, '1 site'], [2, '2 sites (a real mesh)'], [3, '3 sites']] }),
      field('…with at least (dB to spare)', 'minLinkDb', { min: 0, max: 40 })]));
    if (!local) return;
    rulesEl.appendChild(el('div', { class: 'pgrid' }, [
      field('Look in', 'area', { options: [['view', 'The map view'], ['radius', 'A circle']], after: function () { fillRules(); redraw(); } }),
      P.area === 'radius' ? field('Radius (' + unitKm() + ')', 'radius', { min: 1, max: 300, dist: true, after: redraw }) : null,
      P.area === 'radius' ? field('Around', 'centre', { options: centres, after: redraw }) : null,
      field('Land', 'land', { options: [['any', 'Any land'], ['public', 'Public land only (federal, state, local)'], ['federal', 'Federal land only']] }),
      field('A public road within (' + unitKm() + ', 0 = don\'t care)', 'roadKm', { min: 0, max: 50, dist: true }),
      field('Roads count', 'roadKind', { options: [['roads', 'Public roads'], ['tracks', 'Public roads and tracks']] })]));
    rulesEl.appendChild(el('p', { class: 'dim', style: 'font-size:12px', text: 'Land is from US federal data and roads from OpenStreetMap, both looked up for the best places found; they are a first look, not permission or a survey.' }));
  }

  function mount(box) {
    box.classList.add('plan');
    sitesEl = el('div', { class: 'sites' }); resultsEl = el('div', { class: 'results' }); status = el('div', { class: 'dim pstatus', role: 'status', 'aria-live': 'polite' });
    var addBtn = UI.btn('Add a site', { icon: 'plus', kind: 'small', onclick: function () { adding = !adding; addBtn.classList.toggle('primary', adding); say(adding ? 'Tap the map where the site would go.' : ''); } });
    var count = el('select', { 'aria-label': 'How many sites', onchange: function () { P.count = +count.value; persist(); } }, [1, 2, 3, 4, 5, 8, 10, 15, 20].map(function (n) { return el('option', { value: n, text: n, selected: +P.count === n }); }));
    liveBtn = UI.btn('Move sites', { kind: 'small', title: 'Drag planned and suggested sites and watch the coverage and the links between sites follow', onclick: function () { if (live) liveStop(); else liveStart(); } });
    rulesEl = el('div', { class: 'card rules' });
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
        el('div', { class: 'card' }, [el('div', { class: 'ctitle' }, [el('b', { text: 'Sites' }), el('span', { class: 'btnrow' }, [
            UI.btn('All', { kind: 'small', title: 'Use every site', onclick: function () { allSites().forEach(function (s) { delete off[s.id]; }); persist(); refresh(); } }),
            UI.btn('None', { kind: 'small', title: 'Leave every site out', onclick: function () { allSites().forEach(function (s) { off[s.id] = true; }); persist(); refresh(); } }), addBtn])]), sitesEl,
          el('div', { class: 'btnrow' }, [UI.btn('Export plan', { icon: 'download', kind: 'small', title: 'Save the sites and radio settings as a JSON file', onclick: exportPlan }),
            UI.btn('Import plan', { kind: 'small', title: 'Load sites and settings from a plan file (JSON), a GPX file, or a CSV/text list of coordinates', onclick: importPlan }),
            UI.btn('Add by coordinates', { kind: 'small', title: 'Type or paste latitude and longitude, one site per line', onclick: addByCoordinates }),
            UI.btn('Export CSV', { icon: 'download', kind: 'small', title: 'Save the sites as a CSV: name, lat, lon, height', onclick: exportCsv }),
            UI.btn('Save map picture', { icon: 'download', kind: 'small', title: 'Save the map with the coverage as a PNG', onclick: exportPng }),
            backend.remote ? null : UI.btn('Open in the full planner', { kind: 'small', title: 'xerokuhl.com: finer terrain, bigger areas and more candidate sites, worked out on a server (needs a login)', onclick: openFull })])]),
        el('div', { class: 'card' }, [el('b', { text: 'Radio' }), el('div', { class: 'pgrid' }, [
          field('Frequency (MHz)', 'freq'), field('Bandwidth (kHz)', 'bw', { options: [[7.8, '7.8'], [10.4, '10.4'], [15.6, '15.6'], [20.8, '20.8'], [31.25, '31.25'], [41.7, '41.7'], [62.5, '62.5'], [125, '125'], [250, '250'], [500, '500']] }),
          field('Spreading factor', 'sf', { options: [5, 6, 7, 8, 9, 10, 11, 12].map(function (n) { return [n, 'SF' + n]; }) }),
          field('Required margin (dB)', 'fade', { min: 0, max: 30 }), field('Noise and interference (dB)', 'noise', { min: 0, max: 30 })]), fromNode]),
        el('div', { class: 'card' }, [el('b', { text: 'What counts as covered' }), el('div', { class: 'pgrid' }, [
          field('Path', 'losOnly', { options: [['true', 'Clear line of sight (like the MeshCore app)'], ['false', 'Also paths over a ridge (diffraction)']] }),
          field('Clearance', 'fresnel', { options: [['0', 'Ground below the straight line'], ['0.6', '60% of the Fresnel zone clear']] }),
          backend.remote ? field('Detail', 'detail', { options: [['normal', 'Normal (100 m cells)'], ['high', 'High (60 m cells, more candidate sites)']] }) : null]),
          el('p', { class: 'dim', style: 'font-size:12px', text: 'The MeshCore app checks whether the straight line between two antennas clears the ground, allowing for the earth\'s curve. This does the same for every point around each repeater, and also requires the signal to be strong enough.' })]),
        el('div', { class: 'card' }, [el('b', { text: 'Repeater antennas' }), el('div', { class: 'pgrid' }, [
          field('Power (dBm)', 'repDbm', { min: 0, max: 30 }), field('Antenna gain (dBi)', 'repGain', { min: -5, max: 20 }), field('Height (m)', 'repH', { min: 1, max: 100 }), field('Cable loss (dB)', 'cable', { min: 0, max: 10 })])]),
        el('div', { class: 'card' }, [el('b', { text: 'Handheld radios and surroundings' }), el('div', { class: 'pgrid' }, [
          field('Power (dBm)', 'cliDbm', { min: 0, max: 30 }), field('Antenna gain (dBi)', 'cliGain', { min: -5, max: 10 }), field('Height (m)', 'cliH', { min: 0.5, max: 20 }),
          field('Surroundings', 'env', { options: ENV }), field('Longest reach (km, 0 = from the signal)', 'reach', { min: 0, max: 300 })])]),
        el('div', { class: 'btnrow' }, [UI.btn('Estimate coverage', { kind: 'primary', onclick: function () { go(0); } }),
          UI.btn('Find sites', { onclick: function () { go(+count.value); } }), el('label', { class: 'pf inline' }, [el('span', { text: 'up to' }), count]),
          UI.btn('Check a link', { onclick: checkLink }), backend.remote ? null : UI.btn('Connect two points', { title: 'Find relay sites that join two points along the map', onclick: connectPoints }), backend.remote ? null : liveBtn]),
        rulesEl,
        status, resultsEl,
        el('div', { class: 'legend' }, [el('i', { style: 'background:rgba(46,170,80,.6)' }), ' strong ', el('i', { style: 'background:rgba(140,190,40,.6)' }), ' usable ', el('i', { style: 'background:rgba(230,150,30,.45)' }), ' marginal ',
          el('i', { style: 'background:rgba(40,110,230,.6)' }), ' added by a suggested site']),
        el('p', { class: 'dim', style: 'font-size:12px' }, [document.createTextNode('Terrain: '), el('a', { href: 'https://mapterhorn.com/attribution', target: '_blank', rel: 'noopener noreferrer', text: 'Mapterhorn' }),
          document.createTextNode('. Coverage means a handheld at the height above is heard both ways. Suggestions are the high points of the map view; buildings, trees and land access are not known.')])]));
    }
    rebuild = build; build(); fillRules();
    var first = existing()[0] || (S.self && (S.self.lat || S.self.lon) ? S.self : null), mp = W.store.get('mcw2:map', null);
    map = Slippy.create({ lat: first ? first.lat : mp ? mp.lat : 39, lon: first ? first.lon : mp ? mp.lon : -98, z: first || mp ? 10 : 4, label: 'Planner map',
      onClick: function (lat, lon) { if (adding) { adding = false; say(''); addSite(lat, lon, 'Site ' + nextId); } } });
    box.appendChild(panel); box.appendChild(map.el);
    W.bus.on('contacts', function () { if (App.current() && App.current().id === 'plan') refresh(); });
    refresh();
  }
  function show() { setTimeout(function () { map.redraw(); refresh(); }, 30); }

  root.Plan = { run: function (n) { return go(n); }, load: function (text) { applyPlan(parsePlan(text)); }, setBackend: function (b) { backend = b; }, setLimits: function (l) { Object.assign(limits, l); }, file: planFile, parse: parsePlan, apply: applyPlan, state: function () { return { run: run, P: P, mine: mine, links: links, live: !!live, relay: relayRun, centre: searchCentre() }; } };
  App.register({ id: 'plan', title: 'Planner', icon: 'antenna', mount: mount, show: show });
})(window);
