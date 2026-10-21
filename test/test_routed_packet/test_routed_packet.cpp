#include <gtest/gtest.h>
#include "helpers/RoutedPacket.h"
#include "helpers/RouteTable.h"
#include "helpers/RoutingCore.h"
#include <vector>
#include <functional>

using namespace mesh;

static const uint8_t INNER[] = {0x08, 0x00, 0x11, 0x22, 0x33, 0x44, 0x55};

TEST(RoutedPacket, TheEnvelopeRoundTripsForEveryHashSize) {
    for (int h = 1; h <= 3; h++) {
        uint8_t dest[3] = {0xA1, 0xA2, 0xA3}, src[3] = {0xB1, 0xB2, 0xB3};
        uint8_t buf[MAX_PACKET_PAYLOAD];
        int n = routedEncode(buf, h, 16, dest, src, INNER, sizeof(INNER));
        ASSERT_EQ(2 + 2 * h + (int)sizeof(INNER), n) << "hash size " << h;
        RoutedEnvelope e;
        ASSERT_TRUE(routedDecode(buf, n, e));
        EXPECT_EQ(h, e.hsize);
        EXPECT_EQ(16, e.ttl);
        EXPECT_EQ(0, memcmp(e.dest, dest, h));
        EXPECT_EQ(0, memcmp(e.src, src, h));
        ASSERT_EQ(sizeof(INNER), e.inner_len);
        EXPECT_EQ(0, memcmp(e.inner, INNER, sizeof(INNER)));
    }
}

TEST(RoutedPacket, ARoutedPayloadMustFitInAPacket) {
    uint8_t dest[3] = {1, 2, 3}, src[3] = {4, 5, 6}, buf[MAX_PACKET_PAYLOAD + 10], big[MAX_PACKET_PAYLOAD];
    memset(big, 7, sizeof(big));
    EXPECT_EQ(MAX_PACKET_PAYLOAD, routedEncode(buf, 1, 16, dest, src, big, MAX_PACKET_PAYLOAD - 4));   // exactly full
    EXPECT_EQ(0, routedEncode(buf, 1, 16, dest, src, big, MAX_PACKET_PAYLOAD - 3));                    // one byte too many
    EXPECT_EQ(0, routedEncode(buf, 0, 16, dest, src, INNER, sizeof(INNER)));                           // bad hash size
    EXPECT_EQ(0, routedEncode(buf, 4, 16, dest, src, INNER, sizeof(INNER)));
    EXPECT_EQ(0, routedEncode(buf, 2, 16, dest, src, INNER, 0));                                       // nothing inside
}

TEST(RoutedPacket, MalformedPayloadsAreRefused) {
    RoutedEnvelope e;
    uint8_t ok[] = {1, 16, 0xAA, 0xBB, 0x01, 0x02};
    EXPECT_TRUE(routedDecode(ok, sizeof(ok), e));
    EXPECT_FALSE(routedDecode(ok, 2, e));                    // too short
    EXPECT_FALSE(routedDecode(ok, 4, e));                    // header and addresses but no inner packet
    uint8_t zero[] = {0, 16, 0xAA, 0xBB, 1, 2};
    EXPECT_FALSE(routedDecode(zero, sizeof(zero), e));       // hash size 0
    uint8_t four[] = {3 | 0x04, 16, 1, 2, 3, 4, 5, 6, 7, 8};
    EXPECT_FALSE(routedDecode(four, sizeof(four), e));       // reserved bits set
    uint8_t cut[] = {3, 16, 1, 2, 3, 4, 5, 6};
    EXPECT_FALSE(routedDecode(cut, sizeof(cut), e));         // cut off inside the addresses
}

TEST(RoutedPacket, TheIdentityIgnoresTheTtlButNotTheRest) {
    uint8_t dest[2] = {1, 2}, src[2] = {3, 4}, a[64], b[64], c[64], d[64];
    int na = routedEncode(a, 2, 16, dest, src, INNER, sizeof(INNER));
    int nb = routedEncode(b, 2, 15, dest, src, INNER, sizeof(INNER));      // the next hop's copy: ttl one lower
    uint8_t other[] = {0x09, 0x00, 0x11, 0x22, 0x33, 0x44, 0x55};   // (the test build's stand-in SHA-256 only mixes the first bytes into its output)
    int nc = routedEncode(c, 2, 16, dest, src, other, sizeof(other));      // a different message
    uint8_t dest2[2] = {1, 9};
    int nd = routedEncode(d, 2, 16, dest2, src, INNER, sizeof(INNER));     // a different destination
    uint8_t ha[MAX_HASH_SIZE], hb[MAX_HASH_SIZE], hc[MAX_HASH_SIZE], hd[MAX_HASH_SIZE];
    routedIdentity(a, na, ha); routedIdentity(b, nb, hb); routedIdentity(c, nc, hc); routedIdentity(d, nd, hd);
    EXPECT_EQ(0, memcmp(ha, hb, MAX_HASH_SIZE));
    EXPECT_NE(0, memcmp(ha, hc, MAX_HASH_SIZE));
    EXPECT_NE(0, memcmp(ha, hd, MAX_HASH_SIZE));
}

