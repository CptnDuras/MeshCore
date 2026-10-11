#include <gtest/gtest.h>
#include <functional>
#include <vector>
#include "helpers/RoutingCore.h"

using namespace mesh;

typedef RoutingCore<8, 8, 16> Core;

static const RouteId R0 = 0x10000000, R1 = 0x20000000, R2 = 0x30000000, R3 = 0x40000000, C = 0xD90E4417;

struct Sent {
    uint32_t t;
    int from;
    RouteAdv adv;
};

// repeaters that hear their neighbours; every advert goes through the real wire encoder and decoder
struct Net {
    std::vector<Core*> cores;
    std::vector<std::vector<int>> hears;   // hears[i] = who hears i
    std::vector<Sent> sent;
    std::function<bool(int, int, const RouteAdv&)> drop;
    int snr4 = 40;                          // 10 dB: link cost 1

    int add(Core* c) { cores.push_back(c); hears.push_back({}); return (int)cores.size() - 1; }
    void link(int a, int b) { hears[a].push_back(b); hears[b].push_back(a); }

    void deliver(int from, const RouteAdv& adv, uint32_t t) {
        uint8_t buf[200];
        int n = encodeRouteAdv(adv, buf, sizeof(buf));
        ASSERT_GT(n, 0);
        for (int to : hears[from]) {
            RouteAdv copy = {};
            ASSERT_TRUE(decodeRouteAdv(buf, n, copy));
            if (drop && drop(from, to, copy)) continue;
            cores[to]->onRouteAdv(copy, snr4, t);
        }
    }

    void run(uint32_t from, uint32_t to) {
        for (uint32_t t = from; t < to; t++) {
            for (size_t i = 0; i < cores.size(); i++) {
                RouteAdv adv;
                while (cores[i]->nextAdvert(t, adv)) {
                    sent.push_back({t, (int)i, adv});
                    deliver((int)i, adv, t);
                }
            }
            for (auto* c : cores) c->expire(t);
        }
    }

    int countWith(int from, RouteId dest, uint32_t t0, uint32_t t1) const {
        int n = 0;
        for (auto& s : sent) {
            if (s.from != from || s.t < t0 || s.t >= t1) continue;
            for (int k = 0; k < s.adv.count; k++) if (s.adv.entries[k].dest == dest) { n++; break; }
        }
        return n;
    }
};

static Checkin checkin(RouteId id, uint16_t counter, uint16_t ttl = 2248, bool going_away = false) {
    Checkin c = {};
    c.mobile = true; c.going_away = going_away; c.id_bytes = 4; c.id = id; c.counter = counter; c.ttl_s = ttl;
    return c;
}

// three repeaters in a chain
struct Chain {
    Core a, b, c;
    Net net;
    int ia, ib, ic;
    explicit Chain(RoutingConfig cfg = RoutingConfig()) : a(R0, 100, cfg), b(R1, 100, cfg), c(R2, 100, cfg) {
        ia = net.add(&a); ib = net.add(&b); ic = net.add(&c);
        net.link(ia, ib); net.link(ib, ic);
    }
};

TEST(RoutingCore, TheFirstFullTableGoesOutShortlyAfterStart) {
    Chain n;
    n.net.run(1000, 1040);
    for (int i = 0; i < 3; i++) {
        bool found = false;
        for (auto& s : n.net.sent) {
            if (s.from == i && s.adv.full) {
                found = true;
                EXPECT_EQ(0, s.adv.entries[0].cost);                               // its own entry first
                EXPECT_EQ(n.net.cores[i]->id(), s.adv.entries[0].dest);
                EXPECT_EQ(100, s.adv.entries[0].seq);
            }
        }
        EXPECT_TRUE(found) << "repeater " << i;
    }
}

TEST(RoutingCore, NeighboursLearnEachOther) {
    Chain n;
    n.net.run(1000, 1100);
    RouteLookup l = n.b.lookup(R0, 1100);
    EXPECT_EQ(ROUTE_VIA, l.where);
    EXPECT_EQ(R0, l.next);
    EXPECT_EQ(1, l.cost);
    EXPECT_EQ(ROUTE_VIA, n.a.lookup(R1, 1100).where);
}

TEST(RoutingCore, RoutesSpreadDownTheChainWithTheCostsAdded) {
    Chain n;
    n.net.run(1000, 1200);
    RouteLookup l = n.a.lookup(R2, 1200);
    ASSERT_EQ(ROUTE_VIA, l.where);
    EXPECT_EQ(R1, l.next);
    EXPECT_EQ(2, l.cost);
    EXPECT_EQ(R1, n.c.lookup(R0, 1200).next);
}

