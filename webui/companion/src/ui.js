// Small DOM toolkit: element builder, icons, toasts, dialogs, formatting. No framework.
(function (root) {
  'use strict';

  function el(tag, attrs, kids) {
    var e = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      var v = attrs[k];
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;       // text only, never markup: mesh-supplied strings pass through here
      else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), v);
      else if (k === 'dataset') for (var d in v) e.dataset[d] = v[d];
      else if (k === 'value') e.value = v;
      else e.setAttribute(k, v === true ? '' : v);
    }
    (function add(list) {
      if (list == null) return;
      if (Array.isArray(list)) { list.forEach(add); return; }
      e.appendChild(list.nodeType ? list : document.createTextNode(String(list)));
    })(kids);
    return e;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); return node; }
  function $(sel, ctx) { return (ctx || document).querySelector(sel); }

  // ---- icons: 24x24 strokes, drawn from the same small set ----
  var PATHS = {
    chat: 'M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z',
    hash: 'M5 9h14M5 15h14M10 4 8 20M16 4l-2 16',
    users: 'M16 20v-1a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v1M9.5 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM21 20v-1a4 4 0 0 0-3-3.9M16 4.1a3.5 3.5 0 0 1 0 6.8',
    map: 'M9 4 3 6.5v14L9 18l6 2.5 6-2.5v-14L15 6.5 9 4zM9 4v14M15 6.5v14',
    tools: 'M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4 2.6-2.6z',
    gear: 'M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
    send: 'M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z',
    back: 'M15 18l-6-6 6-6',
    search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3',
    star: 'M12 2l3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1z',
    plus: 'M12 5v14M5 12h14',
    trash: 'M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6',
    refresh: 'M21 12a9 9 0 0 1-15.5 6.2M3 12A9 9 0 0 1 18.5 5.8M18 2v4h-4M6 22v-4h4',
    antenna: 'M12 12v9M8 21h8M7.8 7.8a6 6 0 0 0 0 8.4M16.2 7.8a6 6 0 0 1 0 8.4M4.9 4.9a10 10 0 0 0 0 14.2M19.1 4.9a10 10 0 0 1 0 14.2M12 13a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z',
    check: 'M20 6 9 17l-5-5',
    checks: 'M2 13l4 4L16 7M10 14l3 3L23 7',
    x: 'M18 6 6 18M6 6l12 12',
    more: 'M12 6h.01M12 12h.01M12 18h.01',
    lock: 'M6 11h12v10H6zM8 11V7a4 4 0 0 1 8 0v4',
    globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18',
    wifi: 'M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M2 9a15 15 0 0 1 20 0M12 20h.01',
    battery: 'M3 8h15v8H3zM21 11v2M6 11v2',
    signal: 'M4 20v-3M9 20v-7M14 20v-11M19 20V4',
    pin: 'M12 22s7-6.2 7-12a7 7 0 0 0-14 0c0 5.8 7 12 7 12zM12 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
    copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
    reply: 'M9 14 4 9l5-5M4 9h10a6 6 0 0 1 6 6v3',
    route: 'M6 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM18 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM8 17h6a4 4 0 0 0 0-8h-4a4 4 0 0 1 0-8',
    radio: 'M4 9h16v11H4zM8 9l9-5M8 14h4M16 14h.01M16 17h.01',
    cell: 'M12 10v11M8 21h8M9 6a4 4 0 0 1 6 0M6.5 3.5a8 8 0 0 1 11 0M12 8.5a1 1 0 1 0 0-2 1 1 0 0 0 0 2z',
    door: 'M4 21V4h11v17M2 21h20M11 12h.01',
    sensor: 'M12 3v3M12 18v3M3 12h3M18 12h3M6 6l2 2M16 16l2 2M6 18l2-2M16 8l2-2M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
    clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
    info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 16v-5M12 8h.01',
    warn: 'M12 3 2 20h20L12 3zM12 10v4M12 17h.01',
    bell: 'M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9zM10 21a2 2 0 0 0 4 0',
    bellOff: 'M13.7 21a2 2 0 0 1-3.4 0M18 8a6 6 0 0 0-9.3-5M6.3 6.3A6 6 0 0 0 6 8c0 7-3 9-3 9h14M1 1l22 22',
    terminal: 'M4 17l6-6-6-6M12 19h8',
    download: 'M12 3v12M7 10l5 5 5-5M4 21h16',
    upload: 'M12 15V3M7 8l5-5 5 5M4 21h16',
    power: 'M12 2v10M18.4 6.6a9 9 0 1 1-12.8 0',
    dots: 'M5 12h.01M12 12h.01M19 12h.01'
  };
  function icon(name, size) {
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('width', size || 20); svg.setAttribute('height', size || 20);
    svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '1.8');
    svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round'); svg.setAttribute('aria-hidden', 'true');
    var p = document.createElementNS('http://www.w3.org/2000/svg', 'path'); p.setAttribute('d', PATHS[name] || PATHS.info);
    svg.appendChild(p); return svg;
  }
  function btn(label, opts) {
    opts = opts || {};
    var b = el('button', { class: 'btn ' + (opts.kind || ''), type: opts.type || 'button', title: opts.title, 'aria-label': opts.title || label || opts.icon, onclick: opts.onclick, disabled: opts.disabled });
    if (opts.icon) b.appendChild(icon(opts.icon, opts.size));
    if (label) b.appendChild(el('span', { text: label }));
    return b;
  }

  // ---- avatars: a coloured circle from a hash of the name, or the leading emoji ----
  var HUES = [210, 340, 28, 160, 262, 190, 8, 120, 300, 50];
  function hueOf(s) { var h = 0; for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return HUES[h % HUES.length]; }
  function firstGlyph(name) {
    var m = /^(\p{Extended_Pictographic}(?:‍\p{Extended_Pictographic}|️)*)/u.exec(name || '');
    if (m) return m[1];
    var t = String(name || '?').replace(/^[^\p{L}\p{N}]+/u, '');
    return (Array.from(t)[0] || '?').toUpperCase();
  }
  function avatar(name, opts) {
    opts = opts || {};
    var a = el('div', { class: 'avatar' + (opts.cls ? ' ' + opts.cls : ''), 'aria-hidden': 'true' });
    if (opts.icon) { a.appendChild(icon(opts.icon, 20)); a.style.setProperty('--h', opts.hue != null ? opts.hue : hueOf(name || '')); }
    else { a.textContent = firstGlyph(name); a.style.setProperty('--h', hueOf(name || '')); }
    if (opts.size) a.style.setProperty('--s', opts.size + 'px');
    return a;
  }

  // ---- toasts ----
  var toastBox;
  function toast(text, kind) {
    if (!toastBox) { toastBox = el('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' }); document.body.appendChild(toastBox); }
    var t = el('div', { class: 'toast ' + (kind || ''), text: text }); toastBox.appendChild(t);
    setTimeout(function () { t.classList.add('out'); setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 300); }, kind === 'bad' ? 6000 : 3200);
  }

  // ---- dialogs: a modal layer with a title, a body and buttons. close() resolves the promise ----
  function dialog(title, body, buttons, opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var layer = el('div', { class: 'layer', onmousedown: function (e) { if (e.target === layer && !opts.sticky) finish(undefined); } });
      var box = el('div', { class: 'dialog' + (opts.wide ? ' wide' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': title });
      var head = el('div', { class: 'dhead' }, [el('h2', { text: title }), btn('', { icon: 'x', title: 'Close', kind: 'ghost', onclick: function () { finish(undefined); } })]);
      var foot = el('div', { class: 'dfoot' });
      function finish(v) { document.removeEventListener('keydown', onKey, true); if (layer.parentNode) layer.parentNode.removeChild(layer); resolve(v); }
      function onKey(e) { if (e.key === 'Escape') { e.stopPropagation(); finish(undefined); } }
      (buttons || []).forEach(function (b) {
        var bt = btn(b.label, { kind: b.kind || '', onclick: function () { var r = b.run ? b.run(box) : b.value; if (r === false) return; finish(r === undefined ? b.value : r); } });
        foot.appendChild(bt);
      });
      box.appendChild(head); box.appendChild(el('div', { class: 'dbody' }, body)); if (buttons && buttons.length) box.appendChild(foot);
      layer.appendChild(box); document.body.appendChild(layer); document.addEventListener('keydown', onKey, true);
      var first = box.querySelector('input,select,textarea') || foot.lastChild; if (first && first.focus) first.focus();
      box._finish = finish;
    });
  }
  function confirmBox(title, text, okLabel, danger) {
    return dialog(title, el('p', { text: text }), [{ label: 'Cancel', value: false }, { label: okLabel || 'OK', kind: danger ? 'danger' : 'primary', value: true }]).then(function (v) { return v === true; });
  }
  function alertBox(title, body) { return dialog(title, body, [{ label: 'Close', kind: 'primary', value: true }]); }
  // fields: [{name,label,type,value,hint,options,required,min,max,maxlength,pattern}] -> resolves {name:value} or null
  function formBox(title, fields, okLabel, intro) {
    var inputs = {}, rows = fields.map(function (f) {
      var inp;
      if (f.options) inp = el('select', { id: 'f-' + f.name }, f.options.map(function (o) { return el('option', { value: o.value != null ? o.value : o, text: o.label || o, selected: String(o.value != null ? o.value : o) === String(f.value) }); }));
      else if (f.type === 'check') inp = el('input', { type: 'checkbox', id: 'f-' + f.name, checked: !!f.value });
      else if (f.type === 'textarea') inp = el('textarea', { id: 'f-' + f.name, rows: f.rows || 4, value: f.value || '', maxlength: f.maxlength, spellcheck: 'false' });
      else inp = el('input', { id: 'f-' + f.name, type: f.type || 'text', value: f.value != null ? f.value : '', maxlength: f.maxlength, min: f.min, max: f.max, step: f.step, autocomplete: 'off', spellcheck: 'false', placeholder: f.placeholder });
      inputs[f.name] = inp;
      return el('label', { class: 'field' + (f.type === 'check' ? ' check' : ''), for: 'f-' + f.name }, [el('span', { class: 'lbl', text: f.label }), inp, f.hint ? el('small', { text: f.hint }) : null]);
    });
    var form = el('form', { class: 'form', onsubmit: function (e) { e.preventDefault(); box._ok.click(); } }, [intro ? el('p', { class: 'dim', text: intro }) : null, rows]);
    var box;
    var p = dialog(title, form, [{ label: 'Cancel', value: null }, { label: okLabel || 'Save', kind: 'primary', run: function () {
      var out = {};
      for (var i = 0; i < fields.length; i++) {
        var f = fields[i], inp = inputs[f.name];
        out[f.name] = f.type === 'check' ? inp.checked : inp.value;
        if (f.required && !String(out[f.name]).trim()) { toast(f.label + ' is needed', 'bad'); inp.focus(); return false; }
        if (f.validate) { var msg = f.validate(out[f.name]); if (msg) { toast(msg, 'bad'); inp.focus(); return false; } }
      }
      return out;
    } }]);
    box = document.querySelector('.layer:last-child .dialog'); if (box) box._ok = box.querySelector('.dfoot .btn.primary');
    return p;
  }
  // a floating action menu next to an anchor element
  function menu(anchor, items) {
    var old = document.querySelector('.menu'); if (old) old.remove();
    var m = el('div', { class: 'menu', role: 'menu' });
    function close() { if (m.parentNode) m.parentNode.removeChild(m); document.removeEventListener('mousedown', away, true); document.removeEventListener('keydown', esc, true); }
    function away(e) { if (!m.contains(e.target)) close(); }
    function esc(e) { if (e.key === 'Escape') close(); }
    items.forEach(function (it) {
      if (!it) return;
      if (it.sep) { m.appendChild(el('hr')); return; }
      var b = el('button', { class: 'mi' + (it.danger ? ' danger' : ''), role: 'menuitem', type: 'button', onclick: function () { close(); it.run(); } }, [it.icon ? icon(it.icon, 16) : el('span', { class: 'gap' }), el('span', { text: it.label })]);
      m.appendChild(b);
    });
    document.body.appendChild(m);
    var r = anchor.getBoundingClientRect(), mw = m.offsetWidth, mh = m.offsetHeight;
    m.style.left = Math.max(8, Math.min(innerWidth - mw - 8, r.right - mw)) + 'px';
    m.style.top = (r.bottom + mh + 8 > innerHeight ? Math.max(8, r.top - mh - 4) : r.bottom + 4) + 'px';
    setTimeout(function () { document.addEventListener('mousedown', away, true); document.addEventListener('keydown', esc, true); }, 0);
    var f = m.querySelector('.mi'); if (f) f.focus();
    return close;
  }

  // ---- text helpers ----
  function ago(secs) {
    if (!secs) return 'never';
    var d = Math.max(0, Math.floor(Date.now() / 1000) - secs);
    if (d < 45) return 'now';
    if (d < 3600) return Math.round(d / 60) + ' min ago';
    if (d < 86400) { var h = Math.round(d / 3600); return h + (h === 1 ? ' hour ago' : ' hours ago'); }
    var n = Math.round(d / 86400); return n + (n === 1 ? ' day ago' : ' days ago');
  }
  function clock(secs) { var d = new Date(secs * 1000); return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
  function dayLabel(secs) {
    var d = new Date(secs * 1000), t = new Date(), y = new Date(Date.now() - 864e5);
    if (d.toDateString() === t.toDateString()) return 'Today';
    if (d.toDateString() === y.toDateString()) return 'Yesterday';
    return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  }
  function dur(secs) {
    secs = Math.floor(secs); var d = Math.floor(secs / 86400), h = Math.floor(secs % 86400 / 3600), m = Math.floor(secs % 3600 / 60);
    return d ? d + 'd ' + h + 'h' : h ? h + 'h ' + m + 'm' : m ? m + 'm ' + (secs % 60) + 's' : secs + 's';
  }
  function short(key) { return key.slice(0, 8) + '…' + key.slice(-6); }
  // clipboard.writeText needs a secure origin; the node is served over plain http, so fall back to a selection
  function copy(text) {
    function fallback() {
      var t = el('textarea', { value: text, style: 'position:fixed;opacity:0;top:0' }); document.body.appendChild(t); t.select();
      var ok = false; try { ok = document.execCommand('copy'); } catch (e) { } t.remove(); return ok;
    }
    function viaSelection() { if (fallback()) toast('Copied'); else toast('Could not copy', 'bad'); }
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text).then(function () { toast('Copied'); }, viaSelection);
    viaSelection();
    return Promise.resolve();
  }
  function download(name, text, type) {
    var a = el('a', { href: URL.createObjectURL(new Blob([text], { type: type || 'text/plain' })), download: name });
    document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }
  var URL_RE = /(https?:\/\/[^\s<>"']+)/g;
  // text with web links made clickable; every piece is a text node or an anchor built from the matched text, never markup
  function linkify(text) {
    var frag = document.createDocumentFragment(), last = 0, m;
    URL_RE.lastIndex = 0;
    while ((m = URL_RE.exec(text))) {
      if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      var url = m[1].replace(/[.,;:!?)]+$/, '');
      frag.appendChild(el('a', { href: url, target: '_blank', rel: 'noopener noreferrer', text: url }));
      last = m.index + url.length; URL_RE.lastIndex = last;
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    return frag;
  }

  root.UI = { el: el, $: $, clear: clear, icon: icon, btn: btn, avatar: avatar, toast: toast, dialog: dialog, confirm: confirmBox, alert: alertBox,
    form: formBox, menu: menu, ago: ago, clock: clock, dayLabel: dayLabel, dur: dur, short: short, copy: copy, download: download,
    linkify: linkify, hueOf: hueOf, firstGlyph: firstGlyph };
})(window);
