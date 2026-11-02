# Auto-regions on upstream regions: design note

Status: design only. Nothing in this note is implemented; the beacons below do not exist yet.
Source of the numbers: the simulator in `~/projects/cellsim` (README section "Auto-regions as upstream regions", `scope.v`, `formation.v`).

## Goal

Repeaters work out their own regions and configure themselves, so nobody types `region put` on hundreds of repeaters, while the
regions stay ordinary upstream regions that stock repeaters understand. A manual setting must always win over the automatic one.

## What upstream gives us (read from this tree)

- A region is a name (`RegionEntry.name`, 30 characters) with a flags byte. `putRegion(name, parent, id)` adds one; the
  key behind it is derived from the name (`TransportKeyStore::getAutoKeyFor`). `REGION_DENY_FLOOD` stops a repeater relaying floods
  of that region.
- A scoped flood is `ROUTE_TYPE_TRANSPORT_FLOOD`: `transport_codes[0]` is a 2-byte HMAC of the payload type and payload under the
  region key. `findMatch` tests the code against each region the repeater holds; the match is flat, `parent` only shapes the listing.
- `transport_codes[1]` travels with the packet and nothing reads it.
- A repeater holds at most `MAX_REGION_ENTRIES` (32) regions. Unscoped floods are relayed while the wildcard allows it.
- Home and default region (`setHomeRegion`, `setDefaultRegion`) already exist and survive restarts through `RegionMap::save`.

## Design

1. **Formation.** Each repeater periodically sends a small beacon to its neighbours only (zero hop): region id, anchor hash, tree
   parent, subtree size, eccentricity. Repeaters join, found, fold and split regions with the rules in `formation.v` (sticky
   `lock`, merge into a bigger neighbour, collision rename). Beacons are a new frame, so a stock repeater drops them; that is fine
   because they never need to cross more than one hop.
2. **Binding to upstream.** A formed region gets a deterministic name from its anchor, for example `auto-<anchor hex>`, so every
   member derives the same name and key. Each repeater writes into its own `RegionMap`:
   - its own region (the home region, flood allowed),
   - the "R+1" scope (its region and the neighbouring regions) and the "R+2" scope, as separate named entries,
   so it relays every scope that reaches its region. The simulator needed about 20 entries per repeater (maximum 31) at 24 regions.
3. **Manual override.** A region set by hand (`region put`, or a pin) is marked pinned: formation never renames, moves or merges it,
   and repeaters next to a pinned region join it. Mode `region.auto` has three states: `auto` (default), `manual` (form nothing,
   only the pins) and `off` (stock behaviour, no beacons).
4. **Senders.** The sender floods under the narrowest scope that holds the destination, widens one step for each flood that gets no
   answer, and finally floods unscoped. It learns a contact's region from `transport_codes[1]`, where the sender puts its own
   region (harmless to stock, which does not read it). A client learns its own region name from the repeater it hears.
5. **Mixed networks.** Stock repeaters carry a scope only if someone typed it in. A stock repeater with no regions drops every
   scoped flood, and in the simulator that doubled the median latency at 50% stock; the sender's ladder then falls back to unscoped
   floods. A per-network switch to stop scoping would remove that loss.

## What the simulator says it is worth

At 500 repeaters and 6000 clients, auto-regions of about 25 repeaters saved 3 to 6 points of airtime and changed confirmed delivery
by -2.7 to +2.4 points (better only at 3x load); median latency rose 0.7 to 3 s. The compat tournament never admitted it as a delivery
feature. The value is **setup**: about 20 entries per repeater, roughly 10,000 across 500 repeaters, typed by hand and redone
whenever a repeater is added, against none with auto assignment. Regions also keep short address hashes apart, since a hash only
has to be unique inside the region it is used in (not yet measured).

## Open questions before building

- **Beacon carrier.** A new payload type is simplest, but a type that stock repeaters already accept (advert app-data, or the
  CONTROL type) would also work on a stock repeater's own radio. Check whether stock repeaters forward either; the
  simulator assumes zero-hop beacons are ignored.
- **The 32-entry limit.** 43 regions of 15 repeaters hit it on 13 repeaters and cost about 1.5 points; region size and the R+2
  scope need a cap that follows the limit.
- **Renames.** A rename changes the key, so every stale scope falls back through the ladder until clients refresh. Renaming all
  regions at once cost about 1 point and +4 s median latency until clients refreshed; renames should be rare and batched.
- **Clients.** Learning the region, writing `transport_codes[1]` and the widening ladder need client (app or companion firmware)
  changes; none exist yet.
- **Unscoped hop limit.** `flood_max_unscoped` is not modelled; it would favour scoping.
- **Hardware.** All numbers are from the simulator; nothing here has been tried on radios.

## Suggested order

1. Companion/app: send the sender's region in `transport_codes[1]` and read it (no repeater change).
2. Repeater: `region.auto` pref, binding of a hand-given region plan to R+1/R+2 entries (a "plan" command that writes the entries).
3. Repeater: beacons and formation, behind `region.auto auto`.