TEST(RoutingCore, ACheckedInClientIsLocalHereAndRoutedToElsewhere) {
    Chain n;
    n.net.run(1000, 1100);
    n.c.onCheckin(checkin(C, 2), 40, 1100);
    n.net.run(1100, 1200);
    EXPECT_EQ(ROUTE_LOCAL, n.c.lookup(C, 1200).where);
    RouteLookup l = n.b.lookup(C, 1200);
    ASSERT_EQ(ROUTE_VIA, l.where);
    EXPECT_EQ(R2, l.next);
    EXPECT_EQ(2, l.cost);                       // 1 to the client + 1 to R2
    l = n.a.lookup(C, 1200);
    ASSERT_EQ(ROUTE_VIA, l.where);
    EXPECT_EQ(R1, l.next);
    EXPECT_EQ(3, l.cost);
}

TEST(RoutingCore, AClientThatMovesIsPickedUpByTheNewRepeaterAndDroppedByTheOldOne) {
    Chain n;
    n.net.run(1000, 1100);
    n.c.onCheckin(checkin(C, 2), 40, 1100);
    n.net.run(1100, 1200);
    ASSERT_EQ(ROUTE_LOCAL, n.c.lookup(C, 1200).where);
    n.a.onCheckin(checkin(C, 4), 40, 1200);      // it drove past: now at R0
    n.net.run(1200, 1320);
    EXPECT_EQ(ROUTE_LOCAL, n.a.lookup(C, 1320).where);
    RouteLookup l = n.c.lookup(C, 1320);          // R2 let go without waiting for the time to live
    ASSERT_EQ(ROUTE_VIA, l.where);
    EXPECT_EQ(R1, l.next);
    EXPECT_EQ(R1, n.b.lookup(C, 1320).next == R0 ? R1 : 0);
}

TEST(RoutingCore, AClientThatStopsCheckingInLapsesEverywhereAtAboutTheSameTime) {
    Chain n;
    n.net.run(1000, 1100);
    n.c.onCheckin(checkin(C, 2, 2248), 40, 1100);   // time to live ends at 3348
    n.net.run(1100, 3300);
    EXPECT_NE(ROUTE_NONE, n.c.lookup(C, 3300).where);
    EXPECT_NE(ROUTE_NONE, n.a.lookup(C, 3300).where);
    n.net.run(3300, 3700);                           // quantised lifetimes may add up to a couple of minutes
    EXPECT_EQ(ROUTE_NONE, n.c.lookup(C, 3700).where);
    EXPECT_EQ(ROUTE_NONE, n.b.lookup(C, 3700).where);
    EXPECT_EQ(ROUTE_NONE, n.a.lookup(C, 3700).where);
}

TEST(RoutingCore, AClientGoingAwayIsWithdrawnAtOnceAndAnOldCheckinCannotBringItBack) {
    Chain n;
    n.net.run(1000, 1100);
    n.c.onCheckin(checkin(C, 2), 40, 1100);
    n.net.run(1100, 1200);
    ASSERT_EQ(ROUTE_VIA, n.a.lookup(C, 1200).where);
    n.c.onCheckin(checkin(C, 4, 0, true), 40, 1200);
    n.net.run(1200, 1260);
    EXPECT_EQ(ROUTE_NONE, n.c.lookup(C, 1260).where);
    EXPECT_EQ(ROUTE_NONE, n.b.lookup(C, 1260).where);
    EXPECT_EQ(ROUTE_NONE, n.a.lookup(C, 1260).where);
    n.c.onCheckin(checkin(C, 2), 40, 1260);          // the first check-in, heard late
    n.net.run(1260, 1400);
    EXPECT_EQ(ROUTE_NONE, n.a.lookup(C, 1400).where);   // the withdrawal (seq 5) is newer than the old counter (2)... 
}

TEST(RoutingCore, AChangeIsSentTwiceUnlessANeighbourPassesItOn) {
    // R2 hears R1 relay the change, so it does not repeat it
    Chain n;
    n.net.run(1000, 1100);
    n.c.onCheckin(checkin(C, 2), 40, 1100);
    n.net.run(1100, 1300);
    EXPECT_EQ(1, n.net.countWith(n.ic, C, 1100, 1300));

    // R1 is deaf to R2's change: nobody relays it back, so R2 repeats it once
    Chain m;
    m.net.run(1000, 1100);
    m.net.drop = [&](int from, int to, const RouteAdv&) { return from == m.ib && to == m.ic; };   // R2 never hears R1
    m.c.onCheckin(checkin(C, 2), 40, 1100);
    m.net.run(1100, 1300);
    EXPECT_EQ(2, m.net.countWith(m.ic, C, 1100, 1300));
}

