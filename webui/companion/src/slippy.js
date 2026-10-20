// A small slippy map on OpenStreetMap tiles with a drawing layer on top, for the planner: drag to pan, wheel or pinch to zoom,
// click to report a position. Markers are buttons; the overlay is a canvas the caller paints on every redraw.
(function (root) {
  'use strict';
  var el = UI.el, T = 256;
  function project(lat, lon, z) {
    var s = T * Math.pow(2, z), sin = Math.sin(Math.max(-85, Math.min(85, lat)) * Math.PI / 180);
    return { x: (lon + 180) / 360 * s, y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * s };
  }
  function unproject(x, y, z) {
    var s = T * Math.pow(2, z), n = Math.PI - 2 * Math.PI * y / s;
    return { lat: 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))), lon: x / s * 360 - 180 };
  }

  // opts: lat, lon, z, onView(view), onClick(lat, lon)
  function create(opts) {
    var v = { lat: opts.lat, lon: opts.lon, z: opts.z }, w = 600, h = 400, tiles = {}, markers = [], overlay = null, raf = 0;
    var tilesEl = el('div', { class: 'tiles' }), canvas = el('canvas', { class: 'overlay' }), markersEl = el('div', { class: 'markers' });
    var box = el('div', { class: 'mapview', tabindex: 0, role: 'application', 'aria-label': opts.label || 'Map' }, [tilesEl, canvas, markersEl,
      el('a', { class: 'attr', href: 'https://www.openstreetmap.org/copyright', target: '_blank', rel: 'noopener noreferrer', text: '© OpenStreetMap contributors' })]);

    function size() { w = box.clientWidth || 600; h = box.clientHeight || 400; if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; } }
    function toScreen(lat, lon) { var c = project(v.lat, v.lon, v.z), q = project(lat, lon, v.z); return { x: q.x - c.x + w / 2, y: q.y - c.y + h / 2 }; }
    function fromScreen(x, y) { var c = project(v.lat, v.lon, v.z); return unproject(c.x + x - w / 2, c.y + y - h / 2, v.z); }
    function bounds() { var a = fromScreen(0, 0), b = fromScreen(w, h); return { north: a.lat, west: a.lon, south: b.lat, east: b.lon }; }

    function draw() {
      raf = 0; size();
      var z = v.z, c = project(v.lat, v.lon, z), n = Math.pow(2, z), seen = {};
      var x0 = Math.floor((c.x - w / 2) / T), x1 = Math.floor((c.x + w / 2) / T), y0 = Math.max(0, Math.floor((c.y - h / 2) / T)), y1 = Math.min(n - 1, Math.floor((c.y + h / 2) / T));
      for (var tx = x0; tx <= x1; tx++) for (var ty = y0; ty <= y1; ty++) {
        var wx = ((tx % n) + n) % n, key = z + '/' + tx + '/' + ty; seen[key] = 1;
        var im = tiles[key];
        if (!im) {
          im = el('img', { alt: '', draggable: 'false', src: 'https://tile.openstreetmap.org/' + z + '/' + wx + '/' + ty + '.png', referrerpolicy: 'origin' });
          im.className = 'tile'; im.onerror = function () { this.style.visibility = 'hidden'; }; tiles[key] = im; tilesEl.appendChild(im);
        }
        im.style.transform = 'translate(' + Math.round(tx * T - c.x + w / 2) + 'px,' + Math.round(ty * T - c.y + h / 2) + 'px)';
      }
      Object.keys(tiles).forEach(function (k) { if (!seen[k]) { tiles[k].remove(); delete tiles[k]; } });
      var g = canvas.getContext('2d'); g.clearRect(0, 0, w, h);
      if (overlay) overlay(g, w, h, { toScreen: toScreen, z: z });
      UI.clear(markersEl);
      markers.forEach(function (m) {
        var q = toScreen(m.lat, m.lon); if (q.x < -80 || q.y < -40 || q.x > w + 80 || q.y > h + 40) return;
        markersEl.appendChild(el('button', { class: 'pin' + (m.cls ? ' ' + m.cls : ''), type: 'button', title: m.title || m.label, 'aria-label': m.title || m.label,
          style: 'transform:translate(' + Math.round(q.x) + 'px,' + Math.round(q.y) + 'px)', onclick: function (e) { e.stopPropagation(); if (m.onclick) m.onclick(m); } },
          [el('i', { style: 'background:' + (m.color || '#d6342a') }), el('span', { text: m.label || '' })]));
      });
    }
    function redraw() { if (!raf) raf = requestAnimationFrame(draw); }
    function setView(lat, lon, z) {
      v.lat = Math.max(-84, Math.min(84, lat)); v.lon = ((lon + 540) % 360) - 180; v.z = Math.max(2, Math.min(17, z)); redraw();
      if (opts.onView) opts.onView(v);
    }
    function zoomAt(dz, px, py) {
      var z1 = Math.max(2, Math.min(17, v.z + dz)); if (z1 === v.z) return;
      var g = fromScreen(px, py), z0 = v.z; v.z = z1;
      var nc = project(g.lat, g.lon, z1), centre = unproject(nc.x - (px - w / 2), nc.y - (py - h / 2), z1); v.z = z0; setView(centre.lat, centre.lon, z1);
    }
    var ptrs = {}, last = null, moved = 0, pinch = 0;
    box.addEventListener('pointerdown', function (e) {
      if (e.target.closest && e.target.closest('.pin')) return;
      box.setPointerCapture(e.pointerId); ptrs[e.pointerId] = { x: e.clientX, y: e.clientY }; last = { x: e.clientX, y: e.clientY }; moved = 0; pinch = 0;
    });
    box.addEventListener('pointermove', function (e) {
      if (!ptrs[e.pointerId]) return; ptrs[e.pointerId] = { x: e.clientX, y: e.clientY };
      var ids = Object.keys(ptrs);
      if (ids.length === 2) {
        var d = Math.hypot(ptrs[ids[0]].x - ptrs[ids[1]].x, ptrs[ids[0]].y - ptrs[ids[1]].y), r = box.getBoundingClientRect(); moved = 99;
        if (pinch && Math.abs(d - pinch) > 40) { zoomAt(d > pinch ? 1 : -1, (ptrs[ids[0]].x + ptrs[ids[1]].x) / 2 - r.left, (ptrs[ids[0]].y + ptrs[ids[1]].y) / 2 - r.top); pinch = d; } else if (!pinch) pinch = d;
        return;
      }
      moved += Math.abs(e.clientX - last.x) + Math.abs(e.clientY - last.y);
      var c = project(v.lat, v.lon, v.z), g = unproject(c.x - (e.clientX - last.x), c.y - (e.clientY - last.y), v.z); last = { x: e.clientX, y: e.clientY }; setView(g.lat, g.lon, v.z);
    });
    function up(e) {
      var wasTap = ptrs[e.pointerId] && moved < 6 && Object.keys(ptrs).length === 1 && e.type === 'pointerup';
      delete ptrs[e.pointerId]; pinch = 0;
      if (wasTap && opts.onClick) { var r = box.getBoundingClientRect(), g = fromScreen(e.clientX - r.left, e.clientY - r.top); opts.onClick(g.lat, g.lon); }
    }
    box.addEventListener('pointerup', up); box.addEventListener('pointercancel', up);
    box.addEventListener('wheel', function (e) { e.preventDefault(); var r = box.getBoundingClientRect(); zoomAt(e.deltaY < 0 ? 1 : -1, e.clientX - r.left, e.clientY - r.top); }, { passive: false });
    box.addEventListener('keydown', function (e) {
      var c = project(v.lat, v.lon, v.z), s = 80, d = { ArrowLeft: [-s, 0], ArrowRight: [s, 0], ArrowUp: [0, -s], ArrowDown: [0, s] }[e.key];
      if (d) { e.preventDefault(); var g = unproject(c.x + d[0], c.y + d[1], v.z); setView(g.lat, g.lon, v.z); } else if (e.key === '+' || e.key === '=') zoomAt(1, w / 2, h / 2); else if (e.key === '-') zoomAt(-1, w / 2, h / 2);
    });
    if (window.ResizeObserver) new ResizeObserver(redraw).observe(box);
    return { el: box, view: v, setView: setView, zoomAt: zoomAt, toScreen: toScreen, fromScreen: fromScreen, bounds: bounds, redraw: redraw, size: function () { size(); return { w: w, h: h }; },
      setMarkers: function (m) { markers = m; redraw(); }, setOverlay: function (f) { overlay = f; redraw(); } };
  }
  root.Slippy = { create: create, project: project, unproject: unproject };
})(window);
