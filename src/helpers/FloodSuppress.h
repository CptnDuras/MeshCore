#pragma once

#include <stdint.h>
#include <string.h>

namespace mesh {

/**
 * \brief  When a repeater drops its queued relay of a flood, and how it spreads its adverts. (spec ext/10, ext/50)
 *
 * A relay waiting in the queue is dropped after k other copies of the flood have been heard. A fixed k is wrong at both ends:
 * in a dense area one copy is enough, but a repeater that is the only bridge to some node must always send. FLOOD_CANCEL_AUTO
 * picks k from how many other repeaters this one hears directly: 8 or more gives 1, 3 to 7 gives 2, fewer than 3 never cancels.
 * Settings 1 to 8 are a fixed k, 0 is off (stock).
 */
#define FLOOD_CANCEL_AUTO  9

static inline uint8_t floodCancelCopies(uint8_t setting, int repeaters_heard) {
  if (setting != FLOOD_CANCEL_AUTO) return setting <= 8 ? setting : 0;
  if (repeaters_heard >= 8) return 1;
  if (repeaters_heard >= 3) return 2;
  return 0;
}

/**
 * \brief  The repeaters this node has heard passing on a flood in the last 24 hours.
 *
 * A flood's path ends with the hash of the repeater that sent this copy, so the last hash is a neighbour we hear directly. The hash
 * is as long as the path hash size the flood uses (1, 2 or 3 bytes: 2 or 4 or 6 hex characters), and the whole of it is compared, so
 * with 2-byte hashes two repeaters that share a first byte are still two. Floods of different hash sizes can come from the same
 * repeater: a shorter hash matches a longer one that starts with it, counts once, and the longer is kept.
 *
 * Fixed size, no heap. When the table is full the entry heard longest ago is replaced. Times are minutes in 16 bits, so an entry
 * older than 45 days could look recent again; a repeater that has not been heard for that long is not worth counting.
 */
class HeardRepeaters {
public:
  enum { CAPACITY = 64, WINDOW_MIN = 24 * 60 };

private:
  struct Entry { uint8_t hash[3]; uint8_t size; uint16_t at; };   // size 0: unused
  Entry e[CAPACITY];

public:
  HeardRepeaters() { clear(); }
  void clear() { memset(e, 0, sizeof(e)); }

  void note(const uint8_t* hash, uint8_t size, uint32_t now_s) {
    if (size == 0) return;
    if (size > 3) size = 3;
    uint16_t now = (uint16_t)(now_s / 60);
    int free_slot = -1, oldest = 0;
    for (int i = 0; i < CAPACITY; i++) {
      if (e[i].size == 0) { if (free_slot < 0) free_slot = i; continue; }
      uint8_t n = e[i].size < size ? e[i].size : size;
      if (memcmp(e[i].hash, hash, n) == 0) {
        e[i].at = now;
        if (size > e[i].size) { memcpy(e[i].hash, hash, size); e[i].size = size; }
        return;
      }
      if ((uint16_t)(now - e[i].at) > (uint16_t)(now - e[oldest].at)) oldest = i;
    }
    Entry& s = e[free_slot >= 0 ? free_slot : oldest];
    memcpy(s.hash, hash, size);
    s.size = size;
    s.at = now;
  }

  int count(uint32_t now_s) const {
    uint16_t now = (uint16_t)(now_s / 60);
    int n = 0;
    for (int i = 0; i < CAPACITY; i++) {
      if (e[i].size && (uint16_t)(now - e[i].at) <= WINDOW_MIN) n++;
    }
    return n;
  }
};

// One advert gap multiplied by r_permille / 1000, r_permille in 900..1100: nodes that booted together stop advertising together.
static inline uint32_t advertJitterMs(uint32_t base_ms, uint32_t r_permille) {
  if (r_permille < 900) r_permille = 900;
  if (r_permille > 1100) r_permille = 1100;
  return (uint32_t)(((uint64_t)base_ms * r_permille) / 1000);
}

}