TEST(RoutingCore, ANeighbourRepeatingItsOwnChangeDoesNotCancelOurRelayOfIt) {
    // R2 attaches the client; nobody relays anything back (R0 and R1 are deaf to everyone but R2). R1 relays C and repeats the relay;
    // R2's own repeat of C reaches R1 in between and must not count as "someone passed our relay on".
    Chain n;
    n.net.run(1000, 1100);
    n.net.drop = [&](int from, int to, const RouteAdv&) { return from == n.ia || (from == n.ib && to == n.ic); };
    n.c.onCheckin(checkin(C, 2), 40, 1100);
    n.net.run(1100, 1400);
    EXPECT_EQ(2, n.net.countWith(n.ic, C, 1100, 1400));   // R2 repeated its own change (it never heard it relayed)
    EXPECT_EQ(2, n.net.countWith(n.ib, C, 1100, 1400));   // and R1 sent its relay twice
}

TEST(RoutingCore, ALostFirstCopyIsMadeUpByTheRepeat) {
    Chain n;
    n.net.run(1000, 1100);
    int copies = 0;
    n.net.drop = [&](int from, int to, const RouteAdv& adv) {
        if (from != n.ic || to != n.ib) return false;
        for (int k = 0; k < adv.count; k++) if (adv.entries[k].dest == C) return ++copies == 1;   // lose the first copy that mentions C
        return false;
    };
    n.c.onCheckin(checkin(C, 2), 40, 1100);
    n.net.run(1100, 1300);
    EXPECT_EQ(ROUTE_VIA, n.b.lookup(C, 1300).where);     // the second copy got through
    EXPECT_EQ(2, n.net.countWith(n.ic, C, 1100, 1300));
}

TEST(RoutingCore, NoMoreThanOneAdvertPerMinimumGap) {
    Chain n;
    n.net.run(1000, 1100);
    size_t before = n.net.sent.size();
    n.c.onCheckin(checkin(C, 2), 40, 1100);
    n.c.onCheckin(checkin(0x11111111, 2), 40, 1105);
    n.c.onCheckin(checkin(0x22222222, 2), 40, 1110);
    n.net.run(1100, 1159);
    int from_c = 0;
    for (size_t i = before; i < n.net.sent.size(); i++) if (n.net.sent[i].from == n.ic) from_c++;
    EXPECT_LE(from_c, 1);
}

TEST(RoutingCore, SeveralChangesTogetherShareOneAdvert) {
    Chain n;
    n.net.run(1000, 1100);
    n.c.onCheckin(checkin(C, 2), 40, 1100);
    n.c.onCheckin(checkin(0x11111111, 2), 40, 1100);
    n.net.run(1100, 1110);
    for (auto& s : n.net.sent) {
        if (s.from == n.ic && s.t >= 1100) {
            EXPECT_EQ(2, s.adv.count);
            return;
        }
    }
    FAIL() << "no advert sent";
}

TEST(RoutingCore, TheFullTableComesEveryPeriodWithTenPercentJitter) {
    RoutingConfig cfg;
    cfg.full_period_s = 3600;
    Chain n(cfg);
    n.net.run(1000, 1000 + 4 * 3600);
    std::vector<uint32_t> times;
    for (auto& s : n.net.sent) if (s.from == n.ia && s.adv.full) times.push_back(s.t);
    ASSERT_GE(times.size(), 4u);
    for (size_t i = 1; i < times.size(); i++) {
        EXPECT_GE(times[i] - times[i - 1], 3240u) << "gap " << i;
        EXPECT_LE(times[i] - times[i - 1], 3960u) << "gap " << i;
    }
}

