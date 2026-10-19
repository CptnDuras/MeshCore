// Companion protocol codec (the frames the phone apps exchange with the node).
// Pure functions on Uint8Array: no DOM, no network, so it runs in a browser and under node.
(function (root) {
  'use strict';

  var CMD = { APP_START: 1, SEND_TXT: 2, SEND_CHAN_TXT: 3, GET_CONTACTS: 4, GET_TIME: 5, SET_TIME: 6,
    ADVERT: 7, SYNC_NEXT: 10, BATT: 20, DEVICE_QUERY: 22, GET_CHANNEL: 31, CLI: 66 };
  var RESP = { OK: 0, ERR: 1, CONTACTS_START: 2, CONTACT: 3, CONTACTS_END: 4, SELF_INFO: 5, SENT: 6,
    CONTACT_MSG: 7, CHANNEL_MSG: 8, TIME: 9, NO_MORE: 10, BATT: 12, DEVICE_INFO: 13,
    CONTACT_MSG_V3: 16, CHANNEL_MSG_V3: 17, CHANNEL_INFO: 18, CLI_REPLY: 29 };
  var PUSH = { ADVERT: 0x80, PATH_UPDATED: 0x81, SEND_CONFIRMED: 0x82, MSG_WAITING: 0x83,
    NEW_ADVERT: 0x8a, CONTACT_DELETED: 0x8f, CONTACTS_FULL: 0x90 };
  var PROTO_VER = 3;          // asks for the V3 message frames (carry SNR)
  var NAME_LEN = 32, KEY_LEN = 32, PATH_LEN = 64;
  var MAX_TEXT = 160;         // longest message text that fits one frame with margin

  var utf8 = new TextEncoder(), utf8d = new TextDecoder('utf-8', { fatal: false });

  function u32(v, o) { return (v[o] | v[o + 1] << 8 | v[o + 2] << 16 | v[o + 3] << 24) >>> 0; }
  function i32(v, o) { return v[o] | v[o + 1] << 8 | v[o + 2] << 16 | v[o + 3] << 24; }
  function i8(b) { return b > 127 ? b - 256 : b; }
  function hex(v, o, n) { var s = ''; for (var i = 0; i < n; i++) s += (v[o + i] < 16 ? '0' : '') + v[o + i].toString(16); return s; }
  function cstr(v, o, n) { var e = o; while (e < o + n && v[e] !== 0) e++; return utf8d.decode(v.subarray(o, e)); }
  function putU32(a, o, x) { a[o] = x & 255; a[o + 1] = x >>> 8 & 255; a[o + 2] = x >>> 16 & 255; a[o + 3] = x >>> 24 & 255; }
  function unhex(s) { var a = new Uint8Array(s.length / 2); for (var i = 0; i < a.length; i++) a[i] = parseInt(s.substr(i * 2, 2), 16); return a; }

  // Cut a string to at most n bytes of UTF-8 without splitting a character.
  function clipUtf8(s, n) {
    var b = utf8.encode(s);
    if (b.length <= n) return b;
    var end = n;
    while (end > 0 && (b[end] & 0xc0) === 0x80) end--;
    return b.subarray(0, end);
  }

  function frame(code, parts) {
    var n = 1, i;
    for (i = 0; i < parts.length; i++) n += parts[i].length;
    var f = new Uint8Array(n); f[0] = code; var o = 1;
    for (i = 0; i < parts.length; i++) { f.set(parts[i], o); o += parts[i].length; }
    return f;
  }
  function word(x) { var a = new Uint8Array(4); putU32(a, 0, x >>> 0); return a; }

  var enc = {
    deviceQuery: function () { return frame(CMD.DEVICE_QUERY, [Uint8Array.of(PROTO_VER)]); },
    appStart: function (name) { return frame(CMD.APP_START, [new Uint8Array(7), clipUtf8(name || 'web', 30)]); },
    getContacts: function (since) { return since ? frame(CMD.GET_CONTACTS, [word(since)]) : Uint8Array.of(CMD.GET_CONTACTS); },
    syncNext: function () { return Uint8Array.of(CMD.SYNC_NEXT); },
    getTime: function () { return Uint8Array.of(CMD.GET_TIME); },
    setTime: function (secs) { return frame(CMD.SET_TIME, [word(secs)]); },
    advert: function (flood) { return frame(CMD.ADVERT, flood ? [Uint8Array.of(1)] : []); },
    battery: function () { return Uint8Array.of(CMD.BATT); },
    getChannel: function (i) { return frame(CMD.GET_CHANNEL, [Uint8Array.of(i)]); },
    // pubkeyHex: at least the first 12 hex characters (6 bytes)
    sendText: function (pubkeyHex, text, ts, attempt) {
      return frame(CMD.SEND_TXT, [Uint8Array.of(0, attempt || 0), word(ts), unhex(pubkeyHex.slice(0, 12)), clipUtf8(text, MAX_TEXT)]);
    },
    sendChannel: function (idx, text, ts) {
      return frame(CMD.SEND_CHAN_TXT, [Uint8Array.of(0, idx), word(ts), clipUtf8(text, MAX_TEXT)]);
    },
    cli: function (text) { return frame(CMD.CLI, [clipUtf8(text, 150)]); }
  };

  function contact(v) {
    return { key: hex(v, 1, KEY_LEN), type: v[33], flags: v[34], pathLen: v[35],
      name: cstr(v, 36 + PATH_LEN, NAME_LEN), lastAdvert: u32(v, 36 + PATH_LEN + NAME_LEN),
      lat: i32(v, 40 + PATH_LEN + NAME_LEN) / 1e6, lon: i32(v, 44 + PATH_LEN + NAME_LEN) / 1e6,
      lastMod: v.length >= 52 + PATH_LEN + NAME_LEN ? u32(v, 48 + PATH_LEN + NAME_LEN) : 0 };
  }

  // Returns {t: kind, ...fields}. Unknown frames come back as {t:'unknown', code}.
  function dec(v) {
    var c = v[0], o;
    switch (c) {
      case RESP.OK: return { t: 'ok' };
      case RESP.ERR: return { t: 'err', code: v[1] };
      case RESP.CONTACTS_START: return { t: 'contactsStart', count: u32(v, 1) };
      case RESP.CONTACT: return Object.assign({ t: 'contact' }, contact(v));
      case PUSH.NEW_ADVERT: return Object.assign({ t: 'newAdvert' }, contact(v));
      case RESP.CONTACTS_END: return { t: 'contactsEnd', lastMod: u32(v, 1) };
      case RESP.SELF_INFO:
        return { t: 'self', advType: v[1], txPower: v[2], maxTxPower: v[3], key: hex(v, 4, KEY_LEN),
          lat: i32(v, 36) / 1e6, lon: i32(v, 40) / 1e6, multiAcks: v[44], advertLoc: v[45], telemetry: v[46],
          manualAdd: v[47], freqKHz: u32(v, 48) / 1000, bwKHz: u32(v, 52) / 1000, sf: v[56], cr: v[57],
          name: utf8d.decode(v.subarray(58)) };
      case RESP.DEVICE_INFO:
        return { t: 'device', fwVer: v[1], maxContacts: v[2] * 2, maxChannels: v[3], build: cstr(v, 8, 12),
          maker: cstr(v, 20, 40), version: cstr(v, 60, 20), repeat: v[80], pathHashMode: v[81] };
      case RESP.SENT: return { t: 'sent', flood: v[1] === 1, ack: u32(v, 2), timeoutMs: u32(v, 6) };
      case PUSH.SEND_CONFIRMED: return { t: 'delivered', ack: u32(v, 1), tripMs: u32(v, 5) };
      case PUSH.MSG_WAITING: return { t: 'msgWaiting' };
      case PUSH.ADVERT: return { t: 'advert', key: hex(v, 1, KEY_LEN) };
      case PUSH.PATH_UPDATED: return { t: 'pathUpdated', key: hex(v, 1, KEY_LEN) };
      case PUSH.CONTACT_DELETED: return { t: 'contactDeleted', key: hex(v, 1, KEY_LEN) };
      case PUSH.CONTACTS_FULL: return { t: 'contactsFull' };
      case RESP.NO_MORE: return { t: 'noMore' };
      case RESP.TIME: return { t: 'time', secs: u32(v, 1) };
      case RESP.BATT: return { t: 'battery', mv: v[1] | v[2] << 8, usedKb: u32(v, 3), totalKb: u32(v, 7) };
      case RESP.CHANNEL_INFO: return { t: 'channel', idx: v[1], name: cstr(v, 2, NAME_LEN), secret: hex(v, 34, 16) };
      case RESP.CLI_REPLY: return { t: 'cli', text: utf8d.decode(v.subarray(1)) };
      case RESP.CONTACT_MSG_V3: case RESP.CONTACT_MSG:
        o = c === RESP.CONTACT_MSG_V3 ? 4 : 1;
        var snr = c === RESP.CONTACT_MSG_V3 ? i8(v[1]) / 4 : null;
        var kind = v[o + 7];
        var tx = o + 12 + (kind === 2 ? 4 : 0);   // signed text carries 4 extra bytes
        return { t: 'msg', channel: false, snr: snr, from: hex(v, o, 6), pathLen: v[o + 6], kind: kind,
          ts: u32(v, o + 8), text: utf8d.decode(v.subarray(tx)) };
      case RESP.CHANNEL_MSG_V3: case RESP.CHANNEL_MSG:
        o = c === RESP.CHANNEL_MSG_V3 ? 4 : 1;
        return { t: 'msg', channel: true, snr: c === RESP.CHANNEL_MSG_V3 ? i8(v[1]) / 4 : null, idx: v[o],
          pathLen: v[o + 1], kind: v[o + 2], ts: u32(v, o + 3), text: utf8d.decode(v.subarray(o + 7)) };
      default: return { t: 'unknown', code: c };
    }
  }

  var api = { CMD: CMD, RESP: RESP, PUSH: PUSH, enc: enc, dec: dec, hex: hex, unhex: unhex, clipUtf8: clipUtf8, MAX_TEXT: MAX_TEXT };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.MC = api;
})(typeof self !== 'undefined' ? self : this);
