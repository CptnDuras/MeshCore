#pragma once

#include "RouteTypes.h"
#include "RouteTable.h"
#include "AttachTable.h"
#include "NeighborLinks.h"
#include "RouteProtocol.h"

namespace mesh {

/**
 * \brief  What a repeater does with its route tables: who it tells what and when, and what it believes of what it is told.
 *
 * This joins the three tables (NeighborLinks, AttachTable, RouteTable) with the rules of the route table specification. It has no
 * radio and no clock: callers pass in received check-ins and adverts and the time in seconds (monotonic, never the settable
 * real-time clock), and ask for the adverts to send. That keeps the protocol testable on a PC.
 *
 * Telling neighbours:
 *   - changes (a client attached or moved or left, a route that appeared, changed or was lost) are announced soon, at most one advert
 *     per min_gap_s, and sent `repeats` times in all unless a neighbour is heard passing the change on (its relay is the acknowledgement);
 *   - freshness: either the whole table every full_period_s (30 minutes or more, jittered 10%), or, with full_period_s = 0, lifetimes:
 *     each entry carries how long it may be believed and a repeater re-announces what it originates when refresh_pct of that
 *     lifetime is left.
 * A client that stops checking in is not withdrawn: its lifetime in every copy runs out at about the same time. A client that says
 * it is going away, or moves, is withdrawn at once.
 */
struct RoutingConfig {
  uint8_t  id_bytes;       // 2 to 4
  uint8_t  sf;             // spreading factor, for the SNR floor
  uint16_t full_period_s;  // 0 = lifetimes; else 1800 or more
  uint16_t life_s;         // lifetimes mode: how long this repeater's own entry is believed
  uint8_t  refresh_pct;    // lifetimes mode: refresh when this much of a lifetime is left
  uint16_t min_gap_s;      // at most one advert per this many seconds
  uint8_t  repeats;        // times a change is sent in all
  uint8_t  settle_s;       // wait this long after a change so several can go in one advert

  RoutingConfig()
      : id_bytes(ROUTE_ID_BYTES_DEFAULT), sf(7), full_period_s(3600), life_s(7200), refresh_pct(67), min_gap_s(60), repeats(2),
        settle_s(2) {}
};

struct RoutingStats {
  uint32_t adverts_in, entries_in, entries_new, entries_changed, entries_refreshed, entries_ignored;
  uint32_t adverts_from_unusable_links, entries_about_us, entries_about_attached;
  uint32_t checkins_in, checkins_ignored;
  uint32_t adverts_out, entries_out, repeats_cancelled;
};

enum RouteWhere : uint8_t { ROUTE_NONE, ROUTE_LOCAL, ROUTE_VIA };

struct RouteLookup {
  RouteWhere where;
  RouteId    next;    // ROUTE_VIA: the neighbouring repeater to send to
  uint8_t    cost;
};

template <int NEIGHBOURS, int CLIENTS, int ROUTES>
class RoutingCore {
public:
  NeighborLinks<NEIGHBOURS> links;
  AttachTable<CLIENTS>      attached;
  RouteTable<ROUTES>        routes;
  RoutingStats              stats;

private:
  enum { MAX_PENDING = ROUTES + CLIENTS, MAX_OUT = ROUTES + CLIENTS + 1 };

  struct Pending {
    RouteId  dest;
    uint32_t not_before;
    uint16_t wseq;        // withdrawals: the sequence number to announce
    uint8_t  left;        // sends still to make
    bool     withdraw;
    bool     used;
  };

  RoutingConfig cfg;
  RouteId       self;
  uint16_t      my_seq;
  Pending       pending[MAX_PENDING];
  AdvEntry      outq[MAX_OUT];
  int           out_n, out_at;
  bool          out_full;
  uint32_t      next_full, last_sent, self_until, self_life;
  bool          started;
  uint32_t      rng;

  uint32_t rnd() { rng ^= rng << 13; rng ^= rng >> 17; rng ^= rng << 5; return rng; }

  RouteId mask(RouteId id) const { return id & routeIdMask(cfg.id_bytes); }

  uint32_t advLife() const {   // the lifetime to announce for a repeater's own entry, and an upper bound for the rest
    uint32_t life = cfg.full_period_s ? (uint32_t)cfg.full_period_s * 3 : cfg.life_s;
    return life > ROUTE_LIFE_UNIT_S * 255 ? ROUTE_LIFE_UNIT_S * 255 : life;
  }

