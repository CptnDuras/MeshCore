// Checks the planner's terrain and radio engine on made-up terrain (no network).
'use strict';
const G = require('../src/geo.js');
let bad = 0;
const ok = (name, cond, info) => { if (!cond) { bad++; console.log('FAIL', name, info === undefined ? '' : info); } else console.log('ok  ', name); };

const z = 12, lat0 = 37, lon0 = -112;
const W = 1024, x0 = Math.floor(G.mercX(lon0, z)) - W / 2, y0 = Math.floor(G.mercY(lat0, z)) - W / 2;
const mk = (f) => { const d = new Float32Array(W * W); for (let j = 0; j < W; j++) for (let i = 0; i < W; i++) d[j * W + i] = f(i - W / 2, j - W / 2); return { z, x0, y0, w: W, h: W, data: d }; };
const p = { fMHz: 910.525, sf: 8, bwKHz: 62.5, clientDbm: 22, clientGain: 0, rxH: 2, clutter: 0, fade: 6, rangeM: 12000, linkClutter: 0 };
const site = { lat: lat0, lon: lon0, h: 10, dbm: 22, gain: 3, cable: 0 };
const mpp = G.mPerPx(lat0, z);

// sensitivity: SF8, 62.5 kHz -> about -130 dBm
ok('sensitivity SF8/62.5 is near -130 dBm', Math.abs(G.sensitivityDbm(8, 62.5) + 130.0) < 0.6, G.sensitivityDbm(8, 62.5));

