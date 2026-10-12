#pragma once

#include "RouteTypes.h"

namespace mesh {

/**
 * \brief  The route table: for each destination, which neighbouring repeater to send a packet to, what the path costs, and how long
 *         the information may be believed.
 *
 * Entries come from route adverts (RouteProtocol.h). A destination is another repeater or a client attached to some repeater (the
 * `client` flag). The rules are those of a distance-vector protocol with sequence numbers (DSDV):
 *   - an entry is accepted if the destination is new, or the sequence number is newer, or it is the same and the cost is lower,
 *     or it comes from the current next hop with a sequence number that is not older (so a worse cost from the next hop is believed);
 *   - cost 255 means unreachable (a withdrawal). A withdrawn entry stays until its lifetime ends so an older advert cannot bring the
 *     route back.
 *
 * Hysteresis (margin > 0). With the rules above, a newer sequence number from ANY neighbour replaces the route, however much worse it is.
 * Adverts reach a repeater one hop per advert period, so which neighbour's copy is newest is a matter of timing, not of the route's
 * quality, and in a mesh with parallel paths the next hop flips back and forth, each flip announced to the neighbours. So with a margin
 * the current next hop is kept unless it has stopped refreshing (its entry lapses) or another neighbour is cheaper by at least `margin`;
 * the current next hop's own refreshes and cost changes are always believed. A cost change of less than `delta` from the current next
 * hop is believed but not announced (the next full table carries it). margin 0 gives the plain rules above.
 * Fixed size, no heap, no clock of its own (callers pass in the time).
 */
struct RouteTableEntry {
  RouteId  dest;
  RouteId  next;        // the neighbouring repeater to send to
  uint32_t expires;     // seconds (monotonic)
  uint32_t adv_until;   // when what we last told our neighbours about this destination runs out (0: never announced)
  uint16_t seq;
  uint16_t adv_life;    // the lifetime we announced, in seconds
  uint8_t  cost;
  bool     client;
  bool     used;
};

enum RouteAccept : uint8_t {
  ROUTE_NEW,            // a destination we did not know
  ROUTE_CHANGED,        // next hop or cost changed: neighbours should hear about it
  ROUTE_REFRESHED,      // same route, believed for longer
  ROUTE_ADJUSTED,       // same next hop, cost moved by less than the announce threshold: believed, not announced
  ROUTE_WITHDRAWN,      // now known to be unreachable
  ROUTE_IGNORED_OLD,    // an older sequence number than we hold
  ROUTE_IGNORED_WORSE,  // not older, but not better
  ROUTE_IGNORED_UNKNOWN,// a withdrawal for something we never had
  ROUTE_NO_ROOM         // table full of entries that last longer than this one
};

template <int CAPACITY>
class RouteTable {
  RouteTableEntry entries[CAPACITY];

  bool live(const RouteTableEntry& e, uint32_t now) const { return e.used && timeAhead(e.expires, now); }

  RouteTableEntry* slot(RouteId dest) {
    for (int i = 0; i < CAPACITY; i++) {
      if (entries[i].used && entries[i].dest == dest) return &entries[i];
    }
    return NULL;
  }

  // a free slot, or the one that expires soonest
  RouteTableEntry* victim(uint32_t now) {
    RouteTableEntry* best = NULL;
    for (int i = 0; i < CAPACITY; i++) {
      if (!entries[i].used || !timeAhead(entries[i].expires, now)) return &entries[i];
      if (best == NULL || (int32_t)(entries[i].expires - best->expires) < 0) best = &entries[i];
    }
    return best;
  }

public:
  RouteTable() { clear(); }

  void clear() { memset(entries, 0, sizeof(entries)); }
  int capacity() const { return CAPACITY; }

  int count(uint32_t now) const {
    int n = 0;
    for (int i = 0; i < CAPACITY; i++) if (live(entries[i], now)) n++;
    return n;
  }

  const RouteTableEntry* at(int i) const { return (i >= 0 && i < CAPACITY && entries[i].used) ? &entries[i] : NULL; }

  /**
   * \brief  The usable entry whose id starts with these bytes, for packets that name a repeater by the same short hash the path uses
   *         (1 to 3 bytes). Several repeaters can share a short hash; the cheapest route wins, and a wrong guess only costs the
   *         message one failed attempt, after which the sender falls back to flooding.
   */
  const RouteTableEntry* findByPrefix(const uint8_t* prefix, int len, uint32_t now) const {
    const RouteTableEntry* best = NULL;
    for (int i = 0; i < CAPACITY; i++) {
      const RouteTableEntry& e = entries[i];
      if (!live(e, now) || e.cost >= ROUTE_COST_UNREACHABLE) continue;
      bool match = true;
      for (int k = 0; k < len && match; k++) match = (uint8_t)(e.dest >> (24 - 8 * k)) == prefix[k];
      if (match && (best == NULL || e.cost < best->cost)) best = &e;
    }
    return best;
  }