// ---- what a repeater does with an envelope ----

struct FakeRouter {
    RouteTable<8> routes;
};

static const RouteId SELF = 0x11223344, FAR = 0xA1B2C3D4, NEAR_ = 0xA1FFFFFF, NEXT = 0x55667788, OTHER = 0x99887766;

static RoutedEnvelope envelope(const uint8_t* dest, int h, uint8_t ttl) {
    RoutedEnvelope e = {};
    e.hsize = h; e.ttl = ttl;
    memcpy(e.dest, dest, h);
    return e;
}

static const uint8_t SELF_KEY[4] = {0x11, 0x22, 0x33, 0x44};

TEST(RoutedForward, TheDestinationsHomeUnwrapsIt) {
    FakeRouter r;
    uint8_t dest[2] = {0x11, 0x22};
    RoutedDecision d = routedDecide(r, SELF_KEY, envelope(dest, 2, 5), 0);
    EXPECT_EQ(ROUTED_DELIVER, d.action);
    uint8_t one[1] = {0x11};
    EXPECT_EQ(ROUTED_DELIVER, routedDecide(r, SELF_KEY, envelope(one, 1, 0), 0).action);   // even with no ttl left: it is here
}

TEST(RoutedForward, ItGoesToTheNextHopForTheDestinationInTheTable) {
    FakeRouter r;
    r.routes.accept(FAR, NEXT, 1, 3, 10, 600, false, 0);
    uint8_t dest[2] = {0xA1, 0xB2};
    RoutedDecision d = routedDecide(r, SELF_KEY, envelope(dest, 2, 5), 1);
    ASSERT_EQ(ROUTED_FORWARD, d.action);
    EXPECT_EQ(0x55, d.next[0]);
    EXPECT_EQ(0x66, d.next[1]);
    EXPECT_FALSE(d.next_is_dest);
    EXPECT_EQ(4, d.cost);
}

TEST(RoutedForward, WhenTheNextHopIsTheDestinationItIsSaidSo) {
    FakeRouter r;
    r.routes.accept(NEXT, NEXT, 1, 0, 10, 600, false, 0);     // a neighbour, one hop
    uint8_t dest[3] = {0x55, 0x66, 0x77};
    RoutedDecision d = routedDecide(r, SELF_KEY, envelope(dest, 3, 5), 1);
    ASSERT_EQ(ROUTED_FORWARD, d.action);
    EXPECT_TRUE(d.next_is_dest);
}

TEST(RoutedForward, NoRouteMeansDrop) {
    FakeRouter r;
    uint8_t dest[2] = {0xA1, 0xB2};
    EXPECT_EQ(ROUTED_DROP, routedDecide(r, SELF_KEY, envelope(dest, 2, 5), 1).action);
}

TEST(RoutedForward, AnExpiredOrWithdrawnRouteIsNotUsed) {
    FakeRouter r;
    r.routes.accept(FAR, NEXT, 1, 3, 10, 100, false, 0);
    uint8_t dest[2] = {0xA1, 0xB2};
    EXPECT_EQ(ROUTED_FORWARD, routedDecide(r, SELF_KEY, envelope(dest, 2, 5), 50).action);
    EXPECT_EQ(ROUTED_DROP, routedDecide(r, SELF_KEY, envelope(dest, 2, 5), 101).action);          // lifetime ended
    r.routes.accept(FAR, NEXT, 1, 3, 11, 600, false, 110);
    r.routes.accept(FAR, NEXT, 1, ROUTE_COST_UNREACHABLE, 12, 600, false, 120);
    EXPECT_EQ(ROUTED_DROP, routedDecide(r, SELF_KEY, envelope(dest, 2, 5), 130).action);          // withdrawn
}

