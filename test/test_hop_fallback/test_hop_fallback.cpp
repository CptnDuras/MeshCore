#include <gtest/gtest.h>
#include "helpers/HopFallback.h"

using namespace mesh;

static const uint8_t SELF[3] = {0xAA, 0xBB, 0xCC};

// a DIRECT packet as a repeater has just sent it on: the hops left after it are `left`
static void direct(Packet& p, uint8_t type, uint8_t hsize, uint8_t left, bool transport = false) {
    memset(&p, 0, sizeof(p));
    p.header = (transport ? ROUTE_TYPE_TRANSPORT_DIRECT : ROUTE_TYPE_DIRECT) | (type << PH_TYPE_SHIFT);
    p.setPathHashSizeAndCount(hsize, left);
    for (int i = 0; i < left * hsize; i++) p.path[i] = 0x10 + i;
    p.payload_len = 5;
    for (int i = 0; i < 5; i++) p.payload[i] = 0x40 + i;
    if (transport) { p.transport_codes[0] = 0x1111; p.transport_codes[1] = 0x2222; }
}

TEST(HopFallback, AUnicastPacketBecomesAFloodThatStartsAtThisRepeater) {
    Packet p;
    direct(p, PAYLOAD_TYPE_TXT_MSG, 1, 3);
    ASSERT_TRUE(makeFloodFallback(&p, SELF));
    EXPECT_TRUE(p.isRouteFlood());
    EXPECT_EQ(ROUTE_TYPE_FLOOD, p.getRouteType());
    EXPECT_EQ(PAYLOAD_TYPE_TXT_MSG, p.getPayloadType());
    EXPECT_EQ(1, p.getPathHashCount());          // our hash alone: what a flood we had relayed would carry
    EXPECT_EQ(1, p.getPathHashSize());
    EXPECT_EQ(0xAA, p.path[0]);
    EXPECT_EQ(5, p.payload_len);                 // the encrypted payload is untouched
    EXPECT_EQ(0x40, p.payload[0]);
}

TEST(HopFallback, TheClientsHashSizeIsKept) {
    for (uint8_t h = 1; h <= 3; h++) {
        Packet p;
        direct(p, PAYLOAD_TYPE_REQ, h, 2);
        ASSERT_TRUE(makeFloodFallback(&p, SELF)) << "hash size " << (int)h;
        EXPECT_EQ(h, p.getPathHashSize());
        EXPECT_EQ(1, p.getPathHashCount());
        EXPECT_EQ(0, memcmp(p.path, SELF, h));
    }
}

TEST(HopFallback, AScopedPacketStaysInItsScope) {
    Packet p;
    direct(p, PAYLOAD_TYPE_TXT_MSG, 2, 2, true);
    ASSERT_TRUE(makeFloodFallback(&p, SELF));
    EXPECT_EQ(ROUTE_TYPE_TRANSPORT_FLOOD, p.getRouteType());
    EXPECT_EQ(0x1111, p.transport_codes[0]);
    EXPECT_EQ(0x2222, p.transport_codes[1]);
}

TEST(HopFallback, TheFloodSurvivesBeingWrittenAndReadBack) {
    Packet p;
    direct(p, PAYLOAD_TYPE_ACK, 2, 4);
    ASSERT_TRUE(makeFloodFallback(&p, SELF));
    uint8_t raw[MAX_TRANS_UNIT];
    uint8_t n = p.writeTo(raw);
    Packet q;
    ASSERT_TRUE(q.readFrom(raw, n));
    EXPECT_TRUE(q.isRouteFlood());
    EXPECT_EQ(1, q.getPathHashCount());
    EXPECT_EQ(0, memcmp(q.path, SELF, 2));
    EXPECT_EQ(5, q.payload_len);
}

TEST(HopFallback, OnlyUnicastTypesFallBack) {
    const uint8_t yes[] = {PAYLOAD_TYPE_REQ, PAYLOAD_TYPE_RESPONSE, PAYLOAD_TYPE_TXT_MSG, PAYLOAD_TYPE_ACK, PAYLOAD_TYPE_PATH, PAYLOAD_TYPE_ANON_REQ};
    for (uint8_t t : yes) EXPECT_TRUE(isHopFallbackType(t)) << (int)t;
    const uint8_t no[] = {PAYLOAD_TYPE_ADVERT, PAYLOAD_TYPE_GRP_TXT, PAYLOAD_TYPE_GRP_DATA, PAYLOAD_TYPE_TRACE, PAYLOAD_TYPE_MULTIPART,
                          PAYLOAD_TYPE_CONTROL, PAYLOAD_TYPE_ROUTED, PAYLOAD_TYPE_RAW_CUSTOM};
    for (uint8_t t : no) {
        EXPECT_FALSE(isHopFallbackType(t)) << (int)t;
        Packet p;
        direct(p, t, 1, 2);
        EXPECT_FALSE(makeFloodFallback(&p, SELF)) << (int)t;
        EXPECT_TRUE(p.isRouteDirect());          // left as it was
        EXPECT_EQ(2, p.getPathHashCount());
    }
}

TEST(HopFallback, AFloodIsNotRewritten) {
    Packet p;
    direct(p, PAYLOAD_TYPE_TXT_MSG, 1, 2);
    p.header = ROUTE_TYPE_FLOOD | (PAYLOAD_TYPE_TXT_MSG << PH_TYPE_SHIFT);
    EXPECT_FALSE(makeFloodFallback(&p, SELF));
    EXPECT_EQ(2, p.getPathHashCount());
}

int main(int argc, char** argv) {
    ::testing::InitGoogleTest(&argc, argv);
    return RUN_ALL_TESTS();
}
