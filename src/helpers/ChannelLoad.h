#pragma once

#include <stdint.h>

namespace mesh {

/**
 * \brief  How busy the channel has been around this node: the share of the last minute it spent receiving frames. (spec ext/108, ext/10)
 *
 * Fed with the radio's running total of receive airtime (Dispatcher::getReceiveAirTime). That total only counts frames the radio
 * decoded, so a channel that is busy with collisions reads lower than it is: thresholds are chosen against this measure, not against
 * the share of time anything was on the air.
 *
 * Keeps a sample every 10 seconds, the oldest at least 50 seconds back. Fixed size, no heap, no clock of its own. Times are 32-bit
 * milliseconds and are compared by difference, so they may wrap.
 */
class ChannelLoad {
public:
  enum { SLOTS = 7, STEP_MS = 10000, WINDOW_MS = 60000 };

private:
  uint32_t at_ms[SLOTS];
  uint32_t rx_ms[SLOTS];
  uint8_t head, count;   // head: the newest sample

public:
  ChannelLoad() { clear(); }
  void clear() { head = 0; count = 0; }

  // call as often as is convenient; takes a sample when STEP_MS has passed since the last one
  void update(uint32_t now_ms, uint32_t rx_total_ms) {
    if (count == 0 || (uint32_t)(now_ms - at_ms[head]) >= STEP_MS) {
      head = (uint8_t)((head + 1) % SLOTS);
      at_ms[head] = now_ms;
      rx_ms[head] = rx_total_ms;
      if (count < SLOTS) count++;
    }
  }

  // 0..1000: the share of the window spent receiving. 0 until there is at least STEP_MS of history.
  uint16_t permille(uint32_t now_ms, uint32_t rx_total_ms) const {
    if (count == 0) return 0;
    int oldest = -1;   // the oldest sample still inside the window
    for (int i = 0; i < count; i++) {
      int s = (head + SLOTS - i) % SLOTS;
      if ((uint32_t)(now_ms - at_ms[s]) <= WINDOW_MS) oldest = s; else break;
    }
    if (oldest < 0) return 0;
    uint32_t span = now_ms - at_ms[oldest];
    if (span < STEP_MS) return 0;
    uint32_t rx = rx_total_ms - rx_ms[oldest];
    uint32_t p = (uint32_t)(((uint64_t)rx * 1000) / span);
    return p > 1000 ? 1000 : (uint16_t)p;
  }
};

/**
 * \brief  Extra wait before sending a message again: spacing_ms x (attempts so far) x a random factor of 0.5 to 1.5.
 *
 * Interference comes in bursts and collisions repeat when two senders retry on the same clock. Waiting a little longer each time, by
 * a different amount for each sender, gets the next attempt out of the burst. `attempt` is the one just sent, counted from 0, and
 * `r_permille` a random number from 500 to 1500; anything outside is cut to that range. A spacing of 0 turns it off.
 */
static inline uint32_t retrySpacingMs(uint8_t attempt, uint32_t spacing_ms, uint32_t r_permille) {
  if (spacing_ms == 0) return 0;
  if (r_permille < 500) r_permille = 500;
  if (r_permille > 1500) r_permille = 1500;
  return (uint32_t)(((uint64_t)spacing_ms * (attempt + 1u) * r_permille) / 1000);
}

}