TEST(RoutedForward, TtlStopsAPacketThatHasGoneRound) {
    FakeRouter r;
    r.routes.accept(FAR, NEXT, 1, 3, 10, 600, false, 0);
    uint8_t dest[2] = {0xA1, 0xB2};
    EXPECT_EQ(ROUTED_FORWARD, routedDecide(r, SELF_KEY, envelope(dest, 2, 1), 1).action);
    EXPECT_EQ(ROUTED_DROP, routedDecide(r, SELF_KEY, envelope(dest, 2, 0), 1).action);
}

TEST(RoutedForward, ASharedShortHashGoesToTheCheaperRoute) {
    FakeRouter r;
    r.routes.accept(FAR, NEXT, 1, 8, 10, 600, false, 0);      // cost 9
    r.routes.accept(NEAR_, OTHER, 1, 2, 10, 600, false, 0);   // cost 3, same first byte
    uint8_t dest[1] = {0xA1};
    RoutedDecision d = routedDecide(r, SELF_KEY, envelope(dest, 1, 5), 1);
    ASSERT_EQ(ROUTED_FORWARD, d.action);
    EXPECT_EQ(0x99, d.next[0]);
    uint8_t exact[3] = {0xA1, 0xB2, 0xC3};                    // three bytes tell them apart
    d = routedDecide(r, SELF_KEY, envelope(exact, 3, 5), 1);
    ASSERT_EQ(ROUTED_FORWARD, d.action);
    EXPECT_EQ(0x55, d.next[0]);
}

TEST(RoutedForward, AHashLongerThanTheTableKeepsIsComparedOnlyAsFarAsTheTableKnows) {
    FakeRouter r;
    r.routes.accept(0xA1B20000, NEXT, 1, 3, 10, 600, false, 0);   // a table with 2-byte ids: the low bytes are zero
    uint8_t dest[3] = {0xA1, 0xB2, 0xC3};                            // but the packet names it with 3 bytes
    EXPECT_EQ(ROUTED_DROP, routedDecide(r, SELF_KEY, envelope(dest, 3, 5), 1).action);              // compared in full: no match
    EXPECT_EQ(ROUTED_FORWARD, routedDecide(r, SELF_KEY, envelope(dest, 3, 5), 1, 2).action);        // compared as far as the table goes
}

TEST(RoutedForward, FindByPrefixIgnoresAnythingElse) {
    RouteTable<8> t;
    t.accept(FAR, NEXT, 1, 3, 10, 600, false, 0);
    uint8_t miss[2] = {0xA1, 0xB3};
    EXPECT_EQ(nullptr, t.findByPrefix(miss, 2, 1));
    uint8_t hit[2] = {0xA1, 0xB2};
    ASSERT_NE(nullptr, t.findByPrefix(hit, 2, 1));
    EXPECT_EQ(FAR, t.findByPrefix(hit, 2, 1)->dest);
}

// ---- the whole way across a chain of repeaters whose tables were built by real adverts ----

typedef RoutingCore<8, 8, 16> Core;

struct Chain {
    std::vector<Core*> cores;
    std::vector<uint8_t> keys;     // first key byte of each repeater
    void add(Core* c, uint8_t first_byte) { cores.push_back(c); keys.push_back(first_byte); }
    void converge(uint32_t from, uint32_t to) {
        for (uint32_t t = from; t < to; t++) {
            for (size_t i = 0; i < cores.size(); i++) {
                RouteAdv adv;
                while (cores[i]->nextAdvert(t, adv)) {
                    uint8_t buf[200];
                    int n = encodeRouteAdv(adv, buf, sizeof(buf));
                    for (size_t j : {i - 1, i + 1}) {      // a chain: each hears its two neighbours
                        if (j >= cores.size()) continue;
                        RouteAdv copy = {};
                        ASSERT_TRUE(decodeRouteAdv(buf, n, copy));
                        cores[j]->onRouteAdv(copy, 40, t);
                    }
                }
            }
        }
    }
};

