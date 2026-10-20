// Terrain and radio planning engine for the repeater planner. Pure functions: no DOM, so it runs in a browser and under node.
//
// Terrain comes as a DEM, a grid of ground heights in Web Mercator pixels at one zoom level. The radio model is an estimate:
// free-space loss, plus knife-edge diffraction over the most obstructing ridge on the path (ITU-R P.526 approximation, earth
// radius factor 4/3), plus a flat allowance for trees and buildings. It finds where a site is likely to work and where it is
// not; it does not replace a site visit.
(function (root) {
  'use strict';
  var R_E = 6371000, T = 256;
  // Earth radius factor as the MeshCore app computes it: 4/3 at 915 MHz, nudged by 15% of the relative frequency difference, kept within 1.1 to 1.6.
  function kOf(fMHz) { var k = 4 / 3 * (1 + (fMHz - 915) / 915 * 0.15); return Math.max(1.1, Math.min(1.6, k)); }
  function kdOf(fMHz) { return 1 / (2 * kOf(fMHz) * R_E); }

  // ---- Web Mercator pixels ----
  function mercX(lon, z) { return (lon + 180) / 360 * T * Math.pow(2, z); }
  function mercY(lat, z) { var s = Math.sin(Math.max(-85.05, Math.min(85.05, lat)) * Math.PI / 180); return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * T * Math.pow(2, z); }
  function lonOf(x, z) { return x / (T * Math.pow(2, z)) * 360 - 180; }
  function latOf(y, z) { var n = Math.PI - 2 * Math.PI * y / (T * Math.pow(2, z)); return 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))); }
  function mPerPx(lat, z) { return 156543.03392 / Math.pow(2, z) * Math.cos(lat * Math.PI / 180); }
  function haversine(a, b) {
    var r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
    var q = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R_E * Math.atan2(Math.sqrt(q), Math.sqrt(1 - q));
  }

  // ---- terrain ----
  // dem: { z, x0, y0, w, h, data: Float32Array(w*h) }; pixel (i, j) holds the height at global pixel (x0 + i + 0.5, y0 + j + 0.5). NaN = no data.
  function elevPx(dem, x, y) {
    var u = x - dem.x0 - 0.5, v = y - dem.y0 - 0.5, i = Math.floor(u), j = Math.floor(v);
    if (i < 0 || j < 0 || i >= dem.w - 1 || j >= dem.h - 1) return NaN;
    var fx = u - i, fy = v - j, d = dem.data, o = j * dem.w + i;
    return (d[o] * (1 - fx) + d[o + 1] * fx) * (1 - fy) + (d[o + dem.w] * (1 - fx) + d[o + dem.w + 1] * fx) * fy;
  }
  function elevAt(dem, lat, lon) { return elevPx(dem, mercX(lon, dem.z), mercY(lat, dem.z)); }

  // Terrarium tiles encode height in metres as R*256 + G + B/256 - 32768.
  function terrariumHeight(r, g, b) { return r * 256 + g + b / 256 - 32768; }

  function tileRange(bbox, z) {
    var x0 = Math.floor(mercX(bbox.west, z) / T), x1 = Math.floor(mercX(bbox.east, z) / T);
    var y0 = Math.floor(mercY(bbox.north, z) / T), y1 = Math.floor(mercY(bbox.south, z) / T);
    return { x0: x0, x1: x1, y0: y0, y1: y1, n: (x1 - x0 + 1) * (y1 - y0 + 1) };
  }
  // Fetches the tiles that cover bbox ({south, north, west, east}) at the finest zoom (12 at most) that needs no more than maxTiles tiles.
  // fetchTile(z, x, y) -> Promise<Float32Array(256*256) | null>.
  async function loadDem(bbox, fetchTile, opts) {
    opts = opts || {};
    var maxTiles = opts.maxTiles || 120, minZoom = opts.minZoom || 7, z = opts.maxZoom || 12, r = tileRange(bbox, z);
    while (r.n > maxTiles && z > minZoom) { z--; r = tileRange(bbox, z); }
    if (r.n > maxTiles) {
      var km = Math.round(haversine({ lat: bbox.north, lon: bbox.west }, { lat: bbox.north, lon: bbox.east }) / 1000);
      throw new Error('The area is ' + km + ' km wide, more than the planner can load terrain for at once (about ' + Math.round(km * Math.sqrt(maxTiles / r.n)) + ' km). Zoom the map in, or lower the range.');
    }
    var w = (r.x1 - r.x0 + 1) * T, h = (r.y1 - r.y0 + 1) * T, dem = { z: z, x0: r.x0 * T, y0: r.y0 * T, w: w, h: h, data: opts.shared && typeof SharedArrayBuffer !== 'undefined' ? new Float32Array(new SharedArrayBuffer(w * h * 4)) : new Float32Array(w * h) };
    var jobs = [], done = 0, n = Math.pow(2, z);
    for (var ty = Math.max(0, r.y0); ty <= Math.min(n - 1, r.y1); ty++) for (var tx = r.x0; tx <= r.x1; tx++) jobs.push([tx, ty]);
    async function worker() {
      for (var job; (job = jobs.shift());) {
        var tile = await fetchTile(z, ((job[0] % n) + n) % n, job[1]), ox = (job[0] - r.x0) * T, oy = (job[1] - r.y0) * T;
        if (tile) for (var row = 0; row < T; row++) dem.data.set(tile.subarray(row * T, row * T + T), (oy + row) * w + ox);
        else for (var row2 = 0; row2 < T; row2++) dem.data.fill(NaN, (oy + row2) * w + ox, (oy + row2) * w + ox + T);
        done++; if (opts.onProgress) opts.onProgress(done, done + jobs.length);
      }
    }
    var total = jobs.length, pool = [];
    for (var k = 0; k < Math.min(opts.parallel || 6, jobs.length); k++) pool.push(worker());
    await Promise.all(pool);
    dem.tiles = total;
    return dem;
  }

  // ---- radio ----
  var SNR_LIMIT = { 5: -2.5, 6: -5, 7: -7.5, 8: -10, 9: -12.5, 10: -15, 11: -17.5, 12: -20 };
  function sensitivityDbm(sf, bwKHz, noiseFigure) {
    var snr = SNR_LIMIT[sf]; if (snr == null) snr = -10;
    return -174 + 10 * Math.log10(bwKHz * 1000) + (noiseFigure == null ? 6 : noiseFigure) + snr;
  }
  function fspl(dKm, fMHz) { return 32.45 + 20 * Math.log10(fMHz) + 20 * Math.log10(Math.max(dKm, 0.001)); }
  // single knife edge, v = clearance-based parameter (positive when the ridge is above the line of sight)
  function edgeLoss(v) { if (v <= -0.78) return 0; var t = v - 0.1; return 6.9 + 20 * Math.log10(Math.sqrt(t * t + 1) + t); }

  // p: { fMHz, sf, bwKHz, clientDbm, clientGain, rxH (client antenna height above ground, m), clutter (dB), fade (dB wanted above the limit), rangeM }
  // site: { lat, lon, h (antenna above ground, m), dbm, gain (dBi), cable (dB) }
  // The link works both ways, so the weaker transmitter sets the budget.
  function budget(site, p) {
    return Math.min(site.dbm, p.clientDbm) - (site.cable || 0) + site.gain + p.clientGain - sensitivityDbm(p.sf, p.bwKHz);
  }

  // How far a site can possibly reach, from the signal budget alone: the distance at which free-space loss uses up everything but the margin,
  // the noise allowance and the clutter. The ground only ever shortens this. Capped at 300 km.
  function reachKm(site, p) {
    var allowed = budget(site, p) - (p.noise || 0) - (p.fade || 0) - (p.clutter || 0), d = Math.pow(10, (allowed - 32.45 - 20 * Math.log10(p.fMHz)) / 20);
    return Math.max(1, Math.min(300, d));
  }

  // The grid the coverage maps are drawn on: square cells of cp DEM pixels covering the whole DEM.
  function makeGrid(dem, cp) { return { z: dem.z, x0: dem.x0, y0: dem.y0, cp: cp, cols: Math.floor(dem.w / cp), rows: Math.floor(dem.h / cp) }; }
  function cellOf(grid, lat, lon) {
    var cx = Math.floor((mercX(lon, grid.z) - grid.x0) / grid.cp), cy = Math.floor((mercY(lat, grid.z) - grid.y0) / grid.cp);
    return cx < 0 || cy < 0 || cx >= grid.cols || cy >= grid.rows ? -1 : cy * grid.cols + cx;
  }
  function cellCentre(grid, idx) {
    var cx = idx % grid.cols, cy = (idx - cx) / grid.cols, x = grid.x0 + (cx + 0.5) * grid.cp, y = grid.y0 + (cy + 0.5) * grid.cp;
    return { lat: latOf(y, grid.z), lon: lonOf(x, grid.z) };
  }
  function cellKm2(grid, lat) { var m = grid.cp * mPerPx(lat, grid.z); return m * m / 1e6; }

  // Path loss in dB from a site to every grid cell within p.rangeM, by walking outward along many directions. At each step the
  // most obstructing ground point passed so far (steepest slope seen from the antenna, earth curvature included) is the one
  // knife edge on the path. Cells never reached hold Infinity.
  // If `clear` (a Uint8Array) is given, a cell is set to 1 when a straight line from the antenna to a handheld there passes the
  // ground with room to spare: 0 m, as in the MeshCore app, or p.fresnel (0 to 1) of the first Fresnel zone radius.
  function lossMap(dem, grid, site, p, out, clear) {
    var z = dem.z, sx = mercX(site.lon, z), sy = mercY(site.lat, z), mpp = mPerPx(site.lat, z), e0 = elevPx(dem, sx, sy), KD = kdOf(p.fMHz), thr = (p.fresnel || 0) * Math.SQRT2;
    var loss = out || new Float32Array(grid.cols * grid.rows); loss.fill(Infinity);
    if (clear) clear.fill(0);
    if (isNaN(e0)) return loss;
    var hT = e0 + site.h, lam = 299.792458 / p.fMHz, step = grid.cp / 2, maxI = Math.max(1, Math.floor(p.rangeM / mpp / step));
    var nAz = Math.max(90, Math.ceil(1.5 * 2 * Math.PI * maxI * step / grid.cp)), clutter = p.clutter || 0, fc = 20 * Math.log10(p.fMHz) + 32.45;
    for (var a = 0; a < nAz; a++) {
      var ang = 2 * Math.PI * a / nAz, ux = Math.cos(ang) * step, uy = Math.sin(ang) * step, bestSlope = -Infinity, bestD = 0, bestH = 0;
      for (var i = 1; i <= maxI; i++) {
        var px = sx + ux * i, py = sy + uy * i, e = elevPx(dem, px, py);
        if (e !== e) break;
        var d = i * step * mpp, ep = e - d * d * KD, l = fc + 20 * Math.log10(d / 1000) + clutter;
        var open = true;
        if (bestD > 0) {
          var rx = ep + p.rxH, line = hT + (rx - hT) * bestD / d, v = (bestH - line) * Math.sqrt(2 * d / (lam * bestD * (d - bestD)));
          if (v > -0.78) { var t = v - 0.1; l += 6.9 + 20 * Math.log10(Math.sqrt(t * t + 1) + t); }
          open = v <= -thr;
        }
        var cx = Math.floor((px - grid.x0) / grid.cp), cy = Math.floor((py - grid.y0) / grid.cp);
        if (cx >= 0 && cy >= 0 && cx < grid.cols && cy < grid.rows) {
          var idx = cy * grid.cols + cx; if (l < loss[idx]) loss[idx] = l; if (clear && open) clear[idx] = 1;
        }
        var slope = (ep - hT) / d;
        if (slope > bestSlope) { bestSlope = slope; bestD = d; bestH = ep; }
      }
    }
    return loss;
  }

  // One link between two sites: loss from the worst obstruction along the whole path, and the profile for drawing it.
  function linkProfile(dem, a, b, p) {
    var z = dem.z, ax = mercX(a.lon, z), ay = mercY(a.lat, z), bx = mercX(b.lon, z), by = mercY(b.lat, z), KD = kdOf(p.fMHz);
    var mpp = mPerPx((a.lat + b.lat) / 2, z), D = Math.hypot(bx - ax, by - ay) * mpp, lam = 299.792458 / p.fMHz;
    var ea = elevPx(dem, ax, ay), eb = elevPx(dem, bx, by);
    if (isNaN(ea) || isNaN(eb) || D < 1) return null;
    var hA = ea + a.h, hB = eb + b.h, n = Math.max(8, Math.min(400, Math.ceil(D / mpp / 2))), maxV = -Infinity, at = 0;
    var dist = [], ground = [], los = [], fresnel = [];
    for (var i = 0; i <= n; i++) {
      var f = i / n, d = f * D, e = elevPx(dem, ax + (bx - ax) * f, ay + (by - ay) * f);
      if (e !== e) e = i ? ground[i - 1] : ea;
      var g = e + d * (D - d) * KD, ln = hA + (hB - hA) * f;
      dist.push(d); ground.push(g); los.push(ln);
      var r1 = i && i < n ? Math.sqrt(lam * d * (D - d) / D) : 0; fresnel.push(r1);
      if (i && i < n) { var v = (g - ln) * Math.sqrt(2 * D / (lam * d * (D - d))); if (v > maxV) { maxV = v; at = i; } }
    }
    var l = fspl(D / 1000, p.fMHz) + (maxV > -Infinity ? edgeLoss(maxV) : 0) + (p.linkClutter || 0), worst = 0, worstAt = 0;
    for (var q = 1; q < n; q++) { var over = ground[q] - los[q]; if (over > worst) { worst = over; worstAt = q; } }
    return { km: D / 1000, loss: l, nu: maxV, blockedAt: at / n, dist: dist, ground: ground, los: los, fresnel: fresnel,
      clear: maxV <= -(p.fresnel || 0) * Math.SQRT2, blockedBy: worst, blockedKm: dist[worstAt] / 1000, k: kOf(p.fMHz) };
  }
  // ok: the budget closes and, unless p.losOnly is false, the path is clear.
  function linkMargin(dem, a, b, p) {
    var pr = linkProfile(dem, a, b, p); if (!pr) return null;
    var pw = Math.min(a.dbm, b.dbm) - (a.cable || 0) - (b.cable || 0) + a.gain + b.gain - sensitivityDbm(p.sf, p.bwKHz) - (p.noise || 0);
    pr.margin = pw - pr.loss; pr.ok = pr.margin >= 0 && (p.losOnly === false || pr.clear); return pr;
  }

  // Margin map: dB above the limit, for one site. Cells it does not reach, and (unless p.losOnly is false) cells without a clear line
  // of sight, hold -Infinity.
  function marginMap(dem, grid, site, p, out) {
    var N = grid.cols * grid.rows, clear = p.losOnly === false ? null : new Uint8Array(N), loss = lossMap(dem, grid, site, p, out, clear), bud = budget(site, p) - (p.noise || 0);
    for (var i = 0; i < N; i++) loss[i] = clear && !clear[i] ? -Infinity : bud - loss[i];
    return loss;
  }

  // The MeshCore app's own line-of-sight check (lib/services/line_of_sight_service.dart), step for step: 21, 41 or 81 evenly spaced samples
  // along the straight line in latitude and longitude, ground raised by the earth bulge with radius 6371 km times k, and the straight line
  // between the antenna tips. A sample is blocked when the line is below the ground. Only the elevation source differs (here the DEM).
  function appLineOfSight(dem, a, b, p) {
    var D = haversine(a, b);
    if (D <= 1) return { hasData: true, isClear: true, distanceM: D, maxObstructionM: 0, firstObstructionM: null, obstructions: [], k: kOf(p.fMHz), samples: 0 };
    var n = D < 2000 ? 21 : D < 10000 ? 41 : 81, el = [], k = kOf(p.fMHz), Re = R_E * k;
    for (var i = 0; i < n; i++) {
      var t = i / (n - 1), e = elevAt(dem, a.lat + (b.lat - a.lat) * t, a.lon + (b.lon - a.lon) * t);
      if (e !== e) return { hasData: false, isClear: false, distanceM: D, k: k, error: 'No terrain data for part of the path.' };
      el.push(e);
    }
    var h0 = el[0] + a.h, h1 = el[n - 1] + b.h, maxObs = 0, first = null, obs = [], worst = null, clear = true;
    for (i = 0; i < n; i++) {
      var f = i / (n - 1), d = D * f, line = h0 + (h1 - h0) * f, bulge = d * (D - d) / (2 * Re), ground = el[i] + bulge, clearance = line - ground;
      if (clearance < 0) {
        clear = false; var o = -clearance; if (o > maxObs) maxObs = o; if (first === null) first = d;
        if (!worst || o > worst.obstructionM) worst = { distanceM: d, obstructionM: o, terrainM: ground, lineM: line, lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f };
      } else if (worst) { obs.push(worst); worst = null; }
    }
    if (worst) obs.push(worst);
    return { hasData: true, isClear: clear, distanceM: D, maxObstructionM: maxObs, firstObstructionM: first, obstructions: obs, k: k, samples: n };
  }

  // ---- finding places ----
  // Candidate sites: the high points of the search area (a cell no lower than anything within `radiusM`), thinned so that no two are
  // closer than `gapM`, highest first.
  function candidates(dem, grid, area, opts) {
    opts = opts || {};
    var mpp = mPerPx((area.south + area.north) / 2, dem.z), cellM = grid.cp * mpp, r = Math.max(1, Math.round((opts.radiusM || 1500) / cellM));
    var c0 = cellOf(grid, area.north, area.west), c1 = cellOf(grid, area.south, area.east);
    var cx0 = Math.max(0, c0 < 0 ? 0 : c0 % grid.cols), cy0 = Math.max(0, c0 < 0 ? 0 : Math.floor(c0 / grid.cols));
    var cx1 = Math.min(grid.cols - 1, c1 < 0 ? grid.cols - 1 : c1 % grid.cols), cy1 = Math.min(grid.rows - 1, c1 < 0 ? grid.rows - 1 : Math.floor(c1 / grid.cols));
    var W = grid.cols, H = grid.rows, h = new Float32Array(W * H);
    for (var cy = 0; cy < H; cy++) for (var cx = 0; cx < W; cx++) h[cy * W + cx] = elevPx(dem, grid.x0 + (cx + 0.5) * grid.cp, grid.y0 + (cy + 0.5) * grid.cp);
    var rowMax = new Float32Array(W * H), colMax = new Float32Array(W * H);
    for (cy = 0; cy < H; cy++) for (cx = 0; cx < W; cx++) { var m = -Infinity; for (var k = Math.max(0, cx - r); k <= Math.min(W - 1, cx + r); k++) { var v = h[cy * W + k]; if (v > m) m = v; } rowMax[cy * W + cx] = m; }
    for (cy = 0; cy < H; cy++) for (cx = 0; cx < W; cx++) { m = -Infinity; for (k = Math.max(0, cy - r); k <= Math.min(H - 1, cy + r); k++) { v = rowMax[k * W + cx]; if (v > m) m = v; } colMax[cy * W + cx] = m; }
    var list = [];
    for (cy = cy0; cy <= cy1; cy++) for (cx = cx0; cx <= cx1; cx++) { var i = cy * W + cx; if (h[i] === h[i] && h[i] >= colMax[i] - 1) list.push({ idx: i, elev: h[i] }); }
    list.sort(function (a, b) { return b.elev - a.elev; });
    var gapCells = Math.max(1, (opts.gapM || 1000) / cellM), out = [], cap = opts.max || 120;
    for (var q = 0; q < list.length && out.length < cap; q++) {
      var ok = true, ix = list[q].idx % W, iy = (list[q].idx - ix) / W;
      for (var o = 0; o < out.length; o++) { var ox = out[o].idx % W, oy = (out[o].idx - ox) / W; if (Math.hypot(ix - ox, iy - oy) < gapCells) { ok = false; break; } }
      if (ok) out.push(list[q]);
    }
    return out;
  }

  var tick = function () { return new Promise(function (r) { setTimeout(r, 0); }); };

  // Estimates what the existing repeaters cover, then picks `count` new sites one after another, each the one that adds the most
  // area (cells with a known node that no repeater covers yet count extra), and only where it can reach a repeater already in the plan.
  // ctx: { dem, grid, p, existing: [site], nodes: [{lat, lon}], area: bbox, count, repeater: site template, requireLink, onProgress(text, fraction) }
  async function plan(ctx) {
    var dem = ctx.dem, grid = ctx.grid, p = ctx.p, N = grid.cols * grid.rows, best = new Float32Array(N).fill(-Infinity), last = Date.now();
    async function yieldNow(text, f) { if (Date.now() - last > 40) { if (ctx.onProgress) ctx.onProgress(text, f); await tick(); last = Date.now(); } }
    var existingCovered = new Uint8Array(N), buf = new Float32Array(N);
    for (var s = 0; s < ctx.existing.length; s++) {
      marginMap(dem, grid, ctx.existing[s], p, buf);
      for (var i = 0; i < N; i++) if (buf[i] > best[i]) best[i] = buf[i];
      await yieldNow('Existing repeaters', (s + 1) / Math.max(1, ctx.existing.length) * 0.2);
    }
    for (i = 0; i < N; i++) existingCovered[i] = best[i] >= p.fade ? 1 : 0;
    var result = { margin: best, covered: existingCovered, picks: [] };
    if (!ctx.count) return result;

    var weight = new Float32Array(N).fill(1), nodeCells = {};
    (ctx.nodes || []).forEach(function (n) { var c = cellOf(grid, n.lat, n.lon); if (c >= 0) { weight[c] += 20; nodeCells[c] = (nodeCells[c] || 0) + 1; } });
    var cands = candidates(dem, grid, ctx.area, { max: ctx.maxCandidates || 120 }), tmpl = ctx.repeater;
    cands.forEach(function (c) { var pt = cellCentre(grid, c.idx); c.site = { lat: pt.lat, lon: pt.lon, h: tmpl.h, dbm: tmpl.dbm, gain: tmpl.gain, cable: tmpl.cable }; });
    if (ctx.evalCandidates) {
      // the caller has several processors: it returns, for each candidate site, the cells that site would cover
      var covers = await ctx.evalCandidates(cands.map(function (c) { return c.site; }), function (done) { if (ctx.onProgress) ctx.onProgress('Trying sites (' + done + ' of ' + cands.length + ')', 0.2 + 0.7 * done / cands.length); });
      cands.forEach(function (c, j) { c.cover = covers[j]; });
    } else for (var k = 0; k < cands.length; k++) {
      var c = cands[k]; marginMap(dem, grid, c.site, p, buf);
      var cover = []; for (i = 0; i < N; i++) if (buf[i] >= p.fade) cover.push(i);
      c.cover = Uint32Array.from(cover);
      await yieldNow('Trying sites (' + (k + 1) + ' of ' + cands.length + ')', 0.2 + 0.7 * (k + 1) / cands.length);
    }
    var mask = Uint8Array.from(existingCovered), network = ctx.existing.slice();
    for (var pick = 0; pick < ctx.count; pick++) {
      cands.forEach(function (c) { var sc = 0; for (var j = 0; j < c.cover.length; j++) { var ci = c.cover[j]; if (!mask[ci]) sc += weight[ci]; } c.score = sc; });
      var order = cands.filter(function (c) { return !c.used && c.score > 0; }).sort(function (a, b) { return b.score - a.score; }), chosen = null, link = null;
      for (var o = 0; o < order.length && !chosen; o++) {
        if (!ctx.requireLink || !network.length) { chosen = order[o]; break; }
        var bestLink = null, bestWith = null;
        network.forEach(function (r) {
          var lm = linkMargin(dem, order[o].site, r, p);
          if (lm && lm.ok && (!bestLink || lm.margin > bestLink.margin)) { bestLink = lm; bestWith = r; }
        });
        if (bestLink) { chosen = order[o]; link = { with: bestWith, margin: bestLink.margin, km: bestLink.km }; }
      }
      if (!chosen) break;
      chosen.used = true;
      var cells = 0, nodes = 0, gain = [];
      for (var j = 0; j < chosen.cover.length; j++) { var ci = chosen.cover[j]; if (!mask[ci]) { cells++; if (nodeCells[ci]) nodes += nodeCells[ci]; gain.push(ci); } }
      gain.forEach(function (ci) { mask[ci] = 1; });
      result.picks.push({ lat: chosen.site.lat, lon: chosen.site.lon, elev: chosen.elev, h: chosen.site.h, newKm2: cells * cellKm2(grid, chosen.site.lat), newNodes: nodes,
        cells: Uint32Array.from(gain), link: link, site: chosen.site });
      network.push(chosen.site);
      await yieldNow('Choosing', 0.9 + 0.1 * (pick + 1) / ctx.count);
    }
    return result;
  }

  var api = { appLineOfSight: appLineOfSight, reachKm: reachKm, kOf: kOf, mercX: mercX, mercY: mercY, lonOf: lonOf, latOf: latOf, mPerPx: mPerPx, haversine: haversine, elevPx: elevPx, elevAt: elevAt, terrariumHeight: terrariumHeight,
    loadDem: loadDem, tileRange: tileRange, sensitivityDbm: sensitivityDbm, fspl: fspl, edgeLoss: edgeLoss, budget: budget, makeGrid: makeGrid, cellOf: cellOf,
    cellCentre: cellCentre, cellKm2: cellKm2, lossMap: lossMap, marginMap: marginMap, linkProfile: linkProfile, linkMargin: linkMargin, candidates: candidates, plan: plan };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Geo = api;
})(typeof self !== 'undefined' ? self : this);
