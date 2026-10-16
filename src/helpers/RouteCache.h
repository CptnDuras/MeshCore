#pragma once

#include <stdint.h>
#include <string.h>
#include <MeshCore.h>

namespace mesh {

#define ROUTE_KEY_SIZE   8   // leading bytes of the node's public key used as the cache key

/**
 * \brief  What a repeater has learned about how to reach other nodes, from the paths their
 *         (signature-verified) adverts took to get here.
 *
 * Observation only: nothing consults this cache when forwarding. It is a fixed-size table, with
 * no heap use and no clock of its own (callers pass in the time), so it can be unit-tested natively.
 */
struct RouteEntry {
  uint8_t  key[ROUTE_KEY_SIZE];
  uint8_t  path_len;            // encoded like Packet::path_len (hash size in bits 6-7, hop count in bits 0-5)
  uint8_t  path[MAX_PATH_SIZE]; // repeaters the advert passed through, in order from the advertiser to us
  uint32_t heard;               // when we last heard anything from this node
  uint32_t path_seen;           // when this exact path was last confirmed
  int8_t   snr;                 // SNR (x4) of the most recent packet
  bool     used;

  uint8_t hopCount() const { return path_len & 63; }
  uint8_t hashSize() const { return (path_len >> 6) + 1; }
  uint8_t pathBytes() const { return hopCount() * hashSize(); }
};

enum RouteLearn : uint8_t {
  ROUTE_INSERTED,    // new node
  ROUTE_REPLACED,    // path replaced by a better (shorter) or refreshed-after-stale one
  ROUTE_CONFIRMED,   // same path seen again
  ROUTE_KEPT,        // a longer, different path was heard: kept the better existing one
};

template <int CAPACITY>
class RouteCache {
  RouteEntry entries[CAPACITY];

  static bool samePath(const RouteEntry& e, const uint8_t* path, uint8_t path_len) {
    return e.path_len == path_len && memcmp(e.path, path, e.pathBytes()) == 0;
  }

public:
  // a path not re-confirmed for this long may be replaced even by a longer one
  static const uint32_t STALE_SECS = 3600;

  RouteCache() { clear(); }

  void clear() { memset(entries, 0, sizeof(entries)); }

  int capacity() const { return CAPACITY; }

  int count() const {
    int n = 0;
    for (int i = 0; i < CAPACITY; i++) if (entries[i].used) n++;
    return n;
  }

  const RouteEntry* at(int i) const { return (i >= 0 && i < CAPACITY && entries[i].used) ? &entries[i] : NULL; }

  const RouteEntry* find(const uint8_t* pub_key) const {
    for (int i = 0; i < CAPACITY; i++) {
      if (entries[i].used && memcmp(entries[i].key, pub_key, ROUTE_KEY_SIZE) == 0) return &entries[i];
    }
    return NULL;
  }

  /**
   * \brief  Record a node heard with the given path.
   * \param  pub_key   the node's public key (at least ROUTE_KEY_SIZE bytes)
   * \param  path      the hops the packet took to reach us (may be NULL when path_len has no hops)
   * \param  path_len  encoded path length (see Packet::path_len)
   * \param  now       current time in seconds
   * \param  snr       SNR (x4) of the received packet
   */
  RouteLearn learn(const uint8_t* pub_key, const uint8_t* path, uint8_t path_len, uint32_t now, int8_t snr) {
    uint8_t hops = path_len & 63;
    uint8_t bytes = hops * ((path_len >> 6) + 1);
    if (bytes > MAX_PATH_SIZE) { bytes = MAX_PATH_SIZE; hops = 0; path_len = 0; }  // malformed: treat as direct

    RouteEntry* e = NULL;
    RouteEntry* oldest = &entries[0];
    for (int i = 0; i < CAPACITY; i++) {
      if (entries[i].used && memcmp(entries[i].key, pub_key, ROUTE_KEY_SIZE) == 0) { e = &entries[i]; break; }
      if (!entries[i].used) { oldest = &entries[i]; oldest->heard = 0; }
      else if (oldest->used && entries[i].heard < oldest->heard) oldest = &entries[i];
    }

    if (e == NULL) {   // new node: use a free slot, or evict the least recently heard
      e = oldest;
      memset(e, 0, sizeof(*e));
      memcpy(e->key, pub_key, ROUTE_KEY_SIZE);
      e->used = true;
      e->path_len = path_len;
      if (bytes) memcpy(e->path, path, bytes);
      e->heard = e->path_seen = now;
      e->snr = snr;
      return ROUTE_INSERTED;
    }

    e->heard = now;
    e->snr = snr;
    if (samePath(*e, path, path_len)) {
      e->path_seen = now;
      return ROUTE_CONFIRMED;
    }
    bool shorter = hops < e->hopCount();
    bool stale = now - e->path_seen > STALE_SECS;
    if (shorter || stale) {
      e->path_len = path_len;
      memset(e->path, 0, sizeof(e->path));
      if (bytes) memcpy(e->path, path, bytes);
      e->path_seen = now;
      return ROUTE_REPLACED;
    }
    return ROUTE_KEPT;
  }

  /** Remove nodes not heard from for more than max_age seconds. Returns how many were removed. */
  int expire(uint32_t now, uint32_t max_age) {
    int removed = 0;
    for (int i = 0; i < CAPACITY; i++) {
      if (entries[i].used && now - entries[i].heard > max_age) {
        entries[i].used = false;
        removed++;
      }
    }
    return removed;
  }
};

}
