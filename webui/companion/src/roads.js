// The nearest publicly accessible road to a point, from OpenStreetMap (the Overpass API, which browsers may call directly).
// "Public" here means a way tagged as a road for general traffic and not tagged private, no-access, permit-only or customers-only.
// OpenStreetMap tags are volunteer-made: a road can be missing, and an unmarked gate or a seasonal closure will not show. Check before you drive.
(function (root) {
  'use strict';
  var ENDPOINT = 'https://overpass-api.de/api/interpreter';
  var PUBLIC = 'motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link';
  var cache = {}, chain = Promise.resolve();

  function query(lat, lon, maxM, tracks) {
    var kinds = PUBLIC + (tracks ? '|track|service' : '');
    return '[out:json][timeout:25];way["highway"~"^(' + kinds + ')$"]["access"!~"^(private|no|permit|customers)$"]["motor_vehicle"!~"^(private|no)$"]' +
      '(around:' + Math.round(maxM) + ',' + lat + ',' + lon + ');out geom;';
  }
  // metres from the point to the nearest part of a polyline (flat-earth maths is exact enough over a few kilometres)
  function distTo(lat, lon, geom) {
    var kx = Math.cos(lat * Math.PI / 180) * 111320, ky = 110540, best = Infinity;
    for (var i = 0; i < geom.length; i++) {
      var ax = (geom[i].lon - lon) * kx, ay = (geom[i].lat - lat) * ky;
      if (i === 0) { best = Math.min(best, Math.hypot(ax, ay)); continue; }
      var bx = (geom[i - 1].lon - lon) * kx, by = (geom[i - 1].lat - lat) * ky, dx = ax - bx, dy = ay - by, len2 = dx * dx + dy * dy;
      var u = len2 ? Math.max(0, Math.min(1, -(bx * dx + by * dy) / len2)) : 0;
      best = Math.min(best, Math.hypot(bx + u * dx, by + u * dy));
    }
    return best;
  }
  async function fetchRoads(lat, lon, maxM, tracks) {
    var delay = 1500, last = 'no answer';
    for (var attempt = 0; attempt < 3; attempt++) {
      try {
        var r = await fetch(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'data=' + encodeURIComponent(query(lat, lon, maxM, tracks)) });
        if (r.ok) { var j = await r.json(); return j.elements || []; }
        last = 'the road server answered ' + r.status;
        if (r.status !== 429 && r.status !== 502 && r.status !== 503 && r.status !== 504) break;
      } catch (e) { last = e.message; }
      await new Promise(function (res) { setTimeout(res, delay); }); delay *= 2;
    }
    throw new Error(last);
  }

  // -> { dist (metres), name, ref, highway } for the nearest road within maxM; { none: true } when there is none; { failed: true, error } when the lookup did not work
  function nearest(lat, lon, maxM, tracks) {
    var key = lat.toFixed(4) + ',' + lon.toFixed(4) + ',' + Math.round(maxM) + (tracks ? 't' : '');
    if (cache[key]) return cache[key];
    var job = chain.then(function () { return fetchRoads(lat, lon, maxM, tracks); }).then(function (ways) {
      var best = null;
      ways.forEach(function (w) { if (!w.geometry) return; var d = distTo(lat, lon, w.geometry); if (!best || d < best.dist) best = { dist: d, name: (w.tags && w.tags.name) || '', ref: (w.tags && w.tags.ref) || '', highway: w.tags && w.tags.highway }; });
      return best || { none: true };
    }).catch(function (e) { delete cache[key]; return { failed: true, error: e.message }; });
    chain = job.then(function () { }, function () { });   // one request at a time: the public server is shared
    cache[key] = job;
    return job;
  }

  root.Roads = { nearest: nearest, distTo: distTo };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.Roads;
})(typeof self !== 'undefined' ? self : this);
