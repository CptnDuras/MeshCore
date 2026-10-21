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
          im = el('img', { alt: '', draggable: 'false', src: 'https://tile.openstreetmap.org/' + z + '/' + wx + '/' + ty + '.png', referrerpolicy: 'origin', crossorigin: 'anonymous' });
          im.className = 'tile'; im.onerror = function () { this.style.visibility = 'hidden'; }; tiles[key] = im; tilesEl.appendChild(im);
        }
        im.px = Math.round(tx * T - c.x + w / 2); im.py = Math.round(ty * T - c.y + h / 2);
        im.style.transform = 'translate(' + im.px + 'px,' + im.py + 'px)';
      }
      Object.keys(tiles).forEach(function (k) { if (!seen[k]) { tiles[k].remove(); delete tiles[k]; } });
      var g = canvas.getContext('2d'); g.clearRect(0, 0, w, h);
      if (overlay) overlay(g, w, h, { toScreen: toScreen, z: z });
      if (drag) return;   // the pin being dragged must stay in the page until it is let go
      UI.clear(markersEl);
      markers.forEach(function (m) {
        var q = toScreen(m.lat, m.lon); if (q.x < -80 || q.y < -40 || q.x > w + 80 || q.y > h + 40) return;
        var pin = el('button', { class: 'pin' + (m.cls ? ' ' + m.cls : '') + (m.draggable ? ' drag' : ''), type: 'button', title: m.title || m.label, 'aria-label': m.title || m.label,
          style: 'transform:translate(' + Math.round(q.x) + 'px,' + Math.round(q.y) + 'px)', onclick: function (e) { e.stopPropagation(); if (dragged) { dragged = false; return; } if (m.onclick) m.onclick(m); } },
          [el('i', { style: 'background:' + (m.color || '#d6342a') }), el('span', { text: m.label || '' })]);
        if (m.draggable) pin.addEventListener('pointerdown', function (e) { startDrag(e, m, pin); });
        markersEl.appendChild(pin);
      });
    }
    // A marker with draggable: true follows the pointer; m.ondrag(lat, lon) is called as it moves and m.ondrop(lat, lon) when it is let go.
    var drag = null, dragged = false;
    function startDrag(e, m, pin) {
      e.stopPropagation(); e.preventDefault();
      var start = { x: e.clientX, y: e.clientY }, moved = false, r = box.getBoundingClientRect();
      drag = m;   // from now until it is let go, redraws leave the markers alone so this pin keeps its pointer
      try { pin.setPointerCapture(e.pointerId); } catch (x) { }
      function move(ev) {
        if (!moved && Math.abs(ev.clientX - start.x) + Math.abs(ev.clientY - start.y) < 5) return;
        moved = true;
        var g = fromScreen(ev.clientX - r.left, ev.clientY - r.top); m.lat = g.lat; m.lon = g.lon;
        pin.style.transform = 'translate(' + Math.round(ev.clientX - r.left) + 'px,' + Math.round(ev.clientY - r.top) + 'px)';
        if (m.ondrag) m.ondrag(g.lat, g.lon);
      }
      function end(ev) {
        pin.removeEventListener('pointermove', move); pin.removeEventListener('pointerup', end); pin.removeEventListener('pointercancel', end);
        drag = null;
        if (moved) { dragged = true; if (m.ondrop) m.ondrop(m.lat, m.lon); setTimeout(function () { dragged = false; }, 0); }
        redraw();
      }
      pin.addEventListener('pointermove', move); pin.addEventListener('pointerup', end); pin.addEventListener('pointercancel', end);
    }
    function redraw() { if (!raf) raf = requestAnimationFrame(draw); }
    // The view as a picture: loaded tiles, the overlay and the markers. scale 2 gives twice the pixels. extra(g, w, h, scale) paints captions on top.
    function snapshot(scale, extra) {
      draw(); scale = scale || 1;
      var c = document.createElement('canvas'), g = c.getContext('2d'); c.width = w * scale; c.height = h * scale;
      g.scale(scale, scale); g.fillStyle = '#e8e4dc'; g.fillRect(0, 0, w, h);
      Object.keys(tiles).forEach(function (k) { var im = tiles[k]; if (im.complete && im.naturalWidth) g.drawImage(im, im.px, im.py, T, T); });
      if (overlay) overlay(g, w, h, { toScreen: toScreen, z: v.z });
      g.font = 'bold 12px sans-serif'; g.textBaseline = 'middle'; g.lineJoin = 'round';
      markers.forEach(function (m) {
        var q = toScreen(m.lat, m.lon); if (q.x < -80 || q.y < -40 || q.x > w + 80 || q.y > h + 40) return;
        g.beginPath(); g.arc(q.x, q.y, 6, 0, 7); g.fillStyle = m.color || '#d6342a'; g.fill(); g.lineWidth = 2; g.strokeStyle = '#fff'; g.stroke();
        if (m.label) { g.lineWidth = 3; g.strokeStyle = 'rgba(255,255,255,.9)'; g.strokeText(m.label, q.x + 9, q.y); g.fillStyle = '#1b2733'; g.fillText(m.label, q.x + 9, q.y); }
      });
      if (extra) extra(g, w, h, scale);
      return c;
    }
    function setView(lat, lon, z) {
      v.lat = Math.max(-84, Math.min(84, lat)); v.lon = ((lon + 540) % 360) - 180; v.z = Math.max(2, Math.min(17, z)); redraw();
      if (opts.onView) opts.onView(v);
    }
    function zoomAt(dz, px, py) {
      var z1 = Math.max(2, Math.min(17, v.z + dz)); if (z1 === v.z) return;
      var g = fromScreen(px, py), z0 = v.z; v.z = z1;
      var nc = project(g.lat, g.lon, z1), centre = unproject(nc.x - (px - w / 2), nc.y - (py - h / 2), z1); v.z = z0; setView(centre.lat, centre.lon, z1);
    }
    var ptrs = {}, last = null, moved = 0, pinch = 0, press = 0;
    // onContext(lat, lon): a right click, or a touch held still for a moment, on the map itself (not on a marker)
    function context(clientX, clientY) { var r = box.getBoundingClientRect(), g = fromScreen(clientX - r.left, clientY - r.top); opts.onContext(g.lat, g.lon); }
    box.addEventListener('pointerdown', function (e) {
      if (e.target.closest && e.target.closest('.pin')) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;   // a right click is not the start of a drag or a tap
      box.setPointerCapture(e.pointerId); ptrs[e.pointerId] = { x: e.clientX, y: e.clientY }; last = { x: e.clientX, y: e.clientY }; moved = 0; pinch = 0;
      clearTimeout(press);
      if (opts.onContext && e.pointerType !== 'mouse') {
        var x = e.clientX, y = e.clientY;
        press = setTimeout(function () { if (moved < 6 && Object.keys(ptrs).length === 1) { moved = 99; context(x, y); } }, 600);
      }
    });
    if (opts.onContext) box.addEventListener('contextmenu', function (e) {
      e.preventDefault();
      if (e.pointerType === 'touch' || (e.target.closest && e.target.closest('.pin'))) return;   // a held touch is handled above; markers have their own menu
      context(e.clientX, e.clientY);
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
      delete ptrs[e.pointerId]; pinch = 0; clearTimeout(press);
      if (wasTap && opts.onClick) { var r = box.getBoundingClientRect(), g = fromScreen(e.clientX - r.left, e.clientY - r.top); opts.onClick(g.lat, g.lon); }
    }
    box.addEventListener('pointerup', up); box.addEventListener('pointercancel', up);
    box.addEventListener('wheel', function (e) { e.preventDefault(); var r = box.getBoundingClientRect(); zoomAt(e.deltaY < 0 ? 1 : -1, e.clientX - r.left, e.clientY - r.top); }, { passive: false });
    box.addEventListener('keydown', function (e) {
      var c = project(v.lat, v.lon, v.z), s = 80, d = { ArrowLeft: [-s, 0], ArrowRight: [s, 0], ArrowUp: [0, -s], ArrowDown: [0, s] }[e.key];
      if (d) { e.preventDefault(); var g = unproject(c.x + d[0], c.y + d[1], v.z); setView(g.lat, g.lon, v.z); } else if (e.key === '+' || e.key === '=') zoomAt(1, w / 2, h / 2); else if (e.key === '-') zoomAt(-1, w / 2, h / 2);
    });
    if (window.ResizeObserver) new ResizeObserver(redraw).observe(box);
    return { el: box, view: v, setView: setView, zoomAt: zoomAt, toScreen: toScreen, fromScreen: fromScreen, bounds: bounds, redraw: redraw, snapshot: snapshot, size: function () { size(); return { w: w, h: h }; },
      setMarkers: function (m) { markers = m; redraw(); }, setOverlay: function (f) { overlay = f; redraw(); } };
  }
  root.Slippy = { create: create, project: project, unproject: unproject };
})(window);
