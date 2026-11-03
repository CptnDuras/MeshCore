// Merging the node's history into what the browser has must keep the order the messages arrived in, wherever the browser is missing some.
'use strict';
const assert = require('assert');
const fs = require('fs');
const src = fs.readFileSync(__dirname + '/../src/core.js', 'utf8');
const from = src.indexOf('  function sameMsg'), to = src.indexOf('  // One record from the node');
assert(from > 0 && to > from, 'merge functions not found in core.js');
const S = { convs: {} };
const mergeInOrder = new Function('S', src.slice(from, to) + '; return mergeInOrder;')(S);

const msg = t => ({ me: false, ts: t.charCodeAt(0), text: t, who: 'w' });
function run(browser, node, tail) {
  S.convs = { c: browser.split('').map(msg) };
  mergeInOrder('c', node.split('').map(msg), tail);
  return S.convs.c.map(m => m.text).join('');
}

assert.strictEqual(run('acd', 'abcd', true), 'abcd', 'a message the browser missed goes after its predecessor');
assert.strictEqual(run('cd', 'abcd', false), 'abcd', 'older messages go before the first the browser has');
assert.strictEqual(run('cd', 'abcd', true), 'abcd', 'with the newest first, the missing ones before a known one still go before it');
assert.strictEqual(run('xy', 'pq', true), 'xypq', 'nothing in common, newest: after what the browser has');
assert.strictEqual(run('xy', 'pq', false), 'pqxy', 'nothing in common, older: before what the browser has');
assert.strictEqual(run('', 'abc', true), 'abc', 'an empty conversation takes the lot');
assert.strictEqual(run('abc', 'abc', true), 'abc', 'nothing new changes nothing');
assert.strictEqual(run('abef', 'abcdef', true), 'abcdef', 'a gap in the middle is filled in place');
assert.strictEqual(run('abcd', 'cdef', true), 'abcdef', 'newer messages go at the end');
assert.strictEqual(run('axb', 'abc', true), 'axbc', 'a message only the browser has stays where it was');

console.log('merge_order: ok');