  uint32_t jittered(uint32_t period) { return period - period / 10 + rnd() % (period / 5 + 1); }

  Pending* findPending(RouteId dest) {
    for (int i = 0; i < MAX_PENDING; i++) if (pending[i].used && pending[i].dest == dest) return &pending[i];
    return NULL;
  }

  void announce(RouteId dest, bool withdraw, uint16_t wseq, uint32_t now) {
    Pending* p = findPending(dest);
    if (p == NULL) {
      for (int i = 0; i < MAX_PENDING && p == NULL; i++) if (!pending[i].used) p = &pending[i];
    }
    if (p == NULL) return;   // cannot happen: as many slots as entries; if it does, the next full table covers it
    p->used = true; p->dest = dest; p->withdraw = withdraw; p->wseq = wseq;
    p->left = cfg.repeats ? cfg.repeats : 1;
    p->not_before = now + cfg.settle_s;
  }

  // the entry to announce for dest right now, or false if there is nothing true to say
  bool entryFor(RouteId dest, bool withdraw, uint16_t wseq, uint32_t now, AdvEntry& e) {
    uint32_t cap = advLife();
    if (withdraw) {
      e.dest = dest; e.cost = ROUTE_COST_UNREACHABLE; e.seq = wseq; e.life_s = (uint16_t)cap;
      return true;
    }
    if (dest == self) {
      e.dest = self; e.cost = 0; e.seq = my_seq; e.life_s = (uint16_t)cap;
      return true;
    }
    const AttachEntry* a = attached.find(dest, now);
    if (a) {
      uint32_t left = a->expires - now;
      e.dest = dest; e.cost = a->cost; e.seq = a->seq; e.life_s = (uint16_t)(left > cap ? cap : left);
      return true;
    }
    for (int i = 0; i < routes.capacity(); i++) {
      const RouteTableEntry* r = routes.at(i);
      if (r && r->dest == dest && timeAhead(r->expires, now)) {
        uint32_t left = r->expires - now;
        e.dest = dest; e.cost = r->cost; e.seq = r->seq; e.life_s = (uint16_t)(left > cap ? cap : left);
        return true;
      }
    }
    return false;
  }

  void noteAnnounced(const AdvEntry& e, uint32_t now) {
    uint32_t until = now + e.life_s;
    if (e.dest == self) { self_until = until; self_life = e.life_s; }
    else if (attached.find(e.dest, now)) attached.markAnnounced(e.dest, until, e.life_s);
    else routes.markAnnounced(e.dest, until, e.life_s);
  }

  void push(const AdvEntry& e) {
    for (int i = 0; i < out_n; i++) if (outq[i].dest == e.dest) { outq[i] = e; return; }
    if (out_n < MAX_OUT) outq[out_n++] = e;
  }

  void fillFull(uint32_t now) {
    AdvEntry e;
    entryFor(self, false, 0, now, e);
    push(e);
    for (int i = 0; i < attached.capacity(); i++) {
      const AttachEntry* a = attached.at(i);
      if (a && entryFor(a->id, false, 0, now, e)) push(e);
    }
    for (int i = 0; i < routes.capacity(); i++) {
      const RouteTableEntry* r = routes.at(i);
      if (r && timeAhead(r->expires, now) && entryFor(r->dest, false, 0, now, e)) push(e);
    }
    out_full = true;
    for (int i = 0; i < MAX_OUT && i < out_n; i++) noteAnnounced(outq[i], now);
    for (int i = 0; i < MAX_PENDING; i++) pending[i].used = false;   // the whole table covers every change
  }

  // lifetimes mode: is what we last announced about dest running low?
  bool lowOn(uint32_t until, uint16_t life, uint32_t now) const {
    if (until == 0) return false;   // never announced: the first full table or the announcement of a change covers it
    uint32_t left = timeAhead(until, now) ? until - now : 0;
    return left * 100 <= (uint32_t)life * cfg.refresh_pct;
  }

