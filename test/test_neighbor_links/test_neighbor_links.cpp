#include <gtest/gtest.h>
#include "helpers/NeighborLinks.h"

using namespace mesh;

static const RouteId N1 = 0x4B81424F, N2 = 0x2A528278, N3 = 0x1BB4E62E;

static void hear(NeighborLinks<4>& l, RouteId id, int snr4, int times, int sf = 7) {
    for (int i = 0; i < times; i++) l.heard(id, snr4, 100 + i, sf);
}

TEST(NeighborLinks, UnknownNeighboursAreNotUsable) {
    NeighborLinks<4> l;
    EXPECT_EQ(LINK_NOT_USABLE, l.cost(N1));
    EXPECT_EQ(0, l.count());
}

TEST(NeighborLinks, TheFloorFollowsTheSpreadingFactor) {
    EXPECT_EQ(-30, linkSnrFloor4(7));    // -7.5 dB
    EXPECT_EQ(-40, linkSnrFloor4(8));
    EXPECT_EQ(-80, linkSnrFloor4(12));   // -20 dB
    EXPECT_EQ(-30, linkSnrFloor4(5));    // clamped
    EXPECT_EQ(-80, linkSnrFloor4(14));
}

TEST(NeighborLinks, CostsFollowTheMarginAboveTheFloor) {
    // SF7 floor is -7.5 dB: margins 18, 12, 2.75 and -0.5 dB for SNRs of 10.75, 4.75, -4.75 and -8 (the repeater in the field data)
    NeighborLinks<4> l;
    hear(l, N1, 43, 1);
    hear(l, N2, 19, 1);
    hear(l, N3, -19, 1);
    EXPECT_EQ(1, l.cost(N1));
    EXPECT_EQ(1, l.cost(N2));
    EXPECT_EQ(3, l.cost(N3));
    NeighborLinks<4> m;
    hear(m, N1, 36, 1);     // 9 dB SNR: margin 16.5 dB
    EXPECT_EQ(1, m.cost(N1));
    NeighborLinks<4> weak;
    hear(weak, N1, -32, 1); // -8 dB: below the SF7 floor
    EXPECT_EQ(LINK_NOT_USABLE, weak.cost(N1));
}

TEST(NeighborLinks, TheBucketEdgesAreTenFiveTwoAndZeroDecibelsOfMargin) {
    // margin in quarter dB: 40, 20, 8, 0. snr4 = margin - 30 at SF7
    NeighborLinks<4> l;
    int expect[][2] = {{10, 1}, {9, 2}, {5, 2}, {4, 3}, {2, 3}, {1, 5}, {0, 5}};   // margin in dB -> cost; each hears a fresh link
    for (auto& c : expect) {
        l.clear();
        l.heard(N1, c[0] * 4 - 30, 0, 7);
        EXPECT_EQ(c[1], l.cost(N1)) << "margin " << c[0];
    }
    l.clear();
    l.heard(N1, -1 - 30 + 0, 0, 7);   // margin just under 0
    EXPECT_EQ(LINK_NOT_USABLE, l.cost(N1));
}

TEST(NeighborLinks, ALinkDoesNotFlapAtABucketEdge) {
    NeighborLinks<4> l;
    l.heard(N1, 10 * 4 - 30, 0, 7);      // margin exactly 10 dB: cost 1
    ASSERT_EQ(1, l.cost(N1));
    for (int i = 0; i < 40; i++) l.heard(N1, 9 * 4 - 30, 1 + i, 7);   // settles at 9 dB: 1 dB under the edge
    EXPECT_EQ(1, l.cost(N1));            // still cost 1: not 2 dB past the edge
    for (int i = 0; i < 40; i++) l.heard(N1, 7 * 4 - 30, 100 + i, 7); // settles at 7 dB: 3 dB under
    EXPECT_EQ(2, l.cost(N1));
    for (int i = 0; i < 40; i++) l.heard(N1, 11 * 4 - 30, 200 + i, 7);// 1 dB over the edge going up: not enough
    EXPECT_EQ(2, l.cost(N1));
    for (int i = 0; i < 40; i++) l.heard(N1, 13 * 4 - 30, 300 + i, 7);// 3 dB over: moves up
    EXPECT_EQ(1, l.cost(N1));
}

