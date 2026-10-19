// A list on the left, a detail pane on the right; on a phone one at a time.
(function (root) {
  'use strict';
  var el = UI.el;
  function make(box, title) {
    var head = el('div', { class: 'lhead' }, [el('h1', { text: title })]);
    var q = el('input', { type: 'search', placeholder: 'Search', 'aria-label': 'Search ' + title, autocomplete: 'off' });
    var search = el('div', { class: 'search' }, [UI.icon('search', 16), q]);
    var tools = el('div', { class: 'tools' }, [search]);
    var rows = el('div', { class: 'rows', role: 'list' });
    var list = el('div', { class: 'list' }, [head, tools, rows]);
    var detail = el('div', { class: 'detail' });
    var split = el('div', { class: 'split' }, [list, detail]);
    box.appendChild(split);
    var debounce;
    return { split: split, list: list, head: head, tools: tools, rows: rows, detail: detail, search: q,
      onSearch: function (fn) { q.addEventListener('input', function () { clearTimeout(debounce); debounce = setTimeout(fn, 120); }); },
      open: function (on) { split.classList.toggle('open', !!on); },
      placeholder: function (icon, h, p) { UI.clear(detail); detail.appendChild(el('div', { class: 'empty' }, [UI.icon(icon, 38), el('h3', { text: h }), el('p', { text: p })])); } };
  }
  root.Split = { make: make };
})(window);