TEST(RoutedForward, AnEnvelopeCrossesAChainHopByHopAndComesOutAtTheDestinationsHome) {
    const RouteId ids[4] = {0x10000001, 0x20000002, 0x30000003, 0x40000004};
    Core r0(ids[0], 100), r1(ids[1], 100), r2(ids[2], 100), r3(ids[3], 100);
    Chain net;
    net.add(&r0, 0x10); net.add(&r1, 0x20); net.add(&r2, 0x30); net.add(&r3, 0x40);
    net.converge(1000, 1300);
    Core* core[4] = {&r0, &r1, &r2, &r3};
    ASSERT_EQ(ROUTE_VIA, r0.lookup(ids[3], 1300).where);       // the tables are real

    // a client next to r0 sends to someone whose home is r3: envelope with 2-byte hashes
    uint8_t dest[2] = {0x40, 0x00}, src[2] = {0x10, 0x00};
    uint8_t inner[] = {0x0A, 0x00, 0xDE, 0xAD, 0xBE, 0xEF};
    uint8_t payload[64];
    int n = routedEncode(payload, 2, 16, dest, src, inner, sizeof(inner));
    ASSERT_GT(n, 0);
    uint8_t path[3] = {0x10, 0x00};                              // the nearest repeater, r0
    int at = 0, hops = 0;
    for (;; hops++) {
        ASSERT_LT(hops, 10) << "the envelope is going round in circles";
        uint8_t me[2] = {(uint8_t)(ids[at] >> 24), (uint8_t)(ids[at] >> 16)};
        ASSERT_EQ(0, memcmp(path, me, 2)) << "the envelope is addressed to a repeater other than the one acting on it";
        uint8_t self_key[4] = {(uint8_t)(ids[at] >> 24), (uint8_t)(ids[at] >> 16), (uint8_t)(ids[at] >> 8), (uint8_t)ids[at]};
        RoutedEnvelope e;
        ASSERT_TRUE(routedDecode(payload, n, e));
        RoutedDecision d = routedDecide(*core[at], self_key, e, 1300);
        if (d.action == ROUTED_DELIVER) {
            ASSERT_EQ(sizeof(inner), e.inner_len);
            EXPECT_EQ(0, memcmp(e.inner, inner, sizeof(inner)));   // the inner packet is exactly what was sent
            break;
        }
        ASSERT_EQ(ROUTED_FORWARD, d.action) << "at repeater " << at;
        routedRewrite(path, 2, payload, d);
        at++;                                                      // every hop in a chain is the next repeater along
    }
    EXPECT_EQ(3, at);
    EXPECT_EQ(3, hops);
    EXPECT_EQ(16 - 3, payload[1]);                                 // one less ttl per hop
}

TEST(RoutedForward, ADestinationNobodyAdvertisesIsDroppedAtTheFirstRepeater) {
    Core r0(0x10000001, 100), r1(0x20000002, 100);
    Chain net;
    net.add(&r0, 0x10); net.add(&r1, 0x20);
    net.converge(1000, 1200);
    uint8_t dest[2] = {0x77, 0x77}, src[2] = {0x10, 0}, inner[] = {1, 2, 3}, payload[32];
    int n = routedEncode(payload, 2, 16, dest, src, inner, sizeof(inner));
    uint8_t key[4] = {0x10, 0, 0, 1};
    RoutedEnvelope e;
    ASSERT_TRUE(routedDecode(payload, n, e));
    EXPECT_EQ(ROUTED_DROP, routedDecide(r0, key, e, 1200).action);
}

// ---- the order a message is sent in ----

TEST(SendStep, ACachedPathIsTriedOnceThenARetryFloods) {
    EXPECT_EQ(SEND_CACHED, chooseSendStep(true, 0, 2));
    for (int attempt = 1; attempt < 4; attempt++) EXPECT_EQ(SEND_FLOOD, chooseSendStep(true, attempt, 2)) << attempt;
}

TEST(SendStep, TheNumberOfCachedTriesCanBeRaised) {
    EXPECT_EQ(SEND_CACHED, chooseSendStep(true, 1, 2, 2));
    EXPECT_EQ(SEND_FLOOD, chooseSendStep(true, 2, 2, 2));
}

TEST(SendStep, WithoutACachedPathTheRouteTablesGetTheFirstTriesThenAFlood) {
    EXPECT_EQ(SEND_ROUTED, chooseSendStep(false, 0, 2));
    EXPECT_EQ(SEND_ROUTED, chooseSendStep(false, 1, 2));
    EXPECT_EQ(SEND_FLOOD, chooseSendStep(false, 2, 2));
    EXPECT_EQ(SEND_FLOOD, chooseSendStep(false, 3, 2));
}

TEST(SendStep, WithRoutedTriesAtZeroItIsTheOldBehaviour) {
    EXPECT_EQ(SEND_FLOOD, chooseSendStep(false, 0, 0));
    EXPECT_EQ(SEND_CACHED, chooseSendStep(true, 0, 0));
}

int main(int argc, char** argv) {
    ::testing::InitGoogleTest(&argc, argv);
    return RUN_ALL_TESTS();
}
