#pragma once

#include <stdint.h>
#include <string.h>
#include <Packet.h>
#include <SHA256.h>
#include "RouteTable.h"

namespace mesh {

/**
 * \brief  The ROUTED envelope: a packet carried from repeater to repeater by the route tables instead of by flooding.
 *
 * A client that knows its own nearest repeater (the one it last heard relaying a flood) and the destination's home repeater (the first
 * repeater that heard the destination's advert) wraps the message it would have flooded or source-routed and sends it as a DIRECT
 * packet of type ROUTED whose path is just that nearest repeater. Each repeater looks the destination repeater up in its route table
 * and hands the envelope to the next hop; the home repeater unwraps it and sends the inner packet zero-hop to the destination.
 *
 *   outer header  ROUTE_TYPE_DIRECT | PAYLOAD_TYPE_ROUTED     path = [next hop], one hash of h bytes (h = 1 to 3, the packet's path hash size)
 *   payload       byte 0   h (the low two bits; the rest is zero)
 *                 byte 1   ttl, counted down at every hop
 *                 h bytes  destination home repeater (the first h bytes of its public key)
 *                 h bytes  source home repeater (where a reply should be sent)
 *                 rest     the inner packet exactly as Packet::writeTo wrote it (header, path length, path, payload)
 *
 * Why an envelope: the inner packet is untouched, so a destination still learns the path of a flooded message and answers normally.
 * Repeaters that do not know ROUTED forward nothing (the envelope is a DIRECT packet of an unknown type with one hop on its path,
 * which they strip to nothing and send zero-hop, where nobody acts on it), so the sender falls back to flooding.
 */
#define ROUTED_DEFAULT_TTL   16
#define ROUTED_MAX_HASH      3

struct RoutedEnvelope {
  uint8_t        hsize;            // 1 to 3
  uint8_t        ttl;
  uint8_t        dest[ROUTED_MAX_HASH];
  uint8_t        src[ROUTED_MAX_HASH];
  const uint8_t* inner;            // points into the payload that was decoded
  uint8_t        inner_len;
};

// the length of the payload for an inner packet of inner_len bytes, or 0 if it does not fit
static inline int routedPayloadLen(int hsize, int inner_len) {
  int n = 2 + 2 * hsize + inner_len;
  return (hsize < 1 || hsize > ROUTED_MAX_HASH || inner_len <= 0 || n > MAX_PACKET_PAYLOAD) ? 0 : n;
}

// writes the envelope payload; returns its length, or 0 if the arguments are not valid
static inline int routedEncode(uint8_t* out, int hsize, uint8_t ttl, const uint8_t* dest, const uint8_t* src, const uint8_t* inner,
                               int inner_len) {
  int n = routedPayloadLen(hsize, inner_len);
  if (n == 0) return 0;
  out[0] = (uint8_t)hsize;
  out[1] = ttl;
  memcpy(&out[2], dest, hsize);
  memcpy(&out[2 + hsize], src, hsize);
  memcpy(&out[2 + 2 * hsize], inner, inner_len);
  return n;
}

static inline bool routedDecode(const uint8_t* payload, int len, RoutedEnvelope& e) {
  if (len < 3) return false;
  int h = payload[0] & 0x03;
  if ((payload[0] & 0xFC) != 0 || h < 1 || h > ROUTED_MAX_HASH) return false;
  int head = 2 + 2 * h;
  if (len <= head) return false;
  e.hsize = (uint8_t)h;
  e.ttl = payload[1];
  memcpy(e.dest, &payload[2], h);
  memcpy(e.src, &payload[2 + h], h);
  e.inner = &payload[head];
  e.inner_len = (uint8_t)(len - head);
  return true;
}

/**
 * The identity of an envelope for duplicate checks and for hearing the next hop pass it on: a hash of everything except the ttl, which
 * every hop changes. (The ordinary packet hash covers the whole payload, so it differs at every hop.)
 */
static inline void routedIdentity(const uint8_t* payload, int len, uint8_t hash[MAX_HASH_SIZE]) {
  SHA256 sha;
  uint8_t t = PAYLOAD_TYPE_ROUTED;
  sha.update(&t, 1);
  if (len > 0) sha.update(payload, 1);
  if (len > 2) sha.update(&payload[2], len - 2);
  sha.finalize(hash, MAX_HASH_SIZE);
}

enum RoutedAction : uint8_t {
  ROUTED_DROP,          // nothing to do: expired, or no route
  ROUTED_DELIVER,       // this repeater is the destination's home: unwrap and send the inner packet zero-hop
  ROUTED_FORWARD        // hand to `next`
};

struct RoutedDecision {
  RoutedAction action;
  uint8_t      next[ROUTED_MAX_HASH];   // ROUTED_FORWARD: the next hop's hash, hsize bytes
  bool         next_is_dest;            // the next hop is the destination home: it will unwrap, not pass the envelope on
  uint8_t      cost;
};

/**
 * What a repeater does with an envelope that names it as the next hop. `Router` is a RoutingCore (or anything with the same
 * `routes.findByPrefix`); `self_key` is this repeater's public key; `id_bytes` is how many bytes of a key the route table keeps (a longer
 * hash in the envelope is compared only as far as the table knows).
 */
template <class Router>
RoutedDecision routedDecide(const Router& router, const uint8_t* self_key, const RoutedEnvelope& e, uint32_t now, int id_bytes = 4) {
  RoutedDecision d;
  memset(&d, 0, sizeof(d));
  d.action = ROUTED_DROP;
  if (memcmp(e.dest, self_key, e.hsize) == 0) { d.action = ROUTED_DELIVER; return d; }
  if (e.ttl == 0) return d;                                        // no life left to hand it on
  const RouteTableEntry* r = router.routes.findByPrefix(e.dest, e.hsize < id_bytes ? e.hsize : id_bytes, now);
  if (r == NULL) return d;
  for (int k = 0; k < e.hsize; k++) d.next[k] = (uint8_t)(r->next >> (24 - 8 * k));
  d.next_is_dest = (r->next == r->dest);
  d.cost = r->cost;
  d.action = ROUTED_FORWARD;
  return d;
}

/** Apply a forward decision to the envelope in place: the next hop goes into the path, the ttl comes down by one. */
static inline void routedRewrite(uint8_t* path, uint8_t path_hash_size, uint8_t* payload, const RoutedDecision& d) {
  for (int k = 0; k < path_hash_size; k++) path[k] = k < ROUTED_MAX_HASH ? d.next[k] : 0;
  payload[1]--;
}

enum SendStep : uint8_t {
  SEND_CACHED,   // source-route along the cached path
  SEND_ROUTED,   // try an envelope to the destination's home repeater (if that turns out to be possible)
  SEND_FLOOD
};

/**
 * Which way to send a message: the cached path if there is one; else, for the first `routed_tries` attempts, by the route tables; else a
 * flood. The app counts attempts and resets the cached path after failures, which is what steps a message down this list.
 */
static inline SendStep chooseSendStep(bool has_cached_path, uint8_t attempt, uint8_t routed_tries) {
  if (has_cached_path) return SEND_CACHED;
  return attempt < routed_tries ? SEND_ROUTED : SEND_FLOOD;
}

}  // namespace mesh