  void fillChanges(uint32_t now) {
    AdvEntry e;
    for (int i = 0; i < MAX_PENDING; i++) {
      Pending& p = pending[i];
      if (!p.used || (int32_t)(p.not_before - now) > 0) continue;
      if (entryFor(p.dest, p.withdraw, p.wseq, now, e)) {
        push(e);
        if (!p.withdraw) noteAnnounced(e, now);
      }
      if (p.left > 0) p.left--;
      if (p.left == 0) p.used = false;
      else p.not_before = now + cfg.min_gap_s;
    }
    if (cfg.full_period_s == 0) {   // lifetimes: refresh what this repeater originates, and relay news that outlasts what was said
      if (lowOn(self_until, self_life, now) && entryFor(self, false, 0, now, e)) { push(e); noteAnnounced(e, now); }
      for (int i = 0; i < attached.capacity(); i++) {
        const AttachEntry* a = attached.at(i);
        if (a && timeAhead(a->expires, now) && lowOn(a->adv_until, a->adv_life, now) && entryFor(a->id, false, 0, now, e)) {
          push(e); noteAnnounced(e, now);
        }
      }
      for (int i = 0; i < routes.capacity(); i++) {
        const RouteTableEntry* r = routes.at(i);
        if (r && r->cost < ROUTE_COST_UNREACHABLE && timeAhead(r->expires, now) && (r->adv_until == 0 || timeAhead(r->expires, r->adv_until)) &&
            lowOn(r->adv_until, r->adv_life, now) && entryFor(r->dest, false, 0, now, e)) {
          push(e); noteAnnounced(e, now);
        }
      }
    }
  }

  bool anyDue(uint32_t now) const {
    for (int i = 0; i < MAX_PENDING; i++) if (pending[i].used && (int32_t)(pending[i].not_before - now) <= 0) return true;
    return cfg.full_period_s == 0;   // lifetimes mode checks refresh on every look; fillChanges decides
  }

public:
  /**
   * \param seq  this repeater's own sequence number for its own entry. It must be higher than the number it used before it last
   *             restarted (use something that grows across restarts), or neighbours keep believing the old incarnation's routes.
   */
  RoutingCore(RouteId self_id, uint16_t seq, const RoutingConfig& config = RoutingConfig())
      : cfg(config), self(self_id & routeIdMask(config.id_bytes)), my_seq(seq), out_n(0), out_at(0), out_full(false), next_full(0),
        last_sent(0), self_until(0), self_life(0), started(false), rng(self_id ^ 0x9E3779B9u) {
    if (rng == 0) rng = 1;
    memset(pending, 0, sizeof(pending));
    memset(&stats, 0, sizeof(stats));
  }

  const RoutingConfig& config() const { return cfg; }
  RouteId id() const { return self; }
  uint16_t seq() const { return my_seq; }

  // ---- hearing neighbours ----

  // any packet from a directly heard repeater: keeps its link quality up to date
  void onHeardRepeater(RouteId repeater, int snr4, uint32_t now) { links.heard(mask(repeater), snr4, now, cfg.sf); }

  // a packet we forwarded to this repeater was (or was not) heard being passed on
  void onForwardResult(RouteId repeater, bool heard) { links.forwardResult(mask(repeater), heard); }

  // ---- clients ----

  void onCheckin(const Checkin& c, int snr4, uint32_t now) {
    stats.checkins_in++;
    RouteId id = mask(c.id);
    if (id == self) { stats.checkins_ignored++; return; }
    uint8_t cost = linkCostFromSnr4(snr4, cfg.sf);
    if (cost == LINK_NOT_USABLE && !c.going_away) { stats.checkins_ignored++; return; }
    uint32_t ttl = c.going_away ? 0 : c.ttl_s;
    CheckinResult r = attached.checkin(id, c.counter, ttl, cost, (int8_t)snr4, now);
    switch (r) {
      case CHECKIN_NEW:
      case CHECKIN_CHANGED:
        announce(id, false, 0, now);
        break;
      case CHECKIN_WITHDRAWN:
        routes.remove(id);
        announce(id, true, (uint16_t)(c.counter + 1), now);
        break;
      case CHECKIN_REFRESHED:
        break;
      default:
        stats.checkins_ignored++;
    }
  }

  // ---- hearing adverts ----