TEST(NeighborLinks, SmallSnrChangesAreNotRoundedAway) {
    NeighborLinks<4> l;
    l.heard(N1, 0, 0, 7);
    for (int i = 0; i < 80; i++) l.heard(N1, 7, 1 + i, 7);    // quarter-dB steps toward +1.75 dB
    EXPECT_GE(l.snr4(N1), 6);
    EXPECT_LE(l.snr4(N1), 7);
}

TEST(NeighborLinks, TheAverageFollowsTheRecentPackets) {
    NeighborLinks<4> l;
    l.heard(N1, 40, 0, 7);
    l.heard(N1, 0, 1, 7);       // one weak packet pulls the average down by an eighth
    EXPECT_EQ(35, l.snr4(N1));
    EXPECT_EQ(2u, l.find(N1)->snr_n);
    EXPECT_EQ(1u, l.find(N1)->last_heard);
}

TEST(NeighborLinks, DeliveryOnlyCountsAfterEightResults) {
    NeighborLinks<4> l;
    hear(l, N1, 43, 1);
    for (int i = 0; i < 7; i++) l.forwardResult(N1, false);
    EXPECT_EQ(1, l.cost(N1));                        // seven failures are not enough to judge
    l.forwardResult(N1, false);
    EXPECT_EQ(LINK_NOT_USABLE, l.cost(N1));          // eight: delivery has fallen far below half
}

TEST(NeighborLinks, MiddlingDeliveryAddsToTheCost) {
    NeighborLinks<4> l;
    hear(l, N1, 43, 1);
    for (int i = 0; i < 8; i++) l.forwardResult(N1, true);
    EXPECT_EQ(1, l.cost(N1));                        // all delivered
    // one loss in four keeps it around 75%
    for (int round = 0; round < 40; round++) {
        l.forwardResult(N1, true); l.forwardResult(N1, true); l.forwardResult(N1, true); l.forwardResult(N1, false);
    }
    uint8_t c = l.cost(N1);
    EXPECT_TRUE(c == 2 || c == 4) << "cost " << (int)c;   // +1 (70-90%) or +3 (50-70%) on top of 1
    EXPECT_GT(c, 1);
}

TEST(NeighborLinks, DeliveryRecovers) {
    NeighborLinks<4> l;
    hear(l, N1, 43, 1);
    for (int i = 0; i < 20; i++) l.forwardResult(N1, false);
    ASSERT_EQ(LINK_NOT_USABLE, l.cost(N1));
    for (int i = 0; i < 60; i++) l.forwardResult(N1, true);
    EXPECT_EQ(1, l.cost(N1));
}

TEST(NeighborLinks, WhenFullTheNeighbourHeardLongestAgoIsReplaced) {
    NeighborLinks<2> l;
    l.heard(0x01000000, 20, 100, 7);
    l.heard(0x02000000, 20, 200, 7);
    l.heard(0x03000000, 20, 300, 7);
    EXPECT_EQ(NULL, l.find(0x01000000));
    EXPECT_NE(nullptr, l.find(0x02000000));
    EXPECT_NE(nullptr, l.find(0x03000000));
}

TEST(NeighborLinks, ForgettingANeighbour) {
    NeighborLinks<4> l;
    hear(l, N1, 43, 1);
    EXPECT_TRUE(l.forget(N1));
    EXPECT_FALSE(l.forget(N1));
    EXPECT_EQ(LINK_NOT_USABLE, l.cost(N1));
}

int main(int argc, char** argv) {
    ::testing::InitGoogleTest(&argc, argv);
    return RUN_ALL_TESTS();
}
