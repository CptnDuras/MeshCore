// SHA-256 and HMAC-SHA-256 in plain JavaScript. The page is served over http on the local network, where the browser's
// crypto.subtle does not exist, and hashtag channels and communities need these hashes.
(function (root) {
  'use strict';
  var K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);

  function sha256(data) {
    var n = data.length, total = ((n + 9 + 63) >> 6) << 6, m = new Uint8Array(total), i, j;
    m.set(data); m[n] = 0x80;
    var bits = n * 8; m[total - 4] = bits >>> 24; m[total - 3] = bits >>> 16; m[total - 2] = bits >>> 8; m[total - 1] = bits;
    m[total - 8] = Math.floor(n / 0x20000000) & 255;
    var h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    var w = new Uint32Array(64);
    for (var off = 0; off < total; off += 64) {
      for (i = 0; i < 16; i++) w[i] = m[off + 4 * i] << 24 | m[off + 4 * i + 1] << 16 | m[off + 4 * i + 2] << 8 | m[off + 4 * i + 3];
      for (i = 16; i < 64; i++) {
        var a0 = w[i - 15], a1 = w[i - 2];
        var s0 = (a0 >>> 7 | a0 << 25) ^ (a0 >>> 18 | a0 << 14) ^ (a0 >>> 3), s1 = (a1 >>> 17 | a1 << 15) ^ (a1 >>> 19 | a1 << 13) ^ (a1 >>> 10);
        w[i] = w[i - 16] + s0 + w[i - 7] + s1;
      }
      var a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
      for (j = 0; j < 64; j++) {
        var S1 = (e >>> 6 | e << 26) ^ (e >>> 11 | e << 21) ^ (e >>> 25 | e << 7), ch = (e & f) ^ (~e & g);
        var t1 = hh + S1 + ch + K[j] + w[j];
        var S0 = (a >>> 2 | a << 30) ^ (a >>> 13 | a << 19) ^ (a >>> 22 | a << 10), mj = (a & b) ^ (a & c) ^ (b & c);
        var t2 = S0 + mj;
        hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
    }
    var out = new Uint8Array(32);
    for (i = 0; i < 8; i++) { out[4 * i] = h[i] >>> 24; out[4 * i + 1] = h[i] >>> 16; out[4 * i + 2] = h[i] >>> 8; out[4 * i + 3] = h[i]; }
    return out;
  }

  function hmac(key, data) {
    if (key.length > 64) key = sha256(key);
    var ip = new Uint8Array(64 + data.length), op = new Uint8Array(96), i;
    for (i = 0; i < 64; i++) { var kb = i < key.length ? key[i] : 0; ip[i] = kb ^ 0x36; op[i] = kb ^ 0x5c; }
    ip.set(data, 64); op.set(sha256(ip), 64);
    return sha256(op);
  }

  var te = new TextEncoder();
  function str(s) { return te.encode(s); }

  // The first 16 bytes of the SHA-256 of a hashtag name, e.g. "#hiking": the channel key every client derives the same way.
  function hashtagKey(tag) { return sha256(str(tag.charAt(0) === '#' ? tag : '#' + tag)).subarray(0, 16); }
  var PUBLIC_KEY_HEX = '8b3387e9c5cdea6ac9e5edbaa115cd72';
  // Community channel keys: HMAC-SHA-256(secret, "channel:v1:" + name), first 16 bytes. Names are lower case without the #.
  function communityKey(secret, name) { return hmac(secret, str('channel:v1:' + name.trim().replace(/^#/, '').toLowerCase().trim())).subarray(0, 16); }
  function communityPublicKey(secret) { return hmac(secret, str('channel:v1:__public__')).subarray(0, 16); }
  // The id shown for a community: SHA-256("community:v1" + secret), first 8 hex characters are used on screen
  function communityId(secret) { var p = str('community:v1'), d = new Uint8Array(p.length + secret.length); d.set(p); d.set(secret, p.length); return sha256(d); }
  // The key a flood scope (region) is sent under: first 16 bytes of the SHA-256 of "#region"
  function regionKey(name) { return sha256(str(name.charAt(0) === '#' ? name : '#' + name)).subarray(0, 16); }

  var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  function b64(bytes) {
    var s = '', i;
    for (i = 0; i + 2 < bytes.length; i += 3) s += B64[bytes[i] >> 2] + B64[(bytes[i] & 3) << 4 | bytes[i + 1] >> 4] + B64[(bytes[i + 1] & 15) << 2 | bytes[i + 2] >> 6] + B64[bytes[i + 2] & 63];
    if (i + 1 === bytes.length) s += B64[bytes[i] >> 2] + B64[(bytes[i] & 3) << 4] + '==';
    else if (i + 2 === bytes.length) s += B64[bytes[i] >> 2] + B64[(bytes[i] & 3) << 4 | bytes[i + 1] >> 4] + B64[(bytes[i + 1] & 15) << 2] + '=';
    return s;
  }
  function unb64(s) {
    s = s.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
    var out = [], acc = 0, bits = 0;
    for (var i = 0; i < s.length; i++) {
      var v = B64.indexOf(s[i]); if (v < 0) continue;
      acc = acc << 6 | v; bits += 6;
      if (bits >= 8) { bits -= 8; out.push(acc >> bits & 255); }
    }
    return new Uint8Array(out);
  }
  function randomBytes(n) { var a = new Uint8Array(n); (root.crypto || { getRandomValues: function (x) { for (var i = 0; i < x.length; i++) x[i] = Math.random() * 256; } }).getRandomValues(a); return a; }

  var api = { sha256: sha256, hmac: hmac, hashtagKey: hashtagKey, communityKey: communityKey, communityPublicKey: communityPublicKey,
    communityId: communityId, PUBLIC_KEY_HEX: PUBLIC_KEY_HEX, regionKey: regionKey, b64: b64, unb64: unb64, randomBytes: randomBytes };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.MCrypto = api;
})(typeof self !== 'undefined' ? self : this);
