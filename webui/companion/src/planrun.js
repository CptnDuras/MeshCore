// One planner run, from a request to a result, with no DOM: the device page runs it in the browser, the planner service runs it in a Lambda.
// req: { sites: [site], p: radio params (see v-plan.js params()), repeater: site template, reachKm (0 = from the signal budget), count, link (new sites
//        must reach the plan), view: {north, south, west, east}, nodes: [{lat, lon, name}] }
// A site is { lat, lon, h, dbm, gain, cable, name }. fetchTile(z, x, y) -> Promise<Float32Array(65536) | null>.
(function (root) {
  'use strict';
  var G = typeof module !== 'undefined' && module.exports ? require('./geo.js') : root.Geo;

  async function run(req, fetchTile, onProgress, opts) {
    opts = opts || {};
    var p = Object.assign({}, req.p), sites = req.sites, count = req.count | 0, vb = req.view, say = onProgress || function () {};
    var reachKm = +req.reachKm > 0 ? Math.min(300, +req.reachKm) : G.reachKm(req.repeater, p), rangeDeg = reachKm / 111;
    p.rangeM = reachKm * 1000;
    var pts = sites.map(function (s) { return { lat: s.lat, lon: s.lon }; });
    if (count) pts.push({ lat: vb.north, lon: vb.west }, { lat: vb.south, lon: vb.east });
    if (!pts.length) throw new Error('Add a site first');
    var la = pts.map(function (q) { return q.lat; }), lo = pts.map(function (q) { return q.lon; }), mid = (Math.min.apply(0, la) + Math.max.apply(0, la)) / 2;
    var bbox = { south: Math.min.apply(0, la) - rangeDeg, north: Math.max.apply(0, la) + rangeDeg, west: Math.min.apply(0, lo) - rangeDeg / Math.cos(mid * Math.PI / 180), east: Math.max.apply(0, lo) + rangeDeg / Math.cos(mid * Math.PI / 180) };
    say('Loading terrain…', 0);
    var dem = await G.loadDem(bbox, fetchTile, { maxTiles: opts.maxTiles, maxZoom: opts.maxZoom, minZoom: opts.minZoom, parallel: opts.parallel,
      onProgress: function (a, b) { say('Loading terrain… ' + a + ' of ' + b + ' tiles', a / b); } });
    var live = 0, total = 0; for (var i = 0; i < dem.data.length; i += 997) { total++; if (dem.data[i] === dem.data[i]) live++; }
    if (live < total * 0.5) throw new Error('No terrain data came back for that area.');
    var cp = Math.max(1, Math.round((opts.cellM || 120) / G.mPerPx(mid, dem.z))), grid = G.makeGrid(dem, cp);
    var nodes = req.nodes || [];
    var res = await G.plan({ dem: dem, grid: grid, p: p, existing: sites, count: count, area: vb, requireLink: req.link, nodes: nodes, repeater: req.repeater,
      maxCandidates: opts.maxCandidates, onProgress: function (t, f) { say(t, f); } });
    var cov = 0; for (var k = 0; k < res.covered.length; k++) cov += res.covered[k];
    var inside = [], outside = [];
    nodes.forEach(function (n) { var c = G.cellOf(grid, n.lat, n.lon); if (c < 0) return; (res.margin[c] >= p.fade ? inside : outside).push(n.name || ''); });
    return { dem: dem, grid: grid, p: p, mid: mid, reachKm: reachKm, resM: grid.cp * G.mPerPx(mid, dem.z), covKm2: cov * G.cellKm2(grid, mid), margin: res.margin, picks: res.picks,
      heard: { inside: inside, outside: outside } };
  }

  // The link between two sites: our model's margin and profile, and the MeshCore app's own line-of-sight verdict for the same pair.
  async function link(req, fetchTile, opts) {
    opts = opts || {};
    var a = req.a, b = req.b, p = req.p, pad = 0.02;
    var bbox = { south: Math.min(a.lat, b.lat) - pad, north: Math.max(a.lat, b.lat) + pad, west: Math.min(a.lon, b.lon) - pad, east: Math.max(a.lon, b.lon) + pad };
    var dem = await G.loadDem(bbox, fetchTile, { maxTiles: opts.maxTiles || 400, maxZoom: opts.maxZoom || 13, minZoom: opts.minZoom, parallel: opts.parallel });
    var pr = G.linkMargin(dem, a, b, p);
    if (!pr) throw new Error('No terrain data came back for that link.');
    return { profile: pr, app: G.appLineOfSight(dem, a, b, p), demZoom: dem.z };
  }

  // ---- over the wire ----
  // margins as one signed byte each (-128 = not covered), cell lists as unsigned 32-bit, both gzip-compressed and base64-coded.
  function gz(bytes) { return require('zlib').gzipSync(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)).toString('base64'); }
  function pack(r) {
    var m = new Int8Array(r.margin.length);
    for (var i = 0; i < m.length; i++) { var v = r.margin[i]; m[i] = v === v && v > -127 ? Math.min(127, Math.round(v)) : -128; }
    return { grid: r.grid, z: r.dem.z, p: r.p, reachKm: r.reachKm, resM: r.resM, covKm2: r.covKm2, mid: r.mid, heard: r.heard, margin: gz(m),
      picks: r.picks.map(function (q) { return { lat: q.lat, lon: q.lon, elev: q.elev, h: q.h, newKm2: q.newKm2, newNodes: q.newNodes, site: q.site, link: q.link, cells: gz(q.cells) }; }) };
  }
  async function gunzip(b64) {
    var bin = Uint8Array.from(atob(b64), function (c) { return c.charCodeAt(0); });
    var stream = new Blob([bin]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  async function unpack(w) {
    var m8 = new Int8Array((await gunzip(w.margin)).buffer), margin = new Float32Array(m8.length);
    for (var i = 0; i < m8.length; i++) margin[i] = m8[i] === -128 ? -Infinity : m8[i];
    var picks = [];
    for (var k = 0; k < w.picks.length; k++) { var q = w.picks[k], u = await gunzip(q.cells); picks.push(Object.assign({}, q, { cells: new Uint32Array(u.buffer, u.byteOffset, u.byteLength >> 2) })); }
    return { dem: null, grid: w.grid, p: w.p, mid: w.mid, reachKm: w.reachKm, resM: w.resM, covKm2: w.covKm2, margin: margin, picks: picks, heard: w.heard };
  }

  var api = { run: run, link: link, pack: pack, unpack: unpack };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Planrun = api;
})(typeof self !== 'undefined' ? self : this);