TEST(RoutingCore, AFullTableLargerThanOnePacketIsSplitAndEveryPacketIsMarkedFull) {
    RoutingCore<8, 8, 64> a(R0, 1);
    for (uint32_t i = 1; i <= 40; i++) {
        RouteAdv adv = {};
        adv.id_bytes = 4; adv.origin = R1; adv.count = 1;
        adv.entries[0] = {(RouteId)(0x50000000u + i * 0x10000u), 1, 5, 3000};
        a.onRouteAdv(adv, 40, 100);
    }
    int packets = 0, entries = 0;
    RouteAdv out;
    for (uint32_t t = 100; t < 200; t++) {
        while (a.nextAdvert(t, out)) {
            if (!out.full) continue;
            packets++;
            entries += out.count;
            EXPECT_LE(out.count, 18);
        }
    }
    EXPECT_GE(packets, 3);
    EXPECT_GE(entries, 41);   // 40 routes + itself
}

TEST(RoutingCore, IgnoresWhatIsSaidAboutItself) {
    Core a(R0, 1);
    RouteAdv adv = {};
    adv.id_bytes = 4; adv.origin = R1; adv.count = 1;
    adv.entries[0] = {R0, 3, 9, 3000};
    a.onRouteAdv(adv, 40, 100);
    EXPECT_EQ(1u, a.stats.entries_about_us);
    EXPECT_EQ(ROUTE_NONE, a.lookup(R0, 100).where);
}

TEST(RoutingCore, AnOlderAdvertAboutAnAttachedClientIsIgnoredAndANewerOneMovesIt) {
    Core a(R0, 1);
    a.onCheckin(checkin(C, 10), 40, 100);
    RouteAdv adv = {};
    adv.id_bytes = 4; adv.origin = R1; adv.count = 1;
    adv.entries[0] = {C, 1, 8, 2000};
    a.onRouteAdv(adv, 40, 110);
    EXPECT_EQ(ROUTE_LOCAL, a.lookup(C, 110).where);       // what the client told us is newer
    adv.entries[0].seq = 10;
    a.onRouteAdv(adv, 40, 111);
    EXPECT_EQ(ROUTE_LOCAL, a.lookup(C, 111).where);       // equal counts as no news
    adv.entries[0].seq = 12;
    a.onRouteAdv(adv, 40, 112);
    RouteLookup l = a.lookup(C, 112);
    ASSERT_EQ(ROUTE_VIA, l.where);                        // it checked in at R1 since
    EXPECT_EQ(R1, l.next);
}

TEST(RoutingCore, AWithdrawalElsewhereDoesNotRemoveAClientWeJustHeard) {
    Core a(R0, 1);
    a.onCheckin(checkin(C, 10), 40, 100);
    RouteAdv adv = {};
    adv.id_bytes = 4; adv.origin = R1; adv.count = 1;
    adv.entries[0] = {C, ROUTE_COST_UNREACHABLE, 12, 2000};
    a.onRouteAdv(adv, 40, 110);
    EXPECT_EQ(ROUTE_LOCAL, a.lookup(C, 110).where);
}

TEST(RoutingCore, AdvertsFromAnUnusableLinkAreIgnored) {
    Core a(R0, 1);
    RouteAdv adv = {};
    adv.id_bytes = 4; adv.origin = R1; adv.count = 1;
    adv.entries[0] = {R2, 1, 5, 3000};
    a.onRouteAdv(adv, -50, 100);                          // -12.5 dB: below the SF7 floor
    EXPECT_EQ(1u, a.stats.adverts_from_unusable_links);
    EXPECT_EQ(ROUTE_NONE, a.lookup(R2, 100).where);
    a.onRouteAdv(adv, 40, 101);                           // one good packet does not win the link back: the SNR is averaged
    EXPECT_EQ(ROUTE_NONE, a.lookup(R2, 101).where);
    for (uint32_t t = 102; t < 120; t++) a.onRouteAdv(adv, 40, t);
    EXPECT_EQ(ROUTE_VIA, a.lookup(R2, 120).where);        // a run of them does
}

TEST(RoutingCore, ACheckinFromAnUnusableLinkIsIgnored) {
    Core a(R0, 1);
    a.onCheckin(checkin(C, 2), -50, 100);
    EXPECT_EQ(ROUTE_NONE, a.lookup(C, 100).where);
    EXPECT_EQ(1u, a.stats.checkins_ignored);
}

TEST(RoutingCore, AReplyRequestBringsAFullTableSoon) {
    Chain n;
    n.net.run(1000, 1100);
    size_t before = n.net.sent.size();
    RouteAdv ask = {};
    ask.id_bytes = 4; ask.origin = R1; ask.reply_requested = true;
    n.a.onRouteAdv(ask, 40, 1100);
    n.net.run(1100, 1115);
    bool full = false;
    for (size_t i = before; i < n.net.sent.size(); i++) if (n.net.sent[i].from == n.ia && n.net.sent[i].adv.full) full = true;
    EXPECT_TRUE(full);
}

