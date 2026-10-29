// Companion protocol codec (the frames the phone apps exchange with the node).
// Pure functions on Uint8Array: no DOM, no network, so it runs in a browser and under node.
(function (root) {
  'use strict';

  var CMD = { APP_START: 1, SEND_TXT: 2, SEND_CHAN_TXT: 3, GET_CONTACTS: 4, GET_TIME: 5, SET_TIME: 6,
    ADVERT: 7, SET_NAME: 8, ADD_CONTACT: 9, SYNC_NEXT: 10, SET_RADIO: 11, SET_TX_POWER: 12, RESET_PATH: 13,
    SET_LATLON: 14, REMOVE_CONTACT: 15, SHARE_CONTACT: 16, EXPORT_CONTACT: 17, IMPORT_CONTACT: 18, REBOOT: 19,
    BATT: 20, SET_TUNING: 21, DEVICE_QUERY: 22, LOGIN: 26, STATUS_REQ: 27, LOGOUT: 29, GET_CHANNEL: 31, SET_CHANNEL: 32,
    TRACE: 36, SET_OTHER: 38, TELEMETRY_REQ: 39, GET_VARS: 40, SET_VAR: 41, ADVERT_PATH: 42, GET_TUNING: 43,
    BINARY_REQ: 50, PATH_DISCOVERY: 52, SET_SCOPE: 54, CONTROL: 55, GET_STATS: 56, ANON_REQ: 57, SET_AUTOADD: 58,
    GET_AUTOADD: 59, GET_REPEAT_FREQ: 60, SET_HASH_MODE: 61, SET_DEFAULT_SCOPE: 63, GET_DEFAULT_SCOPE: 64, CLI: 66, GET_HISTORY: 67, CLEAR_HISTORY: 68 };
  var RESP = { OK: 0, ERR: 1, CONTACTS_START: 2, CONTACT: 3, CONTACTS_END: 4, SELF_INFO: 5, SENT: 6,
    CONTACT_MSG: 7, CHANNEL_MSG: 8, TIME: 9, NO_MORE: 10, EXPORT: 11, BATT: 12, DEVICE_INFO: 13, DISABLED: 15,
    CONTACT_MSG_V3: 16, CHANNEL_MSG_V3: 17, CHANNEL_INFO: 18, VARS: 21, ADVERT_PATH: 22, TUNING: 23, STATS: 24,
    AUTOADD: 25, REPEAT_FREQ: 26, DEFAULT_SCOPE: 28, CLI_REPLY: 29, HISTORY: 30 };
  var PUSH = { ADVERT: 0x80, PATH_UPDATED: 0x81, SEND_CONFIRMED: 0x82, MSG_WAITING: 0x83, LOGIN_OK: 0x85, LOGIN_FAIL: 0x86,
    STATUS: 0x87, LOG_RX: 0x88, TRACE: 0x89, NEW_ADVERT: 0x8a, TELEMETRY: 0x8b, BINARY: 0x8c, PATH_DISCOVERY: 0x8d,
    CONTROL: 0x8e, CONTACT_DELETED: 0x8f, CONTACTS_FULL: 0x90 };
  var ERR = { UNSUPPORTED: 1, NOT_FOUND: 2, TABLE_FULL: 3, BAD_STATE: 4, FILE_IO: 5, ILLEGAL_ARG: 6 };
  var ERR_TEXT = { 1: 'not supported by this firmware', 2: 'not found', 3: 'table full', 4: 'busy, try again',
    5: 'storage error', 6: 'value not accepted' };
  var TYPE = { CHAT: 1, REPEATER: 2, ROOM: 3, SENSOR: 4 };
  var PROTO_VER = 4;          // asks for the V3 message frames (carry SNR)
  var NAME_LEN = 32, KEY_LEN = 32, PATH_LEN = 64;
  var MAX_TEXT = 160;         // longest message text that fits one frame with margin
  var FLOOD = 255;            // path length of a contact with no known route

  var utf8 = new TextEncoder(), utf8d = new TextDecoder('utf-8', { fatal: false });

  function u16(v, o) { return v[o] | v[o + 1] << 8; }
  function u32(v, o) { return (v[o] | v[o + 1] << 8 | v[o + 2] << 16 | v[o + 3] << 24) >>> 0; }
  function i16(v, o) { var x = u16(v, o); return x > 32767 ? x - 65536 : x; }
  function i32(v, o) { return v[o] | v[o + 1] << 8 | v[o + 2] << 16 | v[o + 3] << 24; }
  function i8(b) { return b > 127 ? b - 256 : b; }
  function hex(v, o, n) { var s = ''; n = n == null ? v.length - o : n; for (var i = 0; i < n; i++) s += (v[o + i] < 16 ? '0' : '') + v[o + i].toString(16); return s; }
  function cstr(v, o, n) { var e = o; while (e < o + n && v[e] !== 0) e++; return utf8d.decode(v.subarray(o, e)); }
  function putU32(a, o, x) { a[o] = x & 255; a[o + 1] = x >>> 8 & 255; a[o + 2] = x >>> 16 & 255; a[o + 3] = x >>> 24 & 255; }
  function unhex(s) { s = String(s).replace(/[^0-9a-fA-F]/g, ''); var a = new Uint8Array(s.length >> 1); for (var i = 0; i < a.length; i++) a[i] = parseInt(s.substr(i * 2, 2), 16); return a; }

  // Cut a string to at most n bytes of UTF-8 without splitting a character.
  function clipUtf8(s, n) {
    var b = utf8.encode(s);
    if (b.length <= n) return b;
    var end = n;
    while (end > 0 && (b[end] & 0xc0) === 0x80) end--;
    return b.subarray(0, end);
  }
  function byteLen(s) { return utf8.encode(s).length; }

  function frame(code, parts) {
    var n = 1, i;
    for (i = 0; i < parts.length; i++) n += parts[i].length;
    var f = new Uint8Array(n); f[0] = code; var o = 1;
    for (i = 0; i < parts.length; i++) { f.set(parts[i], o); o += parts[i].length; }
    return f;
  }
  function word(x) { var a = new Uint8Array(4); putU32(a, 0, x >>> 0); return a; }
  function sword(x) { var a = new Uint8Array(4); putU32(a, 0, x | 0); return a; }
  function padded(bytes, n) { var a = new Uint8Array(n); a.set(bytes.subarray(0, n - 1)); return a; }
  function pad0(bytes, n) { var a = new Uint8Array(n); a.set(bytes.subarray(0, n)); return a; }

  var enc = {
    deviceQuery: function () { return frame(CMD.DEVICE_QUERY, [Uint8Array.of(PROTO_VER)]); },
    appStart: function (name) { return frame(CMD.APP_START, [new Uint8Array(7), clipUtf8(name || 'web', 30)]); },
    getContacts: function (since) { return since ? frame(CMD.GET_CONTACTS, [word(since)]) : Uint8Array.of(CMD.GET_CONTACTS); },
    syncNext: function () { return Uint8Array.of(CMD.SYNC_NEXT); },
    getTime: function () { return Uint8Array.of(CMD.GET_TIME); },
    setTime: function (secs, force) { return frame(CMD.SET_TIME, force ? [word(secs), Uint8Array.of(1)] : [word(secs)]); },   // the node refuses to go back unless forced
    advert: function (flood) { return frame(CMD.ADVERT, flood ? [Uint8Array.of(1)] : []); },
    battery: function () { return Uint8Array.of(CMD.BATT); },
    getChannel: function (i) { return frame(CMD.GET_CHANNEL, [Uint8Array.of(i)]); },
    setChannel: function (i, name, secret16) { return frame(CMD.SET_CHANNEL, [Uint8Array.of(i), padded(utf8.encode(name), NAME_LEN), pad0(secret16, 16)]); },
    // pubkeyHex: at least the first 12 hex characters (6 bytes)
    sendText: function (pubkeyHex, text, ts, attempt) {
      return frame(CMD.SEND_TXT, [Uint8Array.of(0, attempt || 0), word(ts), unhex(pubkeyHex.slice(0, 12)), clipUtf8(text, MAX_TEXT)]);
    },
    sendChannel: function (idx, text, ts) {
      return frame(CMD.SEND_CHAN_TXT, [Uint8Array.of(0, idx), word(ts), clipUtf8(text, MAX_TEXT)]);
    },
    getHistory: function (first) { return frame(CMD.GET_HISTORY, [Uint8Array.of(first & 255, first >> 8 & 255)]); },
    clearHistory: function () { return Uint8Array.of(CMD.CLEAR_HISTORY); },
    cli: function (text) { return frame(CMD.CLI, [clipUtf8(text, 150)]); },

    setName: function (name) { return frame(CMD.SET_NAME, [clipUtf8(name, NAME_LEN - 1)]); },
    setLatLon: function (lat, lon) { return frame(CMD.SET_LATLON, [sword(Math.round(lat * 1e6)), sword(Math.round(lon * 1e6))]); },
    // freq in kHz, bw in kHz (floats allowed); repeat is the client-repeat flag of firmware 9 and later
    setRadio: function (freqMHz, bwKHz, sf, cr, repeat) {
      var p = [word(Math.round(freqMHz * 1000)), word(Math.round(bwKHz * 1000)), Uint8Array.of(sf, cr)];
      if (repeat != null) p.push(Uint8Array.of(repeat ? 1 : 0));
      return frame(CMD.SET_RADIO, p);
    },
    setTxPower: function (dbm) { return Uint8Array.of(CMD.SET_TX_POWER, dbm & 255); },
    setHashMode: function (mode) { return Uint8Array.of(CMD.SET_HASH_MODE, 0, mode); },
    // manual: 1 = do not add contacts by themselves; tele = base | loc << 2 | env << 4
    setOther: function (manual, tele, advertLoc, multiAcks, pingVisible) {
      var p = [Uint8Array.of(manual, tele, advertLoc, multiAcks)];
      if (pingVisible != null) p.push(Uint8Array.of(pingVisible ? 1 : 0));
      return frame(CMD.SET_OTHER, p);
    },
    getAutoAdd: function () { return Uint8Array.of(CMD.GET_AUTOADD); },
    setAutoAdd: function (flags, maxHops) { return Uint8Array.of(CMD.SET_AUTOADD, flags, maxHops || 0); },
    getVars: function () { return Uint8Array.of(CMD.GET_VARS); },
    setVar: function (k, v) { return frame(CMD.SET_VAR, [utf8.encode(k + ':' + v)]); },
    getTuning: function () { return Uint8Array.of(CMD.GET_TUNING); },
    setTuning: function (rxDelayMs, airtimeFactorMilli) { return frame(CMD.SET_TUNING, [word(rxDelayMs), word(airtimeFactorMilli)]); },
    reboot: function () { return frame(CMD.REBOOT, [utf8.encode('reboot')]); },
    getStats: function (type) { return Uint8Array.of(CMD.GET_STATS, type); },
    getRepeatFreq: function () { return Uint8Array.of(CMD.GET_REPEAT_FREQ); },
    setDefaultScope: function (name, key16) { return name ? frame(CMD.SET_DEFAULT_SCOPE, [padded(utf8.encode(name), 31), pad0(key16, 16)]) : Uint8Array.of(CMD.SET_DEFAULT_SCOPE); },
    getDefaultScope: function () { return Uint8Array.of(CMD.GET_DEFAULT_SCOPE); },
    selfTelemetry: function () { return Uint8Array.of(CMD.TELEMETRY_REQ, 0, 0, 0); },

    getContactByKey: function (keyHex) { return frame(30, [unhex(keyHex)]); },
    removeContact: function (keyHex) { return frame(CMD.REMOVE_CONTACT, [unhex(keyHex)]); },
    resetPath: function (keyHex) { return frame(CMD.RESET_PATH, [unhex(keyHex)]); },
    shareContact: function (keyHex) { return frame(CMD.SHARE_CONTACT, [unhex(keyHex)]); },
    exportContact: function (keyHex) { return keyHex ? frame(CMD.EXPORT_CONTACT, [unhex(keyHex)]) : Uint8Array.of(CMD.EXPORT_CONTACT); },
    importContact: function (bytes) { return frame(CMD.IMPORT_CONTACT, [bytes]); },
    // rewrite a stored contact (favourite flag, route). c is a decoded contact; path is a Uint8Array or null to keep it
    updateContact: function (c, o) {
      o = o || {};
      var flags = o.flags != null ? o.flags : c.flags, plen = o.pathLen != null ? o.pathLen : c.pathLen;
      var path = o.path || c.pathBytes || new Uint8Array(0);
      return frame(CMD.ADD_CONTACT, [unhex(c.key), Uint8Array.of(c.type, flags, plen), pad0(path, PATH_LEN),
        padded(utf8.encode(c.name), NAME_LEN), word(c.lastAdvert), sword(Math.round(c.lat * 1e6)), sword(Math.round(c.lon * 1e6)), word(c.lastMod || 0)]);
    },

    login: function (keyHex, password) { return frame(CMD.LOGIN, [unhex(keyHex), clipUtf8(password, 15), Uint8Array.of(0)]); },
    logout: function (keyHex) { return frame(CMD.LOGOUT, [unhex(keyHex)]); },
    statusReq: function (keyHex) { return frame(CMD.STATUS_REQ, [unhex(keyHex)]); },
    // text typed at a repeater: a text message of type 1, sent to the repeater's key prefix
    remoteCli: function (keyHex, text, ts, attempt) {
      return frame(CMD.SEND_TXT, [Uint8Array.of(1, attempt || 0), word(ts), unhex(keyHex.slice(0, 12)), clipUtf8(text, MAX_TEXT)]);
    },
    binaryReq: function (keyHex, payload) { return frame(CMD.BINARY_REQ, [unhex(keyHex), payload]); },
    telemetryReq: function (keyHex) { return frame(CMD.BINARY_REQ, [unhex(keyHex), Uint8Array.of(3, 0, 0, 0, 0)]); },
    neighboursReq: function (keyHex, count, offset, order, prefixLen) {
      return frame(CMD.BINARY_REQ, [unhex(keyHex), Uint8Array.of(6, 0, count, offset & 255, offset >> 8, order, prefixLen)]);
    },
    pathDiscovery: function (keyHex) { return frame(CMD.PATH_DISCOVERY, [Uint8Array.of(0), unhex(keyHex)]); },
    trace: function (tag, auth, flags, pathBytes) { return frame(CMD.TRACE, [word(tag), word(auth), Uint8Array.of(flags), pathBytes]); },
    setScope: function (key16) { return frame(CMD.SET_SCOPE, [Uint8Array.of(0), key16 || new Uint8Array(0)]); },

    discover: function (tag, typeMask, prefixOnly) {
      return frame(CMD.CONTROL, [Uint8Array.of((0x8 << 4) | (prefixOnly ? 1 : 0), typeMask), word(tag), word(0)]);
    },
    // "who is in radio range": zero hop. typeMask 0xFF = every kind, probability 255 = every node
    ping: function (tag, typeMask, probability, windowSecs) {
      return frame(CMD.CONTROL, [Uint8Array.of(0xA << 4, typeMask), word(tag), Uint8Array.of(probability, windowSecs)]);
    }
  };

  function contact(v) {
    var pl = v[35];
    return { key: hex(v, 1, KEY_LEN), type: v[33], flags: v[34], pathLen: pl,
      pathBytes: pl === FLOOD ? new Uint8Array(0) : v.slice(36, 36 + Math.min(PATH_LEN, (pl & 63) * (((pl & 0xc0) >> 6) + 1))),
      pathWidth: pl === FLOOD ? 1 : ((pl & 0xc0) >> 6) + 1, hops: pl === FLOOD ? -1 : pl & 63,
      name: cstr(v, 36 + PATH_LEN, NAME_LEN), lastAdvert: u32(v, 36 + PATH_LEN + NAME_LEN),
      lat: i32(v, 40 + PATH_LEN + NAME_LEN) / 1e6, lon: i32(v, 44 + PATH_LEN + NAME_LEN) / 1e6,
      lastMod: v.length >= 52 + PATH_LEN + NAME_LEN ? u32(v, 48 + PATH_LEN + NAME_LEN) : 0 };
  }

  // Decode a hop list: n hops of w bytes each, as hex strings
  function hops(v, o, count, width) { var a = []; for (var i = 0; i < count; i++) a.push(hex(v, o + i * width, width)); return a; }

  // Returns {t: kind, ...fields}. Unknown frames come back as {t:'unknown', code}.
  function dec(v) {
    var c = v[0], o, k;
    switch (c) {
      case RESP.OK: return { t: 'ok' };
      case RESP.ERR: return { t: 'err', code: v[1], text: ERR_TEXT[v[1]] || 'error ' + v[1] };
      case RESP.DISABLED: return { t: 'err', code: 99, text: 'turned off in this firmware' };
      case RESP.CONTACTS_START: return { t: 'contactsStart', count: u32(v, 1) };
      case RESP.CONTACT: return Object.assign({ t: 'contact' }, contact(v));
      case PUSH.NEW_ADVERT: return Object.assign({ t: 'newAdvert' }, contact(v));
      case RESP.CONTACTS_END: return { t: 'contactsEnd', lastMod: u32(v, 1) };
      case RESP.SELF_INFO:
        return { t: 'self', advType: v[1], txPower: i8(v[2]), maxTxPower: v[3], key: hex(v, 4, KEY_LEN),
          lat: i32(v, 36) / 1e6, lon: i32(v, 40) / 1e6, multiAcks: v[44], advertLoc: v[45], telemetry: v[46],
          teleBase: v[46] & 3, teleLoc: v[46] >> 2 & 3, teleEnv: v[46] >> 4 & 3,
          manualAdd: v[47], freqMHz: u32(v, 48) / 1000, bwKHz: u32(v, 52) / 1000, sf: v[56], cr: v[57],
          name: utf8d.decode(v.subarray(58)) };
      case RESP.DEVICE_INFO:
        return { t: 'device', fwVer: v[1], maxContacts: v[2] * 2, maxChannels: v[3], build: cstr(v, 8, 12),
          maker: cstr(v, 20, 40), version: cstr(v, 60, 20), repeat: v[80], pathHashMode: v[81],
          pingVisible: v.length > 82 ? v[82] : null };
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
      case RESP.HISTORY: {
        // [total u16][first u16][count u8] then count x [len u8][kind][ts u32][snr i8][path][txt type][target 6][text]
        var recs = [], p = 6;
        for (var n = 0; n < v[5] && p < v.length; n++) {
          var rl = v[p], r = p + 1; p += 1 + rl;
          recs.push({ kind: v[r], sent: v[r] >= 2, channel: (v[r] & 1) === 1, ts: u32(v, r + 1), snr: i8(v[r + 5]) / 4, pathLen: v[r + 6],
            txt: v[r + 7], target: hex(v, r + 8, 6), idx: v[r + 8], text: utf8d.decode(v.subarray(r + 14, r + rl)) });
        }
        return { t: 'history', total: u16(v, 1), first: u16(v, 3), recs: recs };
      }
      case RESP.EXPORT: return { t: 'export', bytes: v.slice(1) };
      case RESP.VARS: {
        var vars = {}, txt = utf8d.decode(v.subarray(1));
        txt.split(',').forEach(function (p) { var i = p.indexOf(':'); if (i > 0) vars[p.slice(0, i)] = p.slice(i + 1); });
        return { t: 'vars', vars: vars };
      }
      case RESP.TUNING: return { t: 'tuning', rxDelayMs: u32(v, 1), airtimeMilli: u32(v, 5) };
      case RESP.AUTOADD: return { t: 'autoAdd', flags: v[1], maxHops: v[2] };
      case RESP.REPEAT_FREQ: { var rs = []; for (k = 1; k + 8 <= v.length; k += 8) rs.push([u32(v, k), u32(v, k + 4)]); return { t: 'repeatFreq', ranges: rs }; }
      case RESP.DEFAULT_SCOPE: return v.length > 1 ? { t: 'defaultScope', name: cstr(v, 1, 31), key: hex(v, 32, 16) } : { t: 'defaultScope', name: '', key: '' };
      case RESP.STATS:
        if (v[1] === 0) return { t: 'stats', kind: 'core', mv: u16(v, 2), uptime: u32(v, 4), errFlags: u16(v, 8), queue: v[10] };
        if (v[1] === 1) return { t: 'stats', kind: 'radio', noise: i16(v, 2), rssi: i8(v[4]), snr: i8(v[5]) / 4, txAir: u32(v, 6), rxAir: u32(v, 10) };
        return { t: 'stats', kind: 'packets', recv: u32(v, 2), sent: u32(v, 6), sentFlood: u32(v, 10), sentDirect: u32(v, 14),
          recvFlood: u32(v, 18), recvDirect: u32(v, 22), recvErrors: u32(v, 26) };
      case RESP.CONTACT_MSG_V3: case RESP.CONTACT_MSG:
        o = c === RESP.CONTACT_MSG_V3 ? 4 : 1;
        var snr = c === RESP.CONTACT_MSG_V3 ? i8(v[1]) / 4 : null;
        var kind = v[o + 7];
        var tx = o + 12 + (kind >> 2 === 2 || kind === 2 ? 4 : 0);   // signed text carries 4 extra bytes
        return { t: 'msg', channel: false, snr: snr, from: hex(v, o, 6), pathLen: v[o + 6], kind: kind,
          ts: u32(v, o + 8), text: utf8d.decode(v.subarray(tx)) };
      case RESP.CHANNEL_MSG_V3: case RESP.CHANNEL_MSG:
        o = c === RESP.CHANNEL_MSG_V3 ? 4 : 1;
        return { t: 'msg', channel: true, snr: c === RESP.CHANNEL_MSG_V3 ? i8(v[1]) / 4 : null, idx: v[o],
          pathLen: v[o + 1], kind: v[o + 2], ts: u32(v, o + 3), text: utf8d.decode(v.subarray(o + 7)) };

      case PUSH.LOGIN_OK:
        return { t: 'loginOk', admin: (v[1] & 1) === 1, perms: v[1], from: hex(v, 2, 6), serverTime: v.length >= 12 ? u32(v, 8) : 0,
          acl: v.length >= 13 ? v[12] : 0, fwLevel: v.length >= 14 ? v[13] : 0 };
      case PUSH.LOGIN_FAIL: return { t: 'loginFail', from: hex(v, 2, 6) };
      case PUSH.STATUS: return { t: 'status', from: hex(v, 2, 6), data: v.slice(8) };
      case PUSH.TELEMETRY: return { t: 'telemetry', from: hex(v, 2, 6), data: v.slice(8) };
      case PUSH.BINARY: return { t: 'binary', tag: u32(v, 2), data: v.slice(6) };
      case PUSH.PATH_DISCOVERY: {
        var ol = v[8], inl = v[9 + ol];
        return { t: 'pathDiscovery', from: hex(v, 2, 6), outPath: hex(v, 9, ol), inPath: hex(v, 10 + ol, inl) };
      }
      case PUSH.TRACE: {
        var plen = v[2], flags = v[3], sz = flags & 3, w = 1 << sz, nh = plen >> sz;
        return { t: 'trace', flags: flags, width: w, tag: u32(v, 4), auth: u32(v, 8), hops: hops(v, 12, nh, w),
          snrs: Array.prototype.slice.call(v.subarray(12 + plen, 12 + plen + nh)).map(function (b) { return i8(b) / 4; }),
          lastSnr: i8(v[12 + plen + nh]) / 4 };
      }
      case PUSH.LOG_RX: return { t: 'rx', snr: i8(v[1]) / 4, rssi: i8(v[2]), raw: v.slice(3) };
      case PUSH.CONTROL: {
        var sub = v[4] >> 4, base = { t: 'control', snr: i8(v[1]) / 4, rssi: i8(v[2]), pathLen: v[3], sub: sub };
        if (sub === 0xB && v.length >= 20) {   // a node answering a ping
          var nl = v[19];
          return Object.assign(base, { t: 'pingReply', nodeType: v[4] & 15, theirSnr: i8(v[5]) / 4, tag: u32(v, 6), fwVer: v[10],
            key8: hex(v, 11, 8), name: nl <= 16 && 20 + nl <= v.length ? utf8d.decode(v.subarray(20, 20 + nl)).replace(/[\x00-\x1f]/g, '') : '' });
        }
        if (sub === 0x9 && v.length >= 14) {   // a node answering a discovery request
          return Object.assign(base, { t: 'discoverReply', nodeType: v[4] & 15, theirSnr: i8(v[5]) / 4, tag: u32(v, 6), key: hex(v, 10) });
        }
        return base;
      }
      default: return { t: 'unknown', code: c };
    }
  }

  // the statistics a repeater (or room) answers a status request with
  function nodeStats(d, isRoom) {
    if (d.length < 48) return null;
    var r = { mv: u16(d, 0), queue: u16(d, 2), noise: i16(d, 4), rssi: i16(d, 6), recv: u32(d, 8), sent: u32(d, 12), txAir: u32(d, 16), uptime: u32(d, 20),
      sentFlood: u32(d, 24), sentDirect: u32(d, 28), recvFlood: u32(d, 32), recvDirect: u32(d, 36), errEvents: u16(d, 40), snr: i16(d, 42) / 4, dupDirect: u16(d, 44), dupFlood: u16(d, 46) };
    if (!isRoom && d.length >= 52) r.rxAir = u32(d, 48);
    if (!isRoom && d.length >= 56) r.recvErrors = u32(d, 52);
    return r;
  }
  // answer to a neighbours request: total, then entries of [key prefix][heard seconds ago u32][snr x4 i8]
  function neighbours(d, prefixLen) {
    if (d.length < 4) return null;
    var total = u16(d, 0), n = u16(d, 2), list = [], o = 4;
    for (var i = 0; i < n && o + prefixLen + 5 <= d.length; i++, o += prefixLen + 5) list.push({ key: hex(d, o, prefixLen), ago: u32(d, o + prefixLen), snr: i8(d[o + prefixLen + 4]) / 4 });
    return { total: total, list: list };
  }

  var api = { nodeStats: nodeStats, neighbours: neighbours, CMD: CMD, RESP: RESP, PUSH: PUSH, ERR: ERR, TYPE: TYPE, FLOOD: FLOOD, enc: enc, dec: dec, hex: hex, unhex: unhex,
    clipUtf8: clipUtf8, byteLen: byteLen, MAX_TEXT: MAX_TEXT, u16: u16, u32: u32, i16: i16, i8: i8 };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.MC = api;
})(typeof self !== 'undefined' ? self : this);
