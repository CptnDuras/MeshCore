#pragma once

#include "RouteTypes.h"

namespace mesh {

/**
 * \brief  The clients that have checked in with this repeater, and for how long each is to be believed.
 *
 * A mobile companion sends a check-in every few minutes (RouteProtocol.h) carrying its own counter (even numbers, increasing) and
 * a time to live. The repeater keeps the client here until that time runs out. The client's counter orders updates, so an old
 * check-in heard late never replaces a newer one. Fixed size, no heap, no clock of its own.
 */
struct AttachEntry {
  RouteId  id;
  uint32_t expires;    // seconds (monotonic)
  uint32_t adv_until;  // when what we last announced about this client runs out (0: never announced)
  uint16_t seq;        // the client's check-in counter
  uint16_t adv_life;
  uint8_t  cost;       // cost of the link from this repeater to the client
  int8_t   snr4;       // SNR of the last check-in, x4
  bool     used;
};

enum CheckinResult : uint8_t {
  CHECKIN_NEW,         // a client we did not have (or one that had lapsed): announce it
  CHECKIN_CHANGED,     // still attached, but its link cost moved by 2 or more: announce it
  CHECKIN_REFRESHED,   // still attached, expiry extended; nothing to announce
  CHECKIN_WITHDRAWN,   // the client said it is going away
  CHECKIN_IGNORED_OLD, // not newer than what we hold
  CHECKIN_NO_ROOM      // table full of clients with plenty of time left
};

template <int CAPACITY>
class AttachTable {
  AttachEntry entries[CAPACITY];

  bool live(const AttachEntry& e, uint32_t now) const { return e.used && timeAhead(e.expires, now); }

  AttachEntry* slot(RouteId id) {
    for (int i = 0; i < CAPACITY; i++) {
      if (entries[i].used && entries[i].id == id) return &entries[i];
    }
    return NULL;
  }

public:
  AttachTable() { clear(); }

  void clear() { memset(entries, 0, sizeof(entries)); }
  int capacity() const { return CAPACITY; }

  int count(uint32_t now) const {
    int n = 0;
    for (int i = 0; i < CAPACITY; i++) if (live(entries[i], now)) n++;
    return n;
  }

  const AttachEntry* at(int i) const { return (i >= 0 && i < CAPACITY && entries[i].used) ? &entries[i] : NULL; }

  const AttachEntry* find(RouteId id, uint32_t now) const {
    for (int i = 0; i < CAPACITY; i++) {
      if (entries[i].used && entries[i].id == id) return live(entries[i], now) ? &entries[i] : NULL;
    }
    return NULL;
  }

  /**
   * \brief  A check-in was heard.
   * \param  counter  the client's counter
   * \param  ttl_s    seconds to believe it (0 = the client is going away)
   * \param  cost     cost of the link to this client, from the SNR of the packet
   */
  CheckinResult checkin(RouteId id, uint16_t counter, uint32_t ttl_s, uint8_t cost, int8_t snr4, uint32_t now) {
    AttachEntry* e = slot(id);
    if (ttl_s == 0) {
      if (e == NULL) return CHECKIN_IGNORED_OLD;
      if (seqNewer(e->seq, counter)) return CHECKIN_IGNORED_OLD;
      *e = AttachEntry();
      return CHECKIN_WITHDRAWN;
    }
    if (e != NULL && live(*e, now)) {
      if (!seqNewer(counter, e->seq)) return CHECKIN_IGNORED_OLD;
      int diff = (int)cost - (int)e->cost;
      e->seq = counter; e->expires = now + ttl_s; e->snr4 = snr4;
      if (diff >= 2 || diff <= -2) { e->cost = cost; return CHECKIN_CHANGED; }
      return CHECKIN_REFRESHED;
    }
    if (e == NULL) e = victim(now, ttl_s);
    if (e == NULL) return CHECKIN_NO_ROOM;
    *e = AttachEntry();
    e->used = true; e->id = id; e->seq = counter; e->expires = now + ttl_s; e->cost = cost; e->snr4 = snr4;
    return CHECKIN_NEW;
  }

  // a free or lapsed slot, else the client closest to lapsing, but never one with more than a quarter of its new life to spare
  AttachEntry* victim(uint32_t now, uint32_t ttl_s) {
    AttachEntry* best = NULL;
    for (int i = 0; i < CAPACITY; i++) {
      if (!live(entries[i], now)) return &entries[i];
      if (best == NULL || (int32_t)(entries[i].expires - best->expires) < 0) best = &entries[i];
    }
    return (best != NULL && (int32_t)(best->expires - now) <= (int32_t)(ttl_s / 4)) ? best : NULL;
  }

  void markAnnounced(RouteId id, uint32_t until, uint16_t life_s) {
    AttachEntry* e = slot(id);
    if (e) { e->adv_until = until; e->adv_life = life_s; }
  }

  /**
   * \brief  Drop clients whose time to live has run out.
   * \param  gone  if not NULL, receives the ids dropped (up to max_gone)
   * \returns  how many were dropped
   */
  int expire(uint32_t now, RouteId* gone = NULL, int max_gone = 0) {
    int n = 0;
    for (int i = 0; i < CAPACITY; i++) {
      if (entries[i].used && !timeAhead(entries[i].expires, now)) {
        if (gone && n < max_gone) gone[n] = entries[i].id;
        entries[i] = AttachEntry();
        n++;
      }
    }
    return n;
  }

  // the client was announced somewhere else with a newer counter: it has moved on
  bool movedAway(RouteId id, uint16_t newer_counter) {
    AttachEntry* e = slot(id);
    if (!e || !seqNewer(newer_counter, e->seq)) return false;
    *e = AttachEntry();
    return true;
  }
};

}  // namespace mesh
