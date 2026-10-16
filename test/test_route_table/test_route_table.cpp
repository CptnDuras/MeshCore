#include <gtest/gtest.h>
#include "helpers/RouteTable.h"

using namespace mesh;

static const RouteId A = 0xA1B2C3D4, B = 0x7F03E911, C = 0x2C58B6A0, D = 0xD90E4417;

TEST(RouteTable, StartsEmpty) {
    RouteTable<4> t;
    EXPECT_EQ(0, t.count(100));
    EXPECT_EQ(NULL, t.find(A, 100));
    EXPECT_EQ(NULL, t.at(0));
    EXPECT_EQ(NULL, t.at(-1));
    EXPECT_EQ(NULL, t.at(9));
}

TEST(RouteTable, LearnsADestinationAndAddsTheLinkCost) {
    RouteTable<4> t;
    EXPECT_EQ(ROUTE_NEW, t.accept(A, B, 2, 3, 10, 600, false, 100));
    auto e = t.find(A, 100);
    ASSERT_NE(nullptr, e);
    EXPECT_EQ(B, e->next);
    EXPECT_EQ(5, e->cost);
    EXPECT_EQ(10, e->seq);
    EXPECT_EQ(700u, e->expires);
    EXPECT_FALSE(e->client);
}

TEST(RouteTable, TheCostIsCapped) {
    RouteTable<4> t;
    t.accept(A, B, 200, 200, 1, 600, false, 0);
    EXPECT_EQ(254, t.find(A, 0)->cost);
}

TEST(RouteTable, ANewerSequenceWinsEvenWithAWorseCost) {
    RouteTable<4> t;
    t.accept(A, B, 1, 1, 10, 600, false, 0);
    EXPECT_EQ(ROUTE_CHANGED, t.accept(A, C, 1, 8, 11, 600, false, 5));   // different next hop, costlier, but newer
    EXPECT_EQ(C, t.find(A, 5)->next);
    EXPECT_EQ(9, t.find(A, 5)->cost);
}

TEST(RouteTable, TheSameSequenceNeedsALowerCost) {
    RouteTable<4> t;
    t.accept(A, B, 1, 4, 10, 600, false, 0);
    EXPECT_EQ(ROUTE_IGNORED_WORSE, t.accept(A, C, 1, 4, 10, 600, false, 1));   // equal cost from someone else
    EXPECT_EQ(ROUTE_IGNORED_WORSE, t.accept(A, C, 1, 9, 10, 600, false, 1));
    EXPECT_EQ(B, t.find(A, 1)->next);
    EXPECT_EQ(ROUTE_CHANGED, t.accept(A, C, 1, 2, 10, 600, false, 2));         // cheaper
    EXPECT_EQ(C, t.find(A, 2)->next);
}

TEST(RouteTable, AWorseCostFromTheCurrentNextHopIsBelieved) {
    RouteTable<4> t;
    t.accept(A, B, 1, 2, 10, 600, false, 0);
    EXPECT_EQ(ROUTE_CHANGED, t.accept(A, B, 1, 7, 10, 600, false, 5));
    EXPECT_EQ(8, t.find(A, 5)->cost);
}

TEST(RouteTable, ARepeatFromTheNextHopOnlyExtendsTheEntry) {
    RouteTable<4> t;
    t.accept(A, B, 1, 2, 10, 600, false, 0);
    EXPECT_EQ(ROUTE_REFRESHED, t.accept(A, B, 1, 2, 10, 600, false, 300));
    EXPECT_EQ(900u, t.find(A, 300)->expires);
}

TEST(RouteTable, AnOlderSequenceIsIgnoredEvenFromTheNextHop) {
    RouteTable<4> t;
    t.accept(A, B, 1, 2, 10, 600, false, 0);
    EXPECT_EQ(ROUTE_IGNORED_OLD, t.accept(A, B, 1, 1, 9, 600, false, 1));
    EXPECT_EQ(ROUTE_IGNORED_OLD, t.accept(A, C, 1, 1, 9, 600, false, 1));
    EXPECT_EQ(10, t.find(A, 1)->seq);
}

TEST(RouteTable, SequenceNumbersWrapAround) {
    RouteTable<4> t;
    t.accept(A, B, 1, 2, 65534, 600, false, 0);
    EXPECT_EQ(ROUTE_CHANGED, t.accept(A, C, 1, 9, 2, 600, false, 1));   // 2 is newer than 65534 after the wrap
    EXPECT_EQ(C, t.find(A, 1)->next);
    EXPECT_EQ(ROUTE_IGNORED_OLD, t.accept(A, B, 1, 1, 65535, 600, false, 2));
}

