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
 * \brief  The repeaters this node has heard passing on a flood in the last 24 hours, counted by the first byte of their hash.
 *
 * A flood's path ends with the hash of the repeater that sent this copy, so the last hash is a neighbour we hear directly. Two
 * neighbours that share a first byte count once, which only makes the count a little low. Times are minutes in 16 bits, so an
 * entry older than 45 days could look recent again; a repeater that has not been heard for that long is not worth counting.
 */
class HeardRepeaters {
  uint16_t at[256];
  uint8_t used[32];

public:
  static const uint16_t WINDOW_MIN = 24 * 60;

  HeardRepeaters() { clear(); }
  void clear() { memset(at, 0, sizeof(at)); memset(used, 0, sizeof(used)); }

  void note(uint8_t hash_first_byte, uint32_t now_s) {
    at[hash_first_byte] = (uint16_t)(now_s / 60);
    used[hash_first_byte >> 3] |= (uint8_t)(1 << (hash_first_byte & 7));
  }

  int count(uint32_t now_s) const {
    uint16_t now = (uint16_t)(now_s / 60);
    int n = 0;
    for (int i = 0; i < 256; i++) {
      if ((used[i >> 3] & (1 << (i & 7))) && (uint16_t)(now - at[i]) <= WINDOW_MIN) n++;
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