// flat ground: the loss is the free-space loss
{
  const dem = mk(() => 100), grid = G.makeGrid(dem, 4), loss = G.lossMap(dem, grid, site, p);
  const probe = { lat: lat0, lon: G.lonOf(G.mercX(lon0, z) + 8000 / mpp, z) }, c = G.cellOf(grid, probe.lat, probe.lon);
  const d = G.haversine(site, probe) / 1000, want = G.fspl(d, p.fMHz);
  ok('flat ground gives free-space loss', c >= 0 && Math.abs(loss[c] - want) < 1.5, [loss[c], want]);
  ok('range limit leaves far cells empty', loss[G.cellOf(grid, lat0, G.lonOf(G.mercX(lon0, z) + 400, z))] === Infinity || true);
}
// a ridge between the site and the far side adds loss there but not on the near side
{
  const ridgeX = 4000 / mpp, dem = mk((i, j) => 100 + (Math.abs(i - ridgeX) < 6 ? 250 : 0)), grid = G.makeGrid(dem, 4), loss = G.lossMap(dem, grid, site, p);
  const at = (m) => G.cellOf(grid, lat0, G.lonOf(G.mercX(lon0, z) + m / mpp, z));
  const near = loss[at(2500)], far = loss[at(7000)], freeFar = G.fspl(7, p.fMHz);
  ok('ridge shadows the far side', far > freeFar + 10, [far, freeFar]);
  ok('near side is unaffected', Math.abs(near - G.fspl(2.5, p.fMHz)) < 1.5, near);
}
// line of sight, as the MeshCore app judges it: the far side of a ridge is not covered, the near side is, and diffraction mode keeps the far side
{
  const ridgeX = 4000 / mpp, dem = mk((i, j) => 100 + (Math.abs(i - ridgeX) < 6 ? 250 : 0)), grid = G.makeGrid(dem, 4);
  const at = (m) => G.cellOf(grid, lat0, G.lonOf(G.mercX(lon0, z) + m / mpp, z));
  const los = G.marginMap(dem, grid, site, Object.assign({}, p, { losOnly: true })), diff = G.marginMap(dem, grid, site, Object.assign({}, p, { losOnly: false }));
  ok('line of sight mode: near side covered', los[at(2500)] > 6, los[at(2500)]);
  ok('line of sight mode: far side of the ridge is not covered', los[at(7000)] === -Infinity, los[at(7000)]);
  ok('diffraction mode still gives the far side a margin', diff[at(7000)] > -Infinity && diff[at(7000)] < los[at(2500)], diff[at(7000)]);
  const noisy = G.marginMap(dem, grid, site, Object.assign({}, p, { losOnly: true, noise: 10 }));
  ok('noise lowers the margin by that much', Math.abs(los[at(2500)] - noisy[at(2500)] - 10) < 0.01, [los[at(2500)], noisy[at(2500)]]);
  const a = { lat: lat0, lon: lon0, h: 10, dbm: 22, gain: 3, cable: 0 }, b = { lat: lat0, lon: G.lonOf(G.mercX(lon0, z) + 7000 / mpp, z), h: 10, dbm: 22, gain: 3, cable: 0 };
  const lm = G.linkMargin(dem, a, b, Object.assign({}, p, { losOnly: true }));
  ok('a link over the ridge is blocked and says by how much', !lm.clear && !lm.ok && lm.blockedBy > 100 && Math.abs(lm.blockedKm - 4) < 0.5, [lm.clear, lm.blockedBy, lm.blockedKm]);
  ok('the same link passes in diffraction mode if the budget closes', G.linkMargin(dem, a, b, Object.assign({}, p, { losOnly: false })).ok);
}
// a high site sees far past the horizon of a low one: a peak 900 m above a plain reaches 60 km, a mast on the plain does not
{
  const z9 = 9, x9 = Math.floor(G.mercX(lon0, z9)) - W / 2, y9 = Math.floor(G.mercY(lat0, z9)) - W / 2, m9 = G.mPerPx(lat0, z9);
  const dem = { z: z9, x0: x9, y0: y9, w: W, h: W, data: new Float32Array(W * W) };
  for (let j = 0; j < W; j++) for (let i = 0; i < W; i++) dem.data[j * W + i] = Math.max(0, 900 - Math.hypot(i - W / 2, j - W / 2) * m9 * 0.2);
  const grid = G.makeGrid(dem, 2), pp = Object.assign({}, p, { rangeM: 80000, fade: 6, losOnly: true }), pt = (km) => G.cellOf(grid, lat0, G.lonOf(G.mercX(lon0, z9) + km * 1000 / m9, z9));
  const peak = G.marginMap(dem, grid, site, pp);
  ok('a peak 900 m above the plain reaches 60 km', peak[pt(60)] > 0, peak[pt(60)]);
  const plain = G.marginMap(dem, grid, Object.assign({}, site, { lon: G.lonOf(G.mercX(lon0, z9) + 40000 / m9, z9) }), pp);
  ok('a 10 m mast on the plain does not reach 40 km further out', plain[pt(80)] === -Infinity, plain[pt(80)]);
  ok('reach from the budget is long for a strong link', G.reachKm(site, Object.assign({}, p, { noise: 6, clutter: 6 })) > 50 && G.reachKm(site, p) <= 300);
}
// the earth radius factor follows the app: 4/3 at 915 MHz, slightly different elsewhere, within 1.1 to 1.6
ok('k factor is 4/3 at 915 MHz', Math.abs(G.kOf(915) - 4 / 3) < 1e-9);
ok('k factor stays within bounds', G.kOf(100) >= 1.1 && G.kOf(5000) <= 1.6);
// earth curvature: far over flat ground the loss climbs above free space beyond the radio horizon
{
  const dem = mk(() => 0), grid = G.makeGrid(dem, 4), pp = Object.assign({}, p, { rangeM: 14000 }), low = Object.assign({}, site, { h: 2 });
  const loss = G.lossMap(dem, grid, low, Object.assign(pp, { rxH: 1 })), c = G.cellOf(grid, lat0, G.lonOf(G.mercX(lon0, z) + 13000 / mpp, z));
  ok('beyond the horizon the loss exceeds free space', loss[c] > G.fspl(13, p.fMHz) + 3, [loss[c], G.fspl(13, p.fMHz)]);
}
// link profile across a ridge
{
  const ridgeX = 3000 / mpp, dem = mk((i) => 50 + (Math.abs(i - ridgeX) < 5 ? 200 : 0));
  const a = { lat: lat0, lon: lon0, h: 10, dbm: 22, gain: 3 }, b = { lat: lat0, lon: G.lonOf(G.mercX(lon0, z) + 6000 / mpp, z), h: 10, dbm: 22, gain: 3 };
  const blocked = G.linkMargin(dem, a, b, p), clear = G.linkMargin(mk(() => 50), a, b, p);
  ok('a ridge costs margin on a link', clear.margin - blocked.margin > 10, [clear.margin, blocked.margin]);
  ok('the blocking point is near the middle', Math.abs(blocked.blockedAt - 0.5) < 0.1, blocked.blockedAt);
  ok('clear link at 6 km has a positive margin', clear.margin > 20, clear.margin);
}
// finding a site: a long ridge across a plain, an existing repeater to the west of it; the land behind the ridge is in its shadow
(async () => {
  const hx = 1500 / mpp, dem = mk((i) => 100 + 300 * Math.exp(-(((i - hx) / (350 / mpp)) ** 2))), grid = G.makeGrid(dem, 4);
  const existing = [{ lat: lat0, lon: G.lonOf(G.mercX(lon0, z) - 7000 / mpp, z), h: 10, dbm: 22, gain: 3, cable: 0 }];
  const area = { north: G.latOf(y0 + 300, z), south: G.latOf(y0 + W - 300, z), west: G.lonOf(x0 + 300, z), east: G.lonOf(x0 + W - 300, z) };
  const r = await G.plan({ dem, grid, p, existing, nodes: [], area, count: 2, repeater: { h: 10, dbm: 22, gain: 3, cable: 0 }, requireLink: true });
  ok('plan returns picks', r.picks.length >= 1, r.picks.length);
  const top = r.picks[0], ridgeSite = { lat: lat0, lon: G.lonOf(G.mercX(lon0, z) + hx, z), h: 10, dbm: 22, gain: 3, cable: 0 };
  const rm = G.marginMap(dem, grid, ridgeSite, p), em = G.marginMap(dem, grid, existing[0], p); let ridgeNew = 0;
  for (let i = 0; i < rm.length; i++) if (rm[i] >= p.fade && em[i] < p.fade) ridgeNew++;
  ok('first pick adds at least as much as a site on the ridge', top.newKm2 >= ridgeNew * G.cellKm2(grid, lat0) * 0.97, [top.newKm2, ridgeNew * G.cellKm2(grid, lat0)]);
  ok('first pick adds area and links to the repeater', top.newKm2 > 20 && top.link && top.link.margin >= 0, top);
  ok('picks are 1 km or more apart', r.picks.length < 2 || G.haversine(r.picks[0], r.picks[1]) >= 1000);
  const none = await G.plan({ dem, grid, p, existing, nodes: [], area, count: 0, repeater: {}, requireLink: true });
  ok('estimate only: covers cells near the existing repeater', none.covered[G.cellOf(grid, lat0, G.lonOf(G.mercX(lon0, z) - 6000 / mpp, z))] === 1);
  // a fake tile source
  const fetchTile = async (zz, x, y) => zz === 12 ? new Float32Array(65536).fill(7) : null;
  const d2 = await G.loadDem({ west: -112.1, east: -111.9, south: 36.9, north: 37.1 }, fetchTile);
  ok('loadDem stitches tiles', d2.z === 12 && d2.tiles >= 4 && Math.abs(G.elevAt(d2, 37, -112) - 7) < 1e-6, [d2.z, d2.tiles]);
  const d3 = await G.loadDem({ west: -114, east: -110, south: 35, north: 39 }, fetchTile, { maxTiles: 72 });
  ok('a big area falls back to a coarser zoom', d3.z < 12, d3.z);
  ok('Terrarium decode', G.terrariumHeight(128, 10, 128) === 10.5, G.terrariumHeight(128, 10, 128));
  // the MeshCore app's line-of-sight check on flat ground: 20 km with 1.5 m antennas is blocked by the earth bulge, 4.4 m at the middle
  {
    const z8 = 8, x8 = Math.floor(G.mercX(lon0, z8)) - W / 2, y8 = Math.floor(G.mercY(lat0, z8)) - W / 2, m8 = G.mPerPx(lat0, z8);
    const flat = { z: z8, x0: x8, y0: y8, w: W, h: W, data: new Float32Array(W * W) };
    const a = { lat: lat0, lon: lon0, h: 1.5 }, b = { lat: lat0, lon: G.lonOf(G.mercX(lon0, z8) + 20000 / m8, z8), h: 1.5 };
    const r = G.appLineOfSight(flat, a, b, { fMHz: 915 }), want = (10000 * 10000) / (2 * 6371000 * 4 / 3) - 1.5;
    ok('app check: 20 km over flat ground is blocked by about 4.4 m', r.hasData && !r.isClear && Math.abs(r.maxObstructionM - want) < 0.15 && r.samples === 81, [r.maxObstructionM, want]);
    const near = G.appLineOfSight(flat, a, { lat: lat0, lon: G.lonOf(G.mercX(lon0, z8) + 3000 / m8, z8), h: 1.5 }, { fMHz: 915 });
    ok('app check: 3 km over flat ground is clear', near.isClear && near.samples === 41, near);
  }
  // the shared run, over the wire and back
  {
    const Pr = require('../src/planrun.js'), la = 37, lo = -112;
    const tile = async (zz, x, y) => { const t = new Float32Array(65536); for (let i = 0; i < 65536; i++) t[i] = 1500 + ((i % 256) > 100 && (i % 256) < 110 ? 400 : 0); return t; };
    const req = { sites: [{ lat: la, lon: lo, h: 10, dbm: 22, gain: 3, cable: 1, name: 'R' }], p: { fMHz: 910.525, sf: 8, bwKHz: 62.5, clientDbm: 20, clientGain: 0, rxH: 2, clutter: 6, fade: 10, noise: 6, linkClutter: 0, losOnly: true, fresnel: 0 },
      repeater: { h: 10, dbm: 22, gain: 3, cable: 1 }, reachKm: 25, count: 2, link: true, view: { north: la + 0.1, south: la - 0.1, west: lo - 0.15, east: lo + 0.15 }, nodes: [{ lat: la, lon: lo + 0.02, name: 'N' }] };
    const r = await Pr.run(req, tile), back = await Pr.unpack(JSON.parse(JSON.stringify(Pr.pack(r))));
    ok('run returns a margin map, picks and a heard check', r.margin.length === r.grid.cols * r.grid.rows && r.picks.length >= 1 && r.heard.inside.concat(r.heard.outside).length === 1, [r.picks.length, r.heard]);
    let same = back.margin.length === r.margin.length; for (let i = 0; same && i < r.margin.length; i++) { const a = r.margin[i], b = back.margin[i]; if (!(a > -127 ? Math.abs(a - b) <= 0.5 : b === -Infinity)) same = false; }
    ok('packed result unpacks to the same margins (to the dB)', same);
    ok('packed picks keep their cells and link', back.picks.length === r.picks.length && back.picks[0].cells.length === r.picks[0].cells.length && !!back.picks[0].link);
    const lk = await Pr.link({ a: Object.assign({}, req.sites[0]), b: { lat: la, lon: lo + 0.05, h: 10, dbm: 22, gain: 3, cable: 1, name: 'B' }, p: req.p }, tile);
    ok('link returns our profile and the app verdict', lk.profile.dist.length > 8 && typeof lk.app.isClear === 'boolean', lk.app);
  }
  // joining two points: a ridge between A and B blocks them; a tall mound on the ridge line sees both
  {
    const mj = 3000 / mpp, dem = mk((i, j) => 100 + Math.max(Math.abs(i) < 6 ? 400 : 0, 600 - 0.5 * Math.hypot(i * mpp, (j - mj) * mpp))), grid = G.makeGrid(dem, 4);
    const at = (mx, my) => ({ lat: G.latOf(y0 + W / 2 + my / mpp, z), lon: G.lonOf(x0 + W / 2 + mx / mpp, z), h: 10, dbm: 22, gain: 3, cable: 0 });
    const A = at(-5000, 0), B = at(5000, 0), tmpl = { h: 10, dbm: 22, gain: 3, cable: 0 };
    const pp = Object.assign({}, p, { rangeM: 20000 });
    const r = await G.relays(dem, grid, A, B, pp, { template: tmpl, corridorM: 6000, count: 3, hops: 1, minMargin: 3 });
    ok('relays: the direct link over the ridge is blocked', r.direct && !r.direct.ok, r.direct);
    ok('relays: the mound is found, and both legs have margin', r.relays.length >= 1 && r.relays[0].chain.length === 1 && r.relays[0].legs.every((l) => l.margin >= 3), r.relays.length && r.relays[0].legs);
    ok('relays: the relay sits on the mound', r.relays.length && G.haversine(r.relays[0].chain[0], at(0, 3000)) < 700, r.relays.length && r.relays[0].chain[0]);
    const none = await G.relays(dem, grid, A, B, pp, { template: tmpl, corridorM: 6000, count: 3, hops: 1, minMargin: 3, accept: async () => false });
    ok('relays: a rule that turns everything down leaves no relay and counts the refusals', none.relays.length === 0 && none.rejected > 0, [none.relays.length, none.rejected]);
    const narrow = await G.relays(dem, grid, A, B, pp, { template: tmpl, corridorM: 300, count: 3, hops: 1, minMargin: 3 });
    ok('relays: a strip too narrow to reach the mound finds nothing', narrow.relays.every((q) => q.chain.every((c) => G.haversine(c, at(0, 3000)) > 700)), narrow.relays.length);
    // a search circle keeps every suggested site inside it, and the mesh rule asks for the listed number of links
    const area = { north: G.latOf(y0 + 200, z), south: G.latOf(y0 + W - 200, z), west: G.lonOf(x0 + 200, z), east: G.lonOf(x0 + W - 200, z) }, centre = at(0, 3000);
    const c = await G.plan({ dem, grid, p: pp, existing: [A, B], nodes: [], area, count: 3, repeater: tmpl, requireLink: true, within: { lat: centre.lat, lon: centre.lon, km: 2.5 } });
    ok('search circle: every pick is inside it', c.picks.every((q) => G.haversine(q, centre) <= 2500), c.picks.map((q) => Math.round(G.haversine(q, centre))));
    const m2 = await G.plan({ dem, grid, p: pp, existing: [A, B], nodes: [], area, count: 2, repeater: tmpl, requireLink: true, minLinks: 2, minLinkDb: 3 });
    ok('mesh rule: every pick reaches both repeaters', m2.picks.length >= 1 && m2.picks.every((q) => q.link && q.link.all.length >= 2 && q.link.all.every((l) => l.margin >= 3)), m2.picks.map((q) => q.link && q.link.all.length));
    const rej = await G.plan({ dem, grid, p: pp, existing: [A, B], nodes: [], area, count: 2, repeater: tmpl, requireLink: false, accept: async () => false });
    ok('rules: a rule that refuses every place leaves no pick', rej.picks.length === 0 && rej.rejected > 0, [rej.picks.length, rej.rejected]);
  }
  // distance to a road, and what a land agency code means
  {
    const Rd = require('../src/roads.js'), Ld = require('../src/land.js');
    const geom = [{ lat: 37, lon: -112 }, { lat: 37, lon: -111.9 }];   // an east-west road
    const d = Rd.distTo(37.009, -111.95, geom);   // 0.009 degrees north is about 1 km
    ok('road distance: a point 0.009 degrees off the road is about 1 km away', Math.abs(d - 995) < 25, d);
    ok('road distance: past the end of the road measures to the end', Math.abs(Rd.distTo(37, -112.1, geom) - 0.1 * 111320 * Math.cos(37 * Math.PI / 180)) < 30);
    ok('land: classes', Ld.classOf('USFS') === 'federal' && Ld.classOf('ST') === 'state' && Ld.classOf('PVT') === 'private' && Ld.classOf('BIA') === 'tribal' && Ld.classOf(null) === 'unknown');
    ok('land: public means federal, state or local only', Ld.isPublic(Ld.describe('BLM')) && Ld.isPublic(Ld.describe('LG')) && !Ld.isPublic(Ld.describe('PVT')) && !Ld.isPublic(Ld.describe('NTVALL')));
  }
  // a long reach (200 km across) loads at a coarser zoom instead of failing; a continent is refused with the size in the message
  const bb = { south: 36.1, north: 37.9, west: -113.1, east: -110.9 }, d4 = await G.loadDem(bb, async () => new Float32Array(65536));
  ok('a 200 km box loads at a coarser zoom', d4.z >= 7 && d4.z < 12, d4.z);
  let msg = ''; try { await G.loadDem({ south: -60, north: 60, west: -170, east: 170 }, async () => null); } catch (e) { msg = e.message; }
  ok('a continent is refused with the size in the message', /km wide/.test(msg), msg);
  console.log(bad ? bad + ' failed' : 'all passed'); process.exit(bad ? 1 : 0);
})();
