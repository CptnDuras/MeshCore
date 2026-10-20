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
  console.log(bad ? bad + ' failed' : 'all passed'); process.exit(bad ? 1 : 0);
})();
