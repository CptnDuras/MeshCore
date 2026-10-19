// Decodes captured frames from fixtures.json and checks every expected field.
// Fixtures come from the stock companion firmware run on a host (see oracle/compare_webui.py in meshnode).
'use strict';
const fs = require('fs'), path = require('path');
const MC = require('../proto.js');
const fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures.json'), 'utf8'));
let bad = 0;
for (const c of fx) {
  const got = MC.dec(Uint8Array.from(Buffer.from(c.hex, 'hex')));
  for (const [k, want] of Object.entries(c.expect)) {
    if (JSON.stringify(got[k]) !== JSON.stringify(want)) { bad++; console.log('FAIL', c.name, k, 'got', got[k], 'want', want); }
  }
}
console.log(`${fx.length} fixtures, ${bad} field mismatches`);
process.exit(bad ? 1 : 0);