TEST(RoutingCore, ARestartWithAHigherSequenceReplacesTheOldIncarnationAndALowerOneDoesNot) {
    Chain n;
    n.net.run(1000, 1100);
    ASSERT_EQ(100, n.b.routes.find(R0, 1100)->seq);

    Core restarted(R0, 200);                                // R0 rebooted with a higher number
    Net m;
    int ib = m.add(&n.b), ir = m.add(&restarted);
    m.link(ib, ir);
    m.run(1100, 1200);
    EXPECT_EQ(200, n.b.routes.find(R0, 1200)->seq);

    Core stale(R0, 50);                                     // one that forgot its number
    Net k;
    int ib2 = k.add(&n.b), is = k.add(&stale);
    k.link(ib2, is);
    k.run(1200, 1300);
    EXPECT_EQ(200, n.b.routes.find(R0, 1300)->seq);         // the neighbour keeps believing the newer one
}

TEST(RoutingCore, LifetimesModeRefreshesWhatItOriginatesWhenAThirdOfTheLifetimeHasGone) {
    RoutingConfig cfg;
    cfg.full_period_s = 0;
    cfg.life_s = 1200;
    cfg.refresh_pct = 67;
    Chain n(cfg);
    n.net.run(1000, 1060);
    n.c.onCheckin(checkin(C, 2, 1200), 40, 1060);
    n.net.run(1060, 1200);                                  // a minute between each repeater's adverts: two hops take about two minutes
    EXPECT_EQ(ROUTE_VIA, n.a.lookup(C, 1200).where);
    n.net.run(1200, 2000);
    // R0's own entry: announced at start, then again when 67% of the 1200 s is left, i.e. after about 396 s
    std::vector<uint32_t> own;
    for (auto& s : n.net.sent) {
        if (s.from != n.ia) continue;
        for (int k = 0; k < s.adv.count; k++) if (s.adv.entries[k].dest == R0) own.push_back(s.t);
    }
    ASSERT_GE(own.size(), 3u);
    EXPECT_GE(own[1] - own[0], 380u);
    EXPECT_LE(own[1] - own[0], 470u);
    EXPECT_GE(own[2] - own[1], 380u);
    EXPECT_LE(own[2] - own[1], 470u);
    // the client's entry is refreshed on the same schedule, from the time it was last announced
    std::vector<uint32_t> cl;
    for (auto& s : n.net.sent) {
        if (s.from != n.ic) continue;
        for (int k = 0; k < s.adv.count; k++) if (s.adv.entries[k].dest == C) cl.push_back(s.t);
    }
    ASSERT_GE(cl.size(), 2u);
    EXPECT_GE(cl[1] - cl[0], 380u);
}

TEST(RoutingCore, LifetimesModeKeepsRoutesAliveIndefinitelyWhileTheClientKeepsCheckingIn) {
    RoutingConfig cfg;
    cfg.full_period_s = 0;
    cfg.life_s = 1200;
    Chain n(cfg);
    n.net.run(1000, 1060);
    uint16_t counter = 2;
    for (uint32_t t = 1060; t < 6000; t += 300) {
        n.c.onCheckin(checkin(C, counter, 900), 40, t);
        counter += 2;
        n.net.run(t, t + 300);
        ASSERT_EQ(ROUTE_VIA, n.a.lookup(C, t + 299).where) << "t=" << t;
        ASSERT_EQ(ROUTE_VIA, n.a.lookup(R2, t + 299).where) << "t=" << t;
    }
}

TEST(RoutingCore, TheIdLengthIsAConfigurationOfTheWholeNetwork) {
    RoutingConfig cfg;
    cfg.id_bytes = 2;
    Core a(0x10203040, 1, cfg), b(0x50607080, 1, cfg);
    EXPECT_EQ(0x10200000u, a.id());
    Net n;
    int ia = n.add(&a), ib = n.add(&b);
    n.link(ia, ib);
    n.run(1000, 1100);
    EXPECT_EQ(ROUTE_VIA, a.lookup(0x50607080, 1100).where);   // lookups accept a longer id and cut it
    EXPECT_EQ(ROUTE_VIA, a.lookup(0x5060FFFF, 1100).where);   // ... which also means two nodes sharing 2 bytes are the same node
}

int main(int argc, char** argv) {
    ::testing::InitGoogleTest(&argc, argv);
    return RUN_ALL_TESTS();
}
