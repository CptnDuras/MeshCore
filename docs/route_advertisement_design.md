# Route advertisement between repeaters (design draft)

Status: DRAFT, local experiment. Implemented so far (all opt-in, off by default): per-hop retransmission
(`HopRetryTable.h`, build flag `MESH_HOP_RETRIES`) and the observation-only route cache (`RouteCache.h`, `routes` CLI).
The route tables and routed forwarding described below are NOT implemented. Numbers marked *(unverified)* are assumptions to be checked.

## 1. Problem

Today a client learns a path to each contact by flooding once, then stores the whole hop list (`out_path`
in `ContactInfo`) and source-routes with `ROUTE_TYPE_DIRECT`. Repeaters keep no routing state except the
seen-packet table.

- State lives in clients: one stored path per contact, per client.
- A stored path is brittle. If any repeater on it is down or moved, the send fails until the sender
  floods again. `BaseChatMesh` keeps one `out_path` per contact and replaces it with whatever arrives
  ("first packet wins").
- Every new contact, and every broken path, costs a flood through all repeaters in scope.

Goal: let repeaters learn how to reach each other, so a packet addressed to a destination's *home
repeater* can be forwarded hop by hop from repeater tables. Flood remains the fallback, not the default.

## 2. Terms

- **Repeater ID**: a 2-byte hash of the repeater's public key (the existing path hash size mode already
  allows 2- and 3-byte hashes; 1 byte is too small to be unique with many repeaters).
- **Home repeater** of a client: the first repeater that hears the client's advert. It is the first hash in
  the advert's accumulated path. A sender already receives this when it receives the destination's advert.
- **Route**: for a destination repeater D, a table entry `{next_hop, cost, seq, expires}`.

## 3. Route advertisements

Repeater-to-repeater only. Zero-hop, never forwarded, so they cannot flood. They use
`PAYLOAD_TYPE_CONTROL` with the high bit of the first payload byte set, which `Mesh::onRecvPacket` already
delivers only to direct neighbours (`getPathHashCount() == 0`) and then releases.

Proposed control type `0xA0` *(unverified: `0x80` and `0x90` are used by node discovery; confirm 0xA0 is free)*.

```
byte 0      0xA0 | flags            flags bit0 = triggered (not periodic)
byte 1      hash size (2)
bytes 2-3   originator repeater ID   (the sender of this advert)
byte 4      entry count N
N x entry   dest ID (2) | cost (1) | seq (1)
last 8      MAC (truncated HMAC-SHA256 with the community routing key), optional
```

5 bytes per entry. With a 184-byte payload that is about 30 entries per packet *(unverified: depends on
the final header and MAC sizes)*.

### Rules (distance vector, DSDV style)

- **Cost**: per link `1 + penalty(snr)`; sum along the path; 255 = unreachable. The penalty keeps weak links
  from looking as good as strong ones.
- **Sequence numbers**: a repeater increments its own entry's `seq` on each periodic advert. A route with a
  higher `seq` always wins; equal `seq` and lower cost wins. Prevents loops from stale information.
- **Split horizon with poisoned reverse**: do not advertise a route back to the neighbour it came from (or
  advertise it as unreachable).
- **Timers**: periodic advert every 30 min, jittered +/-20% *(unverified: tune with the simulator)*.
  A route expires after 3 missed periods. Triggered updates only when a cost changes by 2 or more, or a route
  is lost, rate-limited to one per 5 minutes.
- **Authentication**: adverts are accepted only if the MAC verifies with a routing key shared by the
  community's repeater operators. Without it any node could attract traffic. Off by default for lab use.
- **Scope**: advertise only routes for repeaters allowed in the same region set, so regions still partition
  the network.

## 4. Forwarding

### Option A (preferred): envelope

A new payload type `ROUTED` (one of the reserved values 0x0C-0x0E) wraps the original packet:

```
dest home repeater ID (2) | source home repeater ID (2) | ttl (1) | inner packet (header, path, payload)
```

It travels as `ROUTE_TYPE_DIRECT` with `path = [next hop]`, rewritten at each hop:

1. Repeater R receives a DIRECT packet whose `path[0]` is R's ID, payload type `ROUTED`.
2. If dest == R: unwrap and transmit the inner packet to the local client, zero-hop (it is the home repeater).
3. Else look up the next hop N for dest; if none, drop. Decrement ttl (drop at 0). Set `path = [N]` and
   retransmit at priority 0, like other routed traffic.

