// The set-time frame the page sends must agree with the firmware's rule (src/helpers/ClockPolicy.h, clockSetForced):
// five bytes (command, 4 bytes of seconds) normally, and a sixth byte of 1 only when the sender forces the time.
'use strict';
const assert = require('assert');
const MC = require('../src/proto.js');
const T = 1700000200;

const plain = MC.enc.setTime(T);
assert.strictEqual(plain.length, 5, 'an ordinary set-time frame is five bytes, as stock apps send');
assert.strictEqual(plain[0], 6);
assert.strictEqual(Buffer.from(plain).readUInt32LE(1), T);

for (const off of [undefined, false, 0, null]) {
  assert.strictEqual(MC.enc.setTime(T, off).length, 5, 'force=' + off + ' must not add a sixth byte');
}

const forced = MC.enc.setTime(T, true);
assert.strictEqual(forced.length, 6, 'a forced frame has a sixth byte');
assert.strictEqual(forced[5], 1, 'the sixth byte is 1');
assert.deepStrictEqual(Array.from(forced.slice(0, 5)), Array.from(plain), 'the first five bytes are the same either way');

console.log('set_time: ok');
