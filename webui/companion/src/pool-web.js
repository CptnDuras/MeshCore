// Spreads the planner's per-site work over Web Workers in the browser. Each worker runs the same engine (Geo.factorySource), gets its own copy of the
// terrain (one Int16 value per pixel, in thirds of a metre) once, and then is handed sites.
(function (root) {
  'use strict';
  var WORKER = [
    'var Geo = ' + (root.Geo && root.Geo.factorySource) + ', ev = null;',
    'onmessage = function (e) { var m = e.data;',
    '  if (m.type === "init") { var d = m.dem, f = new Float32Array(d.data.length); for (var i = 0; i < f.length; i++) f[i] = d.data[i] === -32768 ? NaN : d.data[i] / 3;',
    '    ev = Geo.makeEvaluator({ z: d.z, x0: d.x0, y0: d.y0, w: d.w, h: d.h, data: f }, m.grid, m.p); postMessage({ type: "ready" }); }',
    '  else if (m.type === "add") { ev.add(m.site); postMessage({ type: "added" }); }',
    '  else if (m.type === "collect") { var b = ev.collect(); postMessage({ type: "best", best: b }, [b.buffer]); }',
    '  else if (m.type === "cover") { var c = ev.cover(m.site); postMessage({ type: "cover", id: m.id, cover: c }, [c.buffer]); } };'
  ].join('\n');

  function supported() { return typeof Worker !== 'undefined' && typeof Blob !== 'undefined' && !!(root.Geo && root.Geo.factorySource); }

  // threads: how many workers; returns makePool(dem, grid, p) for Planrun.run, or null when this browser cannot
  function make(threads) {
    if (!supported()) return null;
    var n = Math.max(1, Math.min(threads || 4, 8));
    return function (dem, grid, p) {
      var url = URL.createObjectURL(new Blob([WORKER], { type: 'text/javascript' })), workers = [], closed = false;
      var small = new Int16Array(dem.data.length);
      for (var i = 0; i < small.length; i++) { var v = dem.data[i]; small[i] = v === v ? Math.max(-32767, Math.min(32767, Math.round(v * 3))) : -32768; }
      var init = { type: 'init', dem: { z: dem.z, x0: dem.x0, y0: dem.y0, w: dem.w, h: dem.h, data: small }, grid: grid, p: p };
      var ready = [];
      for (var k = 0; k < n; k++) {
        var w = new Worker(url); workers.push(w);
        ready.push(new Promise(function (res, rej) { w.onmessage = function () { res(); }; w.onerror = function (e) { rej(new Error(e.message || 'worker failed')); }; }));
        w.postMessage(init);
      }
      // a job is a function that gives each free worker its next message; done(w, message) says what the answer meant
      function runAll(count, next, onAnswer) {
        return Promise.all(ready).then(function () {
          return new Promise(function (resolve, reject) {
            var started = 0, finished = 0;
            if (!count) return resolve();
            workers.forEach(function (w) {
              function feed() { if (started < count) { var id = started++; w.postMessage(next(id)); } }
              w.onmessage = function (e) { onAnswer(e.data); finished++; if (finished === count) resolve(); else feed(); };
              w.onerror = function (e) { if (!closed) reject(new Error(e.message || 'worker failed')); };
              feed();
            });
          });
        });
      }
      return {
        threads: n,
        margins: function (sites, onDone) {
          var done = 0;
          return runAll(sites.length, function (id) { return { type: 'add', site: sites[id] }; }, function () { done++; if (onDone) onDone(done); }).then(function () {
            var maps = [];
            return Promise.all(workers.map(function (w) { return new Promise(function (res) { w.onmessage = function (e) { res(e.data.best); }; w.postMessage({ type: 'collect' }); }); }));
          }).then(function (all) {
            var out = all[0];
            for (var j = 1; j < all.length; j++) for (var q = 0; q < out.length; q++) if (all[j][q] > out[q]) out[q] = all[j][q];
            return out;
          });
        },
        covers: function (sites, onDone) {
          var out = new Array(sites.length), done = 0;
          return runAll(sites.length, function (id) { return { type: 'cover', id: id, site: sites[id] }; }, function (m) { out[m.id] = m.cover; done++; if (onDone) onDone(done); }).then(function () { return out; });
        },
        close: function () { closed = true; workers.forEach(function (w) { w.terminate(); }); URL.revokeObjectURL(url); }
      };
    };
  }
  root.PoolWeb = { make: make, supported: supported };
})(typeof self !== 'undefined' ? self : this);