Advantages:
- The inner packet is untouched, so a destination's `PATH` return (which needs the flood path) keeps working.
- Older repeaters only forward a DIRECT packet when they are named in `path[0]`; the table is built only from
  upgraded repeaters' adverts, so routed packets never rely on an old repeater.
- Source home ID in the envelope lets the destination reply by the same mechanism.

Cost: about 5 bytes of envelope, plus the inner header, so text capacity shrinks by roughly 7 bytes
*(unverified)*.

### Option B: a flag in the existing header

Use payload-version bits for "routed". Smaller, but changes meaning of a field other firmware parses. Not
preferred.

## 5. Sender behaviour

1. Contact known and home repeater known and a routed attempt has not failed recently: send `ROUTED`.
2. No ack within the direct timeout: retry once, then fall back to flood (current behaviour) and mark the route
   suspect for a while.
3. Unknown contact: flood as today. The reply and the destination's advert tell both sides the home repeaters.

Clients that are not updated keep working unchanged.

## 6. Cost and limits

- Control traffic scales with the number of repeaters, not clients.
- Example: 20 repeaters, one 60-byte advert each every 30 min, at roughly 120 ms airtime: about 0.13% channel
  use *(unverified, depends on radio settings)*. Triggered updates add to it.
- Table memory per entry is about 12 bytes in RAM: negligible.
- Not addressed here: client mobility between home repeaters (the stale home is detected by ack failure and
  fallback flood), multipath, multiple frequencies.

## 7. Open questions

1. Is control type 0xA0 and a ROUTED payload type acceptable to the maintainers? This is a protocol change
   and needs discussion upstream before any real implementation.
2. Hash size: 2 bytes enough? 3 for very large networks?
3. How should a home repeater find its clients' reachability when a client roams: through the client's next
   zero-hop advert only?
4. Should repeaters ever convert a flood to a routed packet mid-flight (a route-cache reply, as in DSR)?
   The envelope design makes that possible, but the interaction with flood path accumulation is unresolved.

## 8. Evaluation plan

Build a discrete-event simulator (separate project) that compares: flood only; current MeshCore behaviour
(flood to discover, then cached source route, flood on failure); and this design. Metrics: delivery ratio,
channel utilisation, latency, number of flooded transmissions, control overhead, and behaviour when a repeater
fails.

## 9. Simulation findings (meshsim, 10 seeds, 12 h measured after a 12 h warm-up)

The simulator is a separate project (`~/projects/meshsim`) with its assumptions listed in its README. It
models flood-only, today's cached source routes, and this design on the same topologies. Results are for an
invented geography and a simple radio model: they compare behaviours, they do not predict a real mesh.

What it showed, in plain terms:

1. **The route advert protocol works, but on its own it does not beat cached paths.** Repeaters converge on
   complete tables (each knows every other repeater). With one forward attempt per hop, delivery is no better
   than today's behaviour, and sometimes worse (86% against 88% in the two-town chain).
2. **Per-hop retransmission is what makes unicast pay.** A repeater that forwards a packet listens for the next
   hop to pass it on (a passive acknowledgement) and re-sends it up to twice if it does not. With that, the
   two-town chain goes from 88.4% (flood only) and 88.3% (cached paths) to **93.0%** with the routed design,
   and p95 latency halves (26 s against 52 s). This is a link-layer feature: it applies equally to today's
   source-routed direct packets, where it helped much less (cached paths stayed at 88.3% in that scenario),
   so the route table is doing real work too: it picks links by quality, while a path learned from the first
   flood copy to arrive can include marginal links.
3. **Airtime.** Unicast cuts the flood share of airtime a lot (roughly 55-60% against 100%), but total
   airtime only drops 5-30%, because route adverts and path returns cost something. With a redundant
   backbone, flooding is expensive (1011 s/h) and both unicast modes save 14-30%.
4. **Messages that needed a flood at all** fell from 100% to about 60%. Not lower, because about a fifth of
   messages go to strangers (always cold), plus failures and first contact.
