#pragma once

#include <stdint.h>
#include <string.h>
#include <MeshCore.h>

namespace mesh {

// why an entry is being waited on
enum HopRole : uint8_t {
  HOP_OWN,        // our own send
  HOP_RELAYED,    // we passed it on for someone else
  HOP_OVERHEARD,  // not for us: we heard it go by, and take it over if the next hop never passes it on
};

/**
 * \brief  Remembers unicast (DIRECT) packets this node has just sent on, so it can send them again if it does
 *         not hear the next repeater pass them along.
 *
 * Why this works: a repeater forwarding a DIRECT packet removes itself from the path and sends the rest, so the
 * packet hash (type + payload) is unchanged and the path is exactly one hop shorter. A node that sent the packet
 * can hear that forward. Hearing it is a free acknowledgement; not hearing it means the next hop missed our packet
 * (or we missed its forward), so we try again, up to a limit.
 *
 * Fixed size, no heap, and no clock of its own (callers pass in the time in milliseconds), so it can be unit
 * tested natively. When the table is full a new packet is simply not tracked: it is still sent, just without retries.
 */
template <int CAPACITY>
class HopRetryTable {
public:
  struct Entry {
    bool     used;
    uint8_t  hash[MAX_HASH_SIZE];
    uint8_t  next_path_count;   // hop count the next repeater's forwarded copy will carry
    uint8_t  tries;             // retries done so far
    uint8_t  raw_len;
    uint8_t  priority;
    uint8_t  role;              // HopRole
    uint32_t due;               // when to give up waiting and send again (millis)
    uint8_t  raw[MAX_TRANS_UNIT];
  };

private:
  Entry entries[CAPACITY];

  static bool reached(uint32_t now, uint32_t due) { return (int32_t)(now - due) >= 0; }  // handles millis() wrap

public:
  HopRetryTable() { clear(); }

  void clear() { memset(entries, 0, sizeof(entries)); }

  int count() const {
    int n = 0;
    for (int i = 0; i < CAPACITY; i++) if (entries[i].used) n++;
    return n;
  }

  /** \returns the slot used, or -1 if there was no room (or the packet is already tracked) */
  int track(const uint8_t* hash, uint8_t next_path_count, const uint8_t* raw, uint8_t raw_len,
            uint8_t priority, uint32_t due, uint8_t role = HOP_OWN) {
    int free_slot = -1;
    for (int i = 0; i < CAPACITY; i++) {
      if (entries[i].used) {
        if (memcmp(entries[i].hash, hash, MAX_HASH_SIZE) == 0) return -1;   // already waiting on this one
      } else if (free_slot < 0) {
        free_slot = i;
      }
    }
    if (free_slot < 0) return -1;
    Entry& e = entries[free_slot];
    e.used = true;
    memcpy(e.hash, hash, MAX_HASH_SIZE);
    e.next_path_count = next_path_count;
    e.tries = 0;
    e.raw_len = raw_len;
    e.priority = priority;
    e.role = role;
    e.due = due;
    memcpy(e.raw, raw, raw_len);
    return free_slot;
  }

  /**
   * \brief  A DIRECT packet was just received. If it is the forwarded copy of one we are waiting on, we are done.
   * \returns true if that cleared an entry
   */
  bool overheard(const uint8_t* hash, uint8_t path_count) {
    for (int i = 0; i < CAPACITY; i++) {
      if (entries[i].used && entries[i].next_path_count == path_count
          && memcmp(entries[i].hash, hash, MAX_HASH_SIZE) == 0) {
        entries[i].used = false;
        return true;
      }
    }
    return false;
  }

  /** \returns the slot of the entry whose wait has run out (the earliest), or -1 */
  int nextDue(uint32_t now) const {
    int best = -1;
    for (int i = 0; i < CAPACITY; i++) {
      if (!entries[i].used || !reached(now, entries[i].due)) continue;
      if (best < 0 || (int32_t)(entries[i].due - entries[best].due) < 0) best = i;
    }
    return best;
  }

  const Entry* at(int slot) const { return (slot >= 0 && slot < CAPACITY && entries[slot].used) ? &entries[slot] : NULL; }

  /** The packet in `slot` has been sent again: wait until `next_due` for the next hop to pass it on. */
  void retried(int slot, uint32_t next_due) {
    if (slot >= 0 && slot < CAPACITY && entries[slot].used) {
      entries[slot].tries++;
      entries[slot].due = next_due;
    }
  }

  /** Stop waiting on `slot`. */
  void release(int slot) {
    if (slot >= 0 && slot < CAPACITY) entries[slot].used = false;
  }
};

}
