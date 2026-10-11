#pragma once

#include "RouteTypes.h"

namespace mesh {

/**
 * \brief  How good each directly heard repeater's link is: a cost for the route table.
 *
 * The cost starts from SNR. margin = smoothed SNR minus the lowest SNR the radio's spreading factor can decode, put into buckets
 * (>= 10 dB: cost 1, 5-10: 2, 2-5: 3, 0-2: 5, below 0: not used for routing). A link moves to another bucket only after the margin
 * has passed the edge by 2 dB, so a fading link does not flap between costs.
 *
 * SNR alone cannot see interference or collisions. The cost therefore also carries a delivery penalty from what the repeater
 * measures for itself: how often a packet it forwarded was heard being passed on by this neighbour. With at least 8 results,
 * below 90% delivery adds 1, below 70% adds 3, below 50% the link is not used.
 *
 * SNR is in quarter dB, as the firmware stores it. Fixed size, no heap, no clock of its own.
 */
struct LinkInfo {
  RouteId  id;
  uint32_t last_heard;  // seconds (monotonic)
  int16_t  snr16;       // smoothed SNR x16 (finer than the x4 the radio reports, so small changes are not rounded away)
  uint8_t  snr_n;       // SNR samples (stops counting at 255)
  uint8_t  bucket;      // 0..4 index into the cost table
  uint8_t  deliv;       // delivery ratio estimate, 0..255
  uint8_t  deliv_n;     // delivery results seen (stops counting at 255)
  bool     used;
};

#define LINK_MIN_DELIVERY_SAMPLES  8
#define LINK_HYSTERESIS_X4         8      // 2 dB
#define LINK_NOT_USABLE            ROUTE_COST_UNREACHABLE

// lowest SNR (x4) that spreading factors 7 to 12 can decode: -7.5, -10, -12.5, -15, -17.5, -20 dB
static inline int linkSnrFloor4(int sf) {
  if (sf < 7) sf = 7;
  if (sf > 12) sf = 12;
  return -30 - 10 * (sf - 7);
}

template <int CAPACITY>
class NeighborLinks {
  LinkInfo links[CAPACITY];

  // bucket k covers margins >= edge[k]; the last bucket is everything below the previous edge
  static int edge4(int k) { static const int e[4] = {40, 20, 8, 0}; return e[k]; }
  static uint8_t bucketCost(int b) { static const uint8_t c[5] = {1, 2, 3, 5, LINK_NOT_USABLE}; return c[b]; }

  static int rawBucket(int margin4) {
    for (int k = 0; k < 4; k++) if (margin4 >= edge4(k)) return k;
    return 4;
  }

  LinkInfo* slot(RouteId id) {
    for (int i = 0; i < CAPACITY; i++) {
      if (links[i].used && links[i].id == id) return &links[i];
    }
    return NULL;
  }

public:
  NeighborLinks() { clear(); }

  void clear() { memset(links, 0, sizeof(links)); }
  int capacity() const { return CAPACITY; }

  int count() const {
    int n = 0;
    for (int i = 0; i < CAPACITY; i++) if (links[i].used) n++;
    return n;
  }

  const LinkInfo* at(int i) const { return (i >= 0 && i < CAPACITY && links[i].used) ? &links[i] : NULL; }

  // smoothed SNR of a neighbour, x4 (0 if unknown)
  int snr4(RouteId id) const {
    const LinkInfo* l = find(id);
    return l ? l->snr16 / 4 : 0;
  }

  const LinkInfo* find(RouteId id) const {
    for (int i = 0; i < CAPACITY; i++) if (links[i].used && links[i].id == id) return &links[i];
    return NULL;
  }

  // a packet from repeater id was heard
  void heard(RouteId id, int snr4, uint32_t now, int sf) {
    LinkInfo* l = slot(id);
    if (l == NULL) {
      l = victim();
      *l = LinkInfo();
      l->used = true; l->id = id; l->snr16 = snr4 * 4; l->deliv = 255;
      l->bucket = rawBucket(snr4 - linkSnrFloor4(sf));
    } else {
      int diff = snr4 * 4 - l->snr16;   // exponential average over about the last 8 packets, rounded to nearest
      l->snr16 += (diff + (diff >= 0 ? 4 : -4)) / 8;
    }
    if (l->snr_n < 255) l->snr_n++;
    l->last_heard = now;
    // move buckets only when the margin is 2 dB past the edge
    int margin4 = l->snr16 / 4 - linkSnrFloor4(sf);
    for (;;) {
      if (l->bucket > 0 && margin4 >= edge4(l->bucket - 1) + LINK_HYSTERESIS_X4) { l->bucket--; continue; }
      if (l->bucket < 4 && margin4 < edge4(l->bucket) - LINK_HYSTERESIS_X4) { l->bucket++; continue; }
      break;
    }
  }

  // a packet we forwarded to this neighbour was (ok) or was not heard being passed on
  void forwardResult(RouteId id, bool ok) {
    LinkInfo* l = slot(id);
    if (!l) return;
    int target = ok ? 255 : 0;
    l->deliv = (uint8_t)(l->deliv + (target - (int)l->deliv) / 8);
    if (l->deliv_n < 255) l->deliv_n++;
  }

  // the cost of the link to this neighbour, or LINK_NOT_USABLE
  uint8_t cost(RouteId id) const {
    const LinkInfo* l = find(id);
    if (!l) return LINK_NOT_USABLE;
    uint8_t c = bucketCost(l->bucket);
    if (c == LINK_NOT_USABLE) return c;
    if (l->deliv_n >= LINK_MIN_DELIVERY_SAMPLES) {
      if (l->deliv < 128) return LINK_NOT_USABLE;   // below 50%
      if (l->deliv < 179) c = addCost(c, 3);        // below 70%
      else if (l->deliv < 230) c = addCost(c, 1);   // below 90%
    }
    return c;
  }

  bool forget(RouteId id) {
    LinkInfo* l = slot(id);
    if (!l) return false;
    *l = LinkInfo();
    return true;
  }

private:
  // a free slot, or the neighbour heard longest ago
  LinkInfo* victim() {
    LinkInfo* best = NULL;
    for (int i = 0; i < CAPACITY; i++) {
      if (!links[i].used) return &links[i];
      if (best == NULL || (int32_t)(links[i].last_heard - best->last_heard) < 0) best = &links[i];
    }
    return best;
  }
};

}  // namespace mesh
