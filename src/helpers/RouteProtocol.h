#pragma once

#include "RouteTypes.h"

namespace mesh {

/**
 * Wire formats for client check-ins and route adverts. Both are zero-hop control packets (PAYLOAD_TYPE_CONTROL with the top bit of
 * the first byte set, so they are delivered only to direct neighbours and never forwarded). Control subtypes 0x80/0x90 are node
 * discovery and 0xA0/0xB0 are ping; these use 0xC0 and 0xD0.
 *
 *   CHECKIN    0xD0|flags  id(N)  counter(2, LE)  ttl/8(2, LE)
 *   ROUTE_ADV  0xC0|flags  originator id(N)  count(1)  then count x { dest id(N)  cost(1)  seq(2, LE)  life/128(1) }
 *
 * flags (low nibble): bit0 = mobile (CHECKIN) or full table (ROUTE_ADV); bit1 = going away (CHECKIN) or reply requested
 * (ROUTE_ADV); bits 2-3 = id size code, 0 = 2 bytes, 1 = 3, 2 = 4. N is the id size. Ids are big-endian, as the key bytes.
 * Encoders return the length written (0 if it does not fit or the input is invalid); decoders return false for anything malformed.
 */
#define CTL_TYPE_ROUTE_ADV      0xC0
#define CTL_TYPE_CHECKIN        0xD0
#define CTL_ROUTE_SUBTYPE_MASK  0xF0

#define ROUTE_FLAG_A            0x01   // CHECKIN: mobile.  ROUTE_ADV: full table
#define ROUTE_FLAG_B            0x02   // CHECKIN: going away.  ROUTE_ADV: reply requested

#define ROUTE_ADV_MAX_ENTRIES   24
#define ROUTE_LIFE_UNIT_S       128
#define CHECKIN_TTL_UNIT_S      8

struct AdvEntry {
  RouteId  dest;
  uint8_t  cost;
  uint16_t seq;
  uint16_t life_s;   // seconds; carried as a multiple of 128 (rounded up so a nonzero lifetime never becomes 0)
};

struct RouteAdv {
  bool     full;
  bool     reply_requested;
  uint8_t  id_bytes;   // 2 to 4
  RouteId  origin;
  uint8_t  count;
  AdvEntry entries[ROUTE_ADV_MAX_ENTRIES];
};

struct Checkin {
  bool     mobile;
  bool     going_away;
  uint8_t  id_bytes;
  RouteId  id;
  uint16_t counter;
  uint16_t ttl_s;    // seconds; carried as a multiple of 8 (rounded up)
};

// 1 (type/flags) + id + 1 (count) + entries x (id + 4) must stay within 150 bytes: 18 entries of 4-byte ids, 20 of 3, 24 of 2
static inline int routeAdvMaxEntries(int id_bytes) {
  int n = (150 - 1 - id_bytes - 1) / (id_bytes + 4);
  return n > ROUTE_ADV_MAX_ENTRIES ? ROUTE_ADV_MAX_ENTRIES : n;
}

static inline bool validIdBytes(int n) { return n >= 2 && n <= 4; }

static inline void putId(uint8_t* out, RouteId id, int id_bytes) {
  for (int i = 0; i < id_bytes; i++) out[i] = (uint8_t)(id >> (24 - 8 * i));
}
static inline RouteId getId(const uint8_t* in, int id_bytes) {
  RouteId id = 0;
  for (int i = 0; i < id_bytes; i++) id |= ((RouteId)in[i]) << (24 - 8 * i);
  return id;
}

static inline uint8_t lifeToUnits(uint16_t life_s) {
  uint32_t u = ((uint32_t)life_s + ROUTE_LIFE_UNIT_S - 1) / ROUTE_LIFE_UNIT_S;
  return u > 255 ? 255 : (uint8_t)u;
}

static inline bool isRouteAdv(const uint8_t* p, int len) { return len >= 1 && (p[0] & CTL_ROUTE_SUBTYPE_MASK) == CTL_TYPE_ROUTE_ADV; }
static inline bool isCheckin(const uint8_t* p, int len)  { return len >= 1 && (p[0] & CTL_ROUTE_SUBTYPE_MASK) == CTL_TYPE_CHECKIN; }

static inline int encodeCheckin(const Checkin& c, uint8_t* out, int cap) {
  if (!validIdBytes(c.id_bytes)) return 0;
  int len = 1 + c.id_bytes + 4;
  if (cap < len) return 0;
  uint32_t units = ((uint32_t)c.ttl_s + CHECKIN_TTL_UNIT_S - 1) / CHECKIN_TTL_UNIT_S;
  if (units > 0xFFFF) units = 0xFFFF;
  out[0] = CTL_TYPE_CHECKIN | (c.mobile ? ROUTE_FLAG_A : 0) | (c.going_away ? ROUTE_FLAG_B : 0) | ((c.id_bytes - 2) << 2);
  putId(&out[1], c.id & routeIdMask(c.id_bytes), c.id_bytes);
  int i = 1 + c.id_bytes;
  out[i++] = c.counter & 0xFF; out[i++] = c.counter >> 8;
  out[i++] = units & 0xFF;     out[i++] = units >> 8;
  return len;
}

static inline bool decodeCheckin(const uint8_t* p, int len, Checkin& c) {
  if (!isCheckin(p, len)) return false;
  int code = (p[0] >> 2) & 3;
  if (code > 2) return false;
  c.id_bytes = code + 2;
  if (len != 1 + c.id_bytes + 4) return false;
  c.mobile = p[0] & ROUTE_FLAG_A;
  c.going_away = p[0] & ROUTE_FLAG_B;
  c.id = getId(&p[1], c.id_bytes);
  int i = 1 + c.id_bytes;
  c.counter = p[i] | (p[i + 1] << 8);
  c.ttl_s = (uint16_t)((p[i + 2] | (p[i + 3] << 8)) * CHECKIN_TTL_UNIT_S);
  return true;
}

static inline int encodeRouteAdv(const RouteAdv& a, uint8_t* out, int cap) {
  if (!validIdBytes(a.id_bytes) || a.count > routeAdvMaxEntries(a.id_bytes)) return 0;
  int len = 1 + a.id_bytes + 1 + a.count * (a.id_bytes + 4);
  if (cap < len) return 0;
  out[0] = CTL_TYPE_ROUTE_ADV | (a.full ? ROUTE_FLAG_A : 0) | (a.reply_requested ? ROUTE_FLAG_B : 0) | ((a.id_bytes - 2) << 2);
  putId(&out[1], a.origin & routeIdMask(a.id_bytes), a.id_bytes);
  int i = 1 + a.id_bytes;
  out[i++] = a.count;
  for (int k = 0; k < a.count; k++) {
    putId(&out[i], a.entries[k].dest & routeIdMask(a.id_bytes), a.id_bytes);
    i += a.id_bytes;
    out[i++] = a.entries[k].cost;
    out[i++] = a.entries[k].seq & 0xFF;
    out[i++] = a.entries[k].seq >> 8;
    out[i++] = lifeToUnits(a.entries[k].life_s);
  }
  return len;
}

static inline bool decodeRouteAdv(const uint8_t* p, int len, RouteAdv& a) {
  if (!isRouteAdv(p, len)) return false;
  int code = (p[0] >> 2) & 3;
  if (code > 2) return false;
  a.id_bytes = code + 2;
  if (len < 1 + a.id_bytes + 1) return false;
  a.full = p[0] & ROUTE_FLAG_A;
  a.reply_requested = p[0] & ROUTE_FLAG_B;
  a.origin = getId(&p[1], a.id_bytes);
  int i = 1 + a.id_bytes;
  a.count = p[i++];
  if (a.count > routeAdvMaxEntries(a.id_bytes) || len != i + a.count * (a.id_bytes + 4)) return false;
  for (int k = 0; k < a.count; k++) {
    a.entries[k].dest = getId(&p[i], a.id_bytes);
    i += a.id_bytes;
    a.entries[k].cost = p[i++];
    a.entries[k].seq = p[i] | (p[i + 1] << 8);
    i += 2;
    a.entries[k].life_s = (uint16_t)(p[i++] * ROUTE_LIFE_UNIT_S);
  }
  return true;
}

}  // namespace mesh
