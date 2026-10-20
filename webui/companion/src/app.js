// The app shell: side rail / bottom tabs, connection banner, hash router, theme, document title.
(function (root) {
  'use strict';
  var el = UI.el, W = root.W, S = W.S;
  var views = {}, order = [], current = null, rail, main, banner, dot;

  // def: {id, title, icon, mount(box), show(arg), badge()}
  function register(def) { views[def.id] = def; order.push(def.id); }

  function parseHash() {
    var parts = location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
    return { view: parts[0] || order[0], arg: parts.slice(1).join('/') };
  }
  function go(view, arg) {
    var h = '#/' + view + (arg ? '/' + encodeURIComponent(arg) : '');
    if (location.hash === h) route(); else location.hash = h;
  }
  function route() {
    var r = parseHash(), v = views[r.view] || views[order[0]];
    order.forEach(function (id) { views[id].box.classList.toggle('sel', id === v.id); });
    [].forEach.call(rail.querySelectorAll('.tab'), function (t) { t.classList.toggle('sel', t.dataset.v === v.id); t.setAttribute('aria-current', t.dataset.v === v.id ? 'page' : 'false'); });
    current = v; if (v.show) v.show(r.arg);
    updateBadges();
  }

  function updateBadges() {
    order.forEach(function (id) {
      var v = views[id], n = v.badge ? v.badge() : 0, tab = rail.querySelector('[data-v="' + id + '"]'), p = tab && tab.querySelector('.pill');
      if (!tab) return;
      if (n && !p) { p = el('span', { class: 'pill' }); tab.appendChild(p); }
      if (p) { if (n) p.textContent = n > 99 ? '99+' : n; else p.remove(); }
    });
    var total = order.reduce(function (a, id) { return a + (views[id].badge ? views[id].badge() : 0); }, 0);
    document.title = (total ? '(' + total + ') ' : '') + ((S.self && S.self.name) || 'MeshCore') + ' · MeshCore';
  }

  function applyTheme() {
    var t = W.settings.theme;
    if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
  }

  function updateStatus() {
    dot.className = S.status; dot.lastChild.textContent = S.status === 'online' ? (S.self ? 'online' : '…') : S.status;
    var txt = '', cls = '';
    if (S.status === 'connecting') txt = 'Connecting to the node…';
    else if (S.status === 'offline') { txt = 'Connection lost. Reconnecting…'; cls = 'bad'; }
    else if (S.status === 'error') { txt = S.statusText + '. Reconnecting…'; cls = 'bad'; }
    else if (S.status === 'replaced') { txt = 'Another page took over this node (it allows ' + 3 + ' at a time). Reload this page to use it here.'; cls = 'bad'; }
    banner.className = txt ? 'show ' + cls : ''; banner.id = 'banner'; banner.textContent = txt;
  }

  function start() {
    var app = document.getElementById('app');
    rail = el('nav', { id: 'rail', 'aria-label': 'Sections' });
    rail.appendChild(el('div', { class: 'brand' }, [UI.icon('antenna', 26), el('span', { text: 'MeshCore' })]));
    order.forEach(function (id) {
      var v = views[id];
      rail.appendChild(el('a', { class: 'tab', href: '#/' + id, dataset: { v: id } }, [UI.icon(v.icon, 22), el('span', { text: v.title })]));
    });
    rail.appendChild(el('div', { class: 'grow' }));
    dot = el('div', { id: 'statusdot', title: 'Connection to the node' }, [el('i'), el('span')]);
    rail.appendChild(dot);
    main = el('div', { id: 'main' });
    banner = el('div', { id: 'banner', role: 'status' });
    main.appendChild(banner);
    order.forEach(function (id) { var b = el('section', { class: 'view', id: 'view-' + id, 'aria-label': views[id].title }); views[id].box = b; main.appendChild(b); views[id].mount(b); });
    app.appendChild(rail); app.appendChild(main);
    applyTheme();
    W.bus.on('settings', applyTheme);
    W.bus.on('status', updateStatus); W.bus.on('self', function () { updateStatus(); updateBadges(); });
    ['msg', 'unread', 'contacts', 'channels'].forEach(function (ev) { W.bus.on(ev, updateBadges); });
    updateStatus();
    window.addEventListener('hashchange', route);
    route();
    W.connect();
  }

  root.App = { register: register, start: start, go: go, route: route, current: function () { return current; }, updateBadges: updateBadges };
})(window);