5. **Worst case (flapping repeaters, fading links, flapping backbone): no protocol helps.** Delivery is about
   70% for all three because it is limited by availability: a cross-town message needs the whole chain up at the
   same time. In that regime the routed design adds latency (median 6 s with a 6 s fallback timeout) and about
   as much airtime as flooding. Faster route adverts did not help.
6. **Mobile and transient nodes.** The simulator includes 12 travelling clients (driving between the towns at
   40-80 km/h, staying 20-90 minutes at each stop, sometimes at off-grid camps outside every repeater's reach but
   within range of each other) and 8 aircraft crossing the map at 900 km/h with a 60 km range. Findings:
   - **Aircraft barely matter.** Each one is heard by many far-apart repeaters at once and starts floods in
     several places, but with eight flights in 12 hours delivery moved by about half a point and airtime by
     a few percent.
   - **Travellers matter a lot, mostly through coverage.** They had a repeater in reach only 61% of the time,
     and only 40-47% of messages to or from them were delivered, whichever protocol was used. That is close to
     what coverage alone allows, so no routing scheme can fix it. Overall delivery fell from about 88% to 77%
     (flood-only, cached paths) and 82% (routed).
   - **The routed design held up best around travellers** (46.5% against 42.7% flood-only and 40.4% cached
     paths), because a stale home just causes one failed routed try and a flood, and that flood teaches the
     sender the new home.
   - **Re-advertising when a client's best repeater changes did not help**, and cost 5-7% more airtime.
     The flood fallback already corrects stale homes.
   - **What would help is not routing**: holding messages at the destination's last home repeater until the
     client reappears, or letting clients that can hear each other relay for those out of repeater reach.
7. **Sender policy matters.** Waiting 12 s for an acknowledgement on a stale route and trying twice makes the
   median latency 10+ s in bad conditions. One unicast try and a short timeout is better.

Later experiments (same simulator, 10 seeds):

- **Loose source routing does not reproduce the gain.** Letting repeaters fill in missing hops from their tables (clients
  send only the first and last repeater of their cached path), with or without local repair around a failing hop, stayed at
  about 88% in the two-town chain, the same as today's cached paths. Only the routed envelope reached 93-95%. The likely
  reason is that routed delivery learns a contact's home repeater from any flooded packet, needs no path-return exchange,
  and sends the acknowledgement the same way, while cached paths depend on a fragile pair of path-return packets. So
  "keep the client's full path and just make it looser" is not enough.
- **Two unicast tries before flooding beat one** once per-hop retransmission is on: routed reached 95.3% delivered with 40% of
  messages needing a flood and p95 latency 13.8 s (cached paths: 88.5%, 52.8%, 36.7 s).
- **Ranking repeaters per contact and failing over to the second-best before flooding made no measurable difference**
  (94.7% against 95.3%). The client-to-repeater link was not the weak point in these scenarios.
- **Re-forwarding a duplicate that names this repeater as next hop made no difference** (93.0% against 92.9%).

Implications for the design:

- Treat **passive acknowledgement with retransmission on the next hop** as a required part of any unicast
  forwarding change. It may be worth proposing on its own, since it would also help today's direct routing.
- Route adverts, client adverts and path returns together were 16-22% of airtime in the unicast modes. Route
  adverts every 10 minutes were enough: going faster (down to 2 minutes) did not improve delivery and cost
  more airtime.
- Only worth the complexity where backbones are a thin chain with lossy links. On a dense or redundant mesh,
  or one dominated by outages, the gain is small or negative.

Limits of this evidence: the radio model is simple, the topology is made up, traveller routes and flight
paths are invented, and the
firmware's actual timeouts and retry behaviour for direct messages were only approximated. Real traces from a
repeater (the `routes` CLI command) should be used to check the assumptions before building more.

## 10. Client check-in with a TTL (meshsim, 10 seeds, 24 h run, last 12 h measured)

Idea: a client tells the repeaters it can hear, now and then ("check-in", a ~16 byte zero-hop broadcast), and how long to
believe it (TTL = 2.5 x its check-in period). A repeater records each client as *attached*. When the TTL runs out
without a new check-in the repeater forgets the client, marks it unreachable (cost 255) with the next odd sequence number,
and sends a route advert straight away (at most one per `trigger_min_s`). Repeaters advertise attached clients along with
repeater routes; a client's sequence number is its own check-in counter (even), so a newer location beats an older one and a
withdrawal can never override a later check-in. Senders address the destination client; each repeater forwards by its table, and
the repeater the client is attached to delivers it. No route: drop, and the sender floods as before.