  // the entry for dest if it is usable: not expired and not withdrawn
  const RouteTableEntry* find(RouteId dest, uint32_t now) const {
    for (int i = 0; i < CAPACITY; i++) {
      const RouteTableEntry& e = entries[i];
      if (e.used && e.dest == dest) return (live(e, now) && e.cost < ROUTE_COST_UNREACHABLE) ? &e : NULL;
    }
    return NULL;
  }

  /**
   * \brief  Apply one advertised entry heard from neighbouring repeater `from`.
   * \param  link_cost  cost of the link to `from` (NeighborLinks)
   * \param  adv_cost   cost `from` announced for the destination (255 = unreachable)
   * \param  life_s     how long to believe it without hearing it again
   */
  RouteAccept accept(RouteId dest, RouteId from, uint8_t link_cost, uint8_t adv_cost, uint16_t seq, uint32_t life_s,
                     bool client, uint32_t now, uint8_t margin = 0, uint8_t delta = 0) {
    uint8_t total = adv_cost >= ROUTE_COST_UNREACHABLE ? (uint8_t)ROUTE_COST_UNREACHABLE : addCost(adv_cost, link_cost);
    RouteTableEntry* e = slot(dest);
    bool known = e != NULL && live(*e, now);
    if (!known) {
      if (total == ROUTE_COST_UNREACHABLE) return ROUTE_IGNORED_UNKNOWN;
      if (e == NULL) {
        e = victim(now);
        if (e->used && timeAhead(e->expires, now) && (int32_t)(e->expires - (now + life_s)) > 0) return ROUTE_NO_ROOM;
      }
      *e = RouteTableEntry();
      e->used = true;
      e->dest = dest; e->next = from; e->cost = total; e->seq = seq; e->client = client;
      e->expires = now + life_s;
      return ROUTE_NEW;
    }
    bool newer = seqNewer(seq, e->seq), same = seq == e->seq;
    bool accept;
    if (margin == 0) {
      accept = newer || (same && total < e->cost) || (e->next == from && !seqNewer(e->seq, seq));
    } else {
      // keep the current next hop unless the newcomer is clearly cheaper; its own news (and a withdrawal from it) always counts
      accept = (e->next == from && !seqNewer(e->seq, seq)) ||
               (!seqNewer(e->seq, seq) && total != ROUTE_COST_UNREACHABLE && (int)total + margin <= (int)e->cost);
    }
    if (!accept) return seqNewer(e->seq, seq) ? ROUTE_IGNORED_OLD : ROUTE_IGNORED_WORSE;
    RouteId old_next = e->next;
    uint8_t old_cost = e->cost;
    bool moved = e->next != from || e->cost != total;
    e->next = from; e->cost = total; e->seq = seq; e->client = client;
    e->expires = now + life_s;
    if (total == ROUTE_COST_UNREACHABLE) return ROUTE_WITHDRAWN;
    if (moved && delta > 1 && old_next == from && old_cost != ROUTE_COST_UNREACHABLE) {
      int diff = (int)total - (int)old_cost;
      if ((diff < 0 ? -diff : diff) < delta) return ROUTE_ADJUSTED;
    }
    return moved ? ROUTE_CHANGED : ROUTE_REFRESHED;
  }

  // remember what we announced about dest, for the dynamic refresh scheme
  void markAnnounced(RouteId dest, uint32_t until, uint16_t life_s) {
    RouteTableEntry* e = slot(dest);
    if (e) { e->adv_until = until; e->adv_life = life_s; }
  }

  // drop everything learned from a neighbour (it rebooted, or went silent)
  int dropVia(RouteId next) {
    int n = 0;
    for (int i = 0; i < CAPACITY; i++) {
      if (entries[i].used && entries[i].next == next) { entries[i] = RouteTableEntry(); n++; }
    }
    return n;
  }

  // forget entries whose lifetime has ended; returns how many
  int expire(uint32_t now) {
    int n = 0;
    for (int i = 0; i < CAPACITY; i++) {
      if (entries[i].used && !timeAhead(entries[i].expires, now)) { entries[i] = RouteTableEntry(); n++; }
    }
    return n;
  }

  bool remove(RouteId dest) {
    RouteTableEntry* e = slot(dest);
    if (!e) return false;
    *e = RouteTableEntry();
    return true;
  }
};

}  // namespace mesh
