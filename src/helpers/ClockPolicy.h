#pragma once

#include <stddef.h>
#include <stdint.h>

// When the node's clock may be set or moved. Pure rules, so they can be tested off the board.

#define CLOCK_MAX_AHEAD_SECS (365UL * 24 * 3600) // a stamp or clock more than this ahead of the real time is taken as wrong

// A host asks to set the clock to `secs`. Never backwards, except to correct a clock that is more than a year ahead
// (a wrongly set RTC), or when the sender says to set exactly this (`force`).
inline bool clockSetAllowed(uint32_t secs, uint32_t current, bool force) {
  return force || secs >= current || current - secs > CLOCK_MAX_AHEAD_SECS;
}

// The set-time frame is the command byte, 4 bytes of seconds, and optionally a sixth byte: 1 means set exactly this time.
// Apps that send five bytes are never forced.
inline bool clockSetForced(const uint8_t* frame, size_t len) {
  return len >= 6 && frame[5] == 1;
}

// After a reset the newest contact stamp is a good floor for the clock. Contacts are stamped with the clock as it was when
// they were heard, and they are saved, so a stamp made while the clock was wrong would otherwise set the date back to that
// wrong value at every boot. Feed it each stamp; it ignores those more than a year ahead of the clock, and never moves the
// clock back.
class BootClockFloor {
  uint32_t _now, _ceiling, _latest = 0;

public:
  explicit BootClockFloor(uint32_t now) : _now(now), _ceiling(now + CLOCK_MAX_AHEAD_SECS) {}

  void add(uint32_t stamp) {
    if (stamp > _latest && stamp <= _ceiling) _latest = stamp;
  }
  // true and the new time when the clock should move forward
  bool newTime(uint32_t& out) const {
    if (_latest == 0 || _latest < _now) return false;
    out = _latest + 1;
    return true;
  }
};