  void onRouteAdv(const RouteAdv& adv, int snr4, uint32_t now) {
    RouteId from = mask(adv.origin);
    if (from == self) return;
    stats.adverts_in++;
    onHeardRepeater(from, snr4, now);
    if (adv.reply_requested) next_full = now + 1 + rnd() % 10;
    uint8_t link = links.cost(from);
    if (link == LINK_NOT_USABLE) { stats.adverts_from_unusable_links++; return; }
    for (int k = 0; k < adv.count; k++) {
      const AdvEntry& e = adv.entries[k];
      RouteId dest = mask(e.dest);
      stats.entries_in++;
      cancelIfRelayed(dest, e.seq, from, now);
      if (dest == self) { stats.entries_about_us++; continue; }
      const AttachEntry* local = attached.find(dest, now);
      if (local) {
        stats.entries_about_attached++;
        if (!seqNewer(e.seq, local->seq)) continue;            // what we heard from the client directly is at least as new
        if (e.cost >= ROUTE_COST_UNREACHABLE) continue;        // a withdrawal elsewhere is not news about a client we just heard
        attached.movedAway(dest, e.seq);                       // it has checked in elsewhere since: it moved on
      }
      RouteAccept r = routes.accept(dest, from, link, e.cost, e.seq, e.life_s, false, now);
      switch (r) {
        case ROUTE_NEW:
        case ROUTE_CHANGED:
        case ROUTE_WITHDRAWN:
          (r == ROUTE_NEW ? stats.entries_new : stats.entries_changed)++;
          announce(dest, false, 0, now);
          break;
        case ROUTE_REFRESHED: stats.entries_refreshed++; break;
        default: stats.entries_ignored++;
      }
    }
  }

private:
  // A neighbour passing on a change we announced is its acknowledgement: stop repeating it. For something we learned from a
  // neighbour, that neighbour repeating its own advert does not count; another repeater passing it on does.
  void cancelIfRelayed(RouteId dest, uint16_t seq, RouteId from, uint32_t now) {
    Pending* p = findPending(dest);
    if (p == NULL || p->left >= (cfg.repeats ? cfg.repeats : 1)) return;   // nothing sent yet
    uint16_t ours;
    if (p->withdraw) {
      ours = p->wseq;
    } else if (const AttachEntry* a = attached.find(dest, now)) {
      ours = a->seq;
    } else {
      const RouteTableEntry* r = NULL;
      for (int i = 0; i < routes.capacity() && r == NULL; i++) {
        const RouteTableEntry* e = routes.at(i);
        if (e && e->dest == dest) r = e;
      }
      if (r == NULL || r->next == from) return;
      ours = r->seq;
    }
    if (seqNewer(ours, seq)) return;   // what they repeat is older than what we announced
    p->used = false;
    stats.repeats_cancelled++;
  }

public:
  // ---- sending ----

  /**
   * \brief  The next advert to send, if any is due. Call repeatedly until it returns false.
   *         A full table that does not fit one packet comes out as several, all with `full` set.
   */
  bool nextAdvert(uint32_t now, RouteAdv& out) {
    if (!started) {   // the first full table goes out shortly after start
      started = true;
      next_full = now + 1 + rnd() % 30;
      last_sent = now - cfg.min_gap_s;
    }
    if (out_n == out_at) {
      out_n = out_at = 0;
      out_full = false;
      bool full_due = (int32_t)(next_full - now) <= 0;
      if (full_due) {
        fillFull(now);
        next_full = cfg.full_period_s ? now + jittered(cfg.full_period_s) : now + 0x7FFFFFFF;
      } else if (anyDue(now) && (int32_t)(now - last_sent) >= (int32_t)cfg.min_gap_s) {
        fillChanges(now);
      }
      if (out_n == 0) return false;
      last_sent = now;
    }
    int max = routeAdvMaxEntries(cfg.id_bytes);
    int n = out_n - out_at < max ? out_n - out_at : max;
    out.full = out_full;
    out.reply_requested = false;
    out.id_bytes = cfg.id_bytes;
    out.origin = self;
    out.count = n;
    for (int i = 0; i < n; i++) out.entries[i] = outq[out_at + i];
    out_at += n;
    stats.adverts_out++;
    stats.entries_out += n;
    return true;
  }

  // ---- housekeeping and use ----

  // forget what has lapsed; clients whose time to live ran out are dropped without a word
  void expire(uint32_t now) {
    attached.expire(now);
    routes.expire(now);
  }

  RouteLookup lookup(RouteId dest, uint32_t now) const {
    RouteLookup r = {ROUTE_NONE, 0, 0};
    dest &= routeIdMask(cfg.id_bytes);
    const AttachEntry* a = attached.find(dest, now);
    if (a) { r.where = ROUTE_LOCAL; r.cost = a->cost; return r; }
    const RouteTableEntry* e = routes.find(dest, now);
    if (e) { r.where = ROUTE_VIA; r.next = e->next; r.cost = e->cost; }
    return r;
  }
};

}  // namespace mesh
