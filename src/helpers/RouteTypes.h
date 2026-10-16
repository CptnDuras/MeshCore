#pragma once

#include <stdint.h>
#include <string.h>

namespace mesh {

/**
 * Shared pieces of the route tables (RouteTable.h, AttachTable.h, NeighborLinks.h) and their packet formats (RouteProtocol.h).
 *
 * A node is identified in the tables by the first 2 to 4 bytes of its public key (the network chooses one length, see
 * ROUTE_ID_BYTES_DEFAULT). The id is kept in a uint32_t with the bytes in the high end, bytes beyond the chosen length zero, so ids
 * of the same length compare with ==.
 *
 * Time is a monotonic count of seconds supplied by the caller (never the settable real-time clock), compared with wrap-around
 * arithmetic, so a table never needs a clock of its own and can be tested natively.
 */

#define ROUTE_ID_BYTES_DEFAULT   4
#define ROUTE_COST_UNREACHABLE   255
#define ROUTE_COST_MAX           254

typedef uint32_t RouteId;

// the id for a public key, using the first id_bytes (2 to 4) bytes
static inline RouteId routeIdFromKey(const uint8_t* pub_key, int id_bytes) {
  RouteId id = 0;
  for (int i = 0; i < id_bytes && i < 4; i++) id |= ((RouteId)pub_key[i]) << (24 - 8 * i);
  return id;
}

static inline RouteId routeIdMask(int id_bytes) {
  return id_bytes >= 4 ? 0xFFFFFFFFu : (id_bytes <= 0 ? 0u : (0xFFFFFFFFu << (32 - 8 * id_bytes)));
}

// serial-number arithmetic: true when a is newer than b, correct across wrap-around
static inline bool seqNewer(uint16_t a, uint16_t b) { return (int16_t)(uint16_t)(a - b) > 0; }

// time in seconds, wrap-safe: true when t has not passed yet
static inline bool timeAhead(uint32_t t, uint32_t now) { return (int32_t)(t - now) > 0; }

static inline uint8_t addCost(uint8_t a, uint8_t b) {
  uint16_t sum = (uint16_t)a + b;
  return sum > ROUTE_COST_MAX ? ROUTE_COST_MAX : (uint8_t)sum;
}

}  // namespace mesh
