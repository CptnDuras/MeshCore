#pragma once

#include <stdint.h>
#include <string.h>
#include "RoutedPacket.h"

namespace mesh {

/**
 * What a client needs to know before it can send a ROUTED envelope, learned from traffic it hears anyway. No clock of its own (callers
 * pass in seconds), no heap, so it is tested on a PC.
 */

/**
 * Our nearest repeater: the one that last relayed a flood to us, at the best signal lately. The last hash on a flood's path belongs to
 * the repeater we heard directly. We remember the strongest, and let a weaker one replace it once the strong one has not been heard for
 * a while.
 */
class EntryTracker {
  uint8_t  hash[ROUTED_MAX_HASH];
  uint8_t  size_;
  int8_t   snr4;
  uint32_t heard_at;
  bool     have;

public:
  enum { HOLD_S = 1800, STALE_S = 21600 };

  EntryTracker() : size_(0), snr4(0), heard_at(0), have(false) {}

  void clear() { have = false; }

  void heard(const uint8_t* h, uint8_t hsize, int8_t snr_x4, uint32_t now) {
    if (hsize < 1 || hsize > ROUTED_MAX_HASH) return;
    bool same = have && size_ == hsize && memcmp(hash, h, hsize) == 0;
    bool better = !have || snr_x4 >= snr4 || (uint32_t)(now - heard_at) > HOLD_S;
    if (same || better) {
      memcpy(hash, h, hsize);
      size_ = hsize;
      snr4 = snr_x4;
      heard_at = now;
      have = true;
    }
  }

  bool get(uint8_t* out, uint8_t& hsize, uint32_t now) const {
    if (!have || (uint32_t)(now - heard_at) > STALE_S) return false;
    memcpy(out, hash, size_);
    hsize = size_;
    return true;
  }
};

/** The home repeater of each contact: the first hash on the path of their advert (or of a flood from them). */
template <int CAPACITY>
class HomeCache {
  struct Slot {
    uint8_t  key[4];       // first bytes of the contact's public key
    uint8_t  hash[ROUTED_MAX_HASH];
    uint8_t  hsize;
    uint32_t used_at;
    bool     used;
  };
  Slot slots[CAPACITY];

  Slot* find(const uint8_t* pub_key) {
    for (int i = 0; i < CAPACITY; i++) if (slots[i].used && memcmp(slots[i].key, pub_key, 4) == 0) return &slots[i];
    return NULL;
  }

public:
  HomeCache() { memset(slots, 0, sizeof(slots)); }

  void set(const uint8_t* pub_key, const uint8_t* h, uint8_t hsize, uint32_t now) {
    if (hsize < 1 || hsize > ROUTED_MAX_HASH) return;
    Slot* s = find(pub_key);
    if (s == NULL) {
      s = &slots[0];
      for (int i = 0; i < CAPACITY; i++) {
        if (!slots[i].used) { s = &slots[i]; break; }
        if ((int32_t)(slots[i].used_at - s->used_at) < 0) s = &slots[i];   // else the least recently used
      }
    }
    memcpy(s->key, pub_key, 4);
    memcpy(s->hash, h, hsize);
    s->hsize = hsize;
    s->used_at = now;
    s->used = true;
  }

  bool get(const uint8_t* pub_key, uint8_t* out, uint8_t& hsize) {
    Slot* s = find(pub_key);
    if (s == NULL) return false;
    memcpy(out, s->hash, s->hsize);
    hsize = s->hsize;
    return true;
  }
};

/**
 * Has a repeater near us shown that it routes? A repeater with route tables on sends its route adverts zero-hop, so a client hears them
 * (the first bytes after the type byte are the sender's id). Without proof the client does not send envelopes, since a repeater that
 * does not know them would just drop them and cost the message an attempt.
 */
class RoutingSeen {
  struct Slot { uint8_t id[4]; uint8_t len; uint32_t at; bool used; };
  enum { N = 8, WINDOW_S = 28800 };
  Slot slots[N];

public:
  RoutingSeen() { memset(slots, 0, sizeof(slots)); }

  // `id` is the first `len` (2 to 4) bytes of the advertising repeater's key, as route adverts carry them
  void heard(const uint8_t* id, uint8_t len, uint32_t now) {
    if (len < 2 || len > 4) return;
    Slot* s = NULL;
    for (int i = 0; i < N; i++) if (slots[i].used && slots[i].len == len && memcmp(slots[i].id, id, len) == 0) { s = &slots[i]; break; }
    if (s == NULL) {
      s = &slots[0];
      for (int i = 0; i < N; i++) {
        if (!slots[i].used) { s = &slots[i]; break; }
        if ((int32_t)(slots[i].at - s->at) < 0) s = &slots[i];
      }
    }
    memcpy(s->id, id, len);
    s->len = len;
    s->at = now;
    s->used = true;
  }

  // has a repeater whose key starts with these bytes been heard sending route adverts lately?
  bool seen(const uint8_t* hash, uint8_t hsize, uint32_t now) const {
    for (int i = 0; i < N; i++) {
      if (slots[i].used && (uint32_t)(now - slots[i].at) <= WINDOW_S && hsize <= slots[i].len && memcmp(slots[i].id, hash, hsize) == 0) return true;
    }
    return false;
  }
};

}  // namespace mesh