Scenario: two towns, 12 travelling clients, unicast tries 2, hop retries 2, 6 s timeout. "Route right" is sampled every 5 min:
walk the next-hop pointers from each repeater toward each travelling client and see if they end at its true repeater.

| variant | delivered | to/from travellers | messages flooded | control airtime | routes right / stale / missing |
|---|---|---|---|---|---|
| flood only | 76.7% | 42.7% | 100% | 3% | n/a |
| cached paths (today) | 77.3% | 42.1% | 65% | 13% | n/a |
| routed, home learned from floods | 83.7% | 47.4% | 50% | 18% | n/a |
| client routes, no check-ins | 70.7% | 34.3% | 100% | 13% | 0 / 0 / 100% |
| check-in 5 min | 81.6% | 46.9% | 53% | 36% | 70 / 10 / 20% |
| check-in 15 min | 82.2% | 47.6% | 53% | 35% | 59 / 20 / 21% |
| check-in 30 min | 82.0% | 48.0% | 54% | 34% | 47 / 29 / 24% |
| check-in 60 min | 81.5% | 44.9% | 55% | 34% | 34 / 43 / 23% |
| 15 min + check in when moving | 82.3% | 48.0% | 53% | 36% | 74 / 13 / 13% |
| 15 min, TTL 1.5 x | 81.3% | 46.8% | 58% | 35% | 56 / 14 / 30% |
| 15 min, TTL 4 x | 82.3% | 48.0% | 52% | 35% | 61 / 22 / 17% |
| 15 min + move, adverts >= 10 s apart | 82.2% | 49.1% | 54% | 46% | 79 / 11 / 10% |
| 15 min + move, full adverts every 30 min | 83.0% | 48.0% | 52% | 29% | 77 / 12 / 12% |
| HYBRID: travellers only, 15 min + move | 83.1% | 50.5% | 51% | 24% | 80 / 11 / 9% |
| HYBRID, full adverts every 30 min | 83.2% | 49.9% | 50% | 16% | 77 / 12 / 11% |
| HYBRID, 5 min + move, full every 30 min | 83.4% | 50.7% | 50% | 19% | 78 / 6 / 16% |

What it says:

1. **The mechanism works as designed** (unit tests): attach on check-in, withdrawal when the TTL ends, a later check-in beats a
   withdrawal, a handover makes the old repeater let go and the new one take over, triggered adverts carry only what changed.
2. **A 15 minute check-in is a sensible setting for mobile companions**, but only with a check-in on handover. Route accuracy
   to travellers goes 59% (15 min alone) to 74% (with a check-in when the best repeater changes); the period alone barely
   moves delivery (81.5-82.3% for 5-60 min).
3. **Check-ins alone do not beat what we already have.** The existing routed mode (home learned from floods) reaches 83.7%
   with no check-ins at all. Client routes need the check-ins to work (0% correct without them), and then roughly match it.
   The gain shows up only for traffic involving travellers: 47.4% -> 48-50.7%, within noise for single settings but
   consistent across the hybrid rows.
4. **Do it for travellers only.** Having every client check in and every repeater advertise every client is what costs
   control airtime (36-47% of all airtime). Limiting client routes to mobile clients (the client marks itself mobile) cut that
   to 16-24% and gave the best numbers, because static clients' homes are already learned from their own traffic.
5. **Triggered adverts must be rate-limited and the full table sent rarely.** Letting triggered adverts out every 10 s raised
   route accuracy a little but added 20% to airtime; full adverts every 30 min with incremental adverts in between lowered
   control airtime from 36% to 29% with the same accuracy.
6. **TTL**: 1.5 x loses a missed check-in (30% missing routes); 2.5 x to 4 x are similar. 2.5 x is fine.
7. **The ceiling is still coverage.** Travellers are out of every repeater's reach part of the time; no routing scheme can fix
   that. With no travellers, client routes were slightly worse than the existing routed mode (93.6% vs 95.3%).

Recommended shape if built: opt-in `checkin` for mobile companions only (default 15 min, plus on handover), repeater keeps a
small attach table (TTL 2.5 x the period the client states in the check-in), advertises attached clients incrementally,
withdraws on expiry, full table every 30 min.