TEST(RouteTable, AWithdrawalMakesItUnreachableAndAnOlderAdvertCannotBringItBack) {
    RouteTable<4> t;
    t.accept(D, B, 1, 3, 290, 600, true, 0);
    EXPECT_EQ(ROUTE_WITHDRAWN, t.accept(D, B, 1, ROUTE_COST_UNREACHABLE, 291, 600, true, 10));
    EXPECT_EQ(NULL, t.find(D, 10));                                         // not usable
    EXPECT_EQ(ROUTE_IGNORED_OLD, t.accept(D, C, 1, 2, 290, 600, true, 20)); // the old check-in heard late
    EXPECT_EQ(NULL, t.find(D, 20));
    EXPECT_EQ(ROUTE_CHANGED, t.accept(D, C, 1, 2, 292, 600, true, 30));     // the client's next check-in
    ASSERT_NE(nullptr, t.find(D, 30));
    EXPECT_EQ(C, t.find(D, 30)->next);
}

TEST(RouteTable, AWithdrawalForSomethingWeNeverHadIsIgnored) {
    RouteTable<4> t;
    EXPECT_EQ(ROUTE_IGNORED_UNKNOWN, t.accept(D, B, 1, ROUTE_COST_UNREACHABLE, 5, 600, true, 0));
    EXPECT_EQ(0, t.count(0));
}

TEST(RouteTable, EntriesExpire) {
    RouteTable<4> t;
    t.accept(A, B, 1, 1, 1, 100, false, 1000);
    EXPECT_NE(nullptr, t.find(A, 1099));
    EXPECT_EQ(NULL, t.find(A, 1100));
    EXPECT_EQ(1, t.expire(1100));
    EXPECT_EQ(NULL, t.at(0));
    EXPECT_EQ(0, t.expire(1100));
}

TEST(RouteTable, AnExpiredEntryIsReplacedByAnythingAndNeedsNoNewerSequence) {
    RouteTable<4> t;
    t.accept(A, B, 1, 1, 50, 100, false, 0);
    EXPECT_EQ(ROUTE_NEW, t.accept(A, C, 1, 5, 3, 100, false, 500));   // the old one lapsed; an older seq is fine now (the sender restarted)
    EXPECT_EQ(C, t.find(A, 500)->next);
}

TEST(RouteTable, TimeWrapsAroundSafely) {
    RouteTable<4> t;
    uint32_t start = 0xFFFFFFF0u;
    t.accept(A, B, 1, 1, 1, 100, false, start);      // expires at 84 after the wrap
    EXPECT_NE(nullptr, t.find(A, start + 50));
    EXPECT_NE(nullptr, t.find(A, 10));
    EXPECT_EQ(NULL, t.find(A, 90));
}

TEST(RouteTable, WhenFullItEvictsTheEntryThatExpiresSoonest) {
    RouteTable<3> t;
    t.accept(0x01000000, B, 1, 1, 1, 300, false, 0);
    t.accept(0x02000000, B, 1, 1, 1, 100, false, 0);    // soonest
    t.accept(0x03000000, B, 1, 1, 1, 200, false, 0);
    EXPECT_EQ(ROUTE_NEW, t.accept(0x04000000, B, 1, 1, 1, 400, false, 10));
    EXPECT_EQ(NULL, t.find(0x02000000, 10));
    EXPECT_NE(nullptr, t.find(0x01000000, 10));
    EXPECT_NE(nullptr, t.find(0x04000000, 10));
}

TEST(RouteTable, ANewEntryThatWouldLapseBeforeEverythingElseDoesNotDisplaceAnything) {
    RouteTable<2> t;
    t.accept(0x01000000, B, 1, 1, 1, 1000, false, 0);
    t.accept(0x02000000, B, 1, 1, 1, 2000, false, 0);
    EXPECT_EQ(ROUTE_NO_ROOM, t.accept(0x03000000, B, 1, 1, 1, 100, false, 10));
    EXPECT_NE(nullptr, t.find(0x01000000, 10));
    EXPECT_NE(nullptr, t.find(0x02000000, 10));
}

TEST(RouteTable, DropViaRemovesEverythingLearnedFromANeighbour) {
    RouteTable<4> t;
    t.accept(A, B, 1, 1, 1, 600, false, 0);
    t.accept(C, B, 1, 1, 1, 600, false, 0);
    t.accept(D, C, 1, 1, 1, 600, true, 0);
    EXPECT_EQ(2, t.dropVia(B));
    EXPECT_EQ(1, t.count(0));
    EXPECT_NE(nullptr, t.find(D, 0));
}

TEST(RouteTable, RemembersWhatWasAnnounced) {
    RouteTable<4> t;
    t.accept(A, B, 1, 1, 1, 600, false, 0);
    t.markAnnounced(A, 5000, 7200);
    EXPECT_EQ(5000u, t.find(A, 1)->adv_until);
    EXPECT_EQ(7200, t.find(A, 1)->adv_life);
}

int main(int argc, char** argv) {
    ::testing::InitGoogleTest(&argc, argv);
    return RUN_ALL_TESTS();
}
