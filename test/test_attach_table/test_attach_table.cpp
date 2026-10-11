#include <gtest/gtest.h>
#include "helpers/AttachTable.h"

using namespace mesh;

static const RouteId X = 0xD90E4417, Y = 0x11223344;

TEST(AttachTable, AFirstCheckinAttachesTheClient) {
    AttachTable<4> t;
    EXPECT_EQ(CHECKIN_NEW, t.checkin(X, 2, 2250, 3, -20, 1000));
    auto e = t.find(X, 1000);
    ASSERT_NE(nullptr, e);
    EXPECT_EQ(3250u, e->expires);
    EXPECT_EQ(3, e->cost);
    EXPECT_EQ(-20, e->snr4);
    EXPECT_EQ(1, t.count(1000));
}

TEST(AttachTable, ALaterCheckinOnlyExtendsTheTimeToLive) {
    AttachTable<4> t;
    t.checkin(X, 2, 2250, 3, 0, 1000);
    EXPECT_EQ(CHECKIN_REFRESHED, t.checkin(X, 4, 2250, 3, 0, 1900));
    EXPECT_EQ(4150u, t.find(X, 1900)->expires);
    EXPECT_EQ(CHECKIN_REFRESHED, t.checkin(X, 6, 2250, 4, 0, 2000));   // a cost change of 1 is not worth announcing
}

TEST(AttachTable, ACostChangeOfTwoIsReported) {
    AttachTable<4> t;
    t.checkin(X, 2, 2250, 3, 0, 1000);
    EXPECT_EQ(CHECKIN_CHANGED, t.checkin(X, 4, 2250, 5, 0, 1100));
    EXPECT_EQ(5, t.find(X, 1100)->cost);
    EXPECT_EQ(CHECKIN_CHANGED, t.checkin(X, 6, 2250, 2, 0, 1200));
}

TEST(AttachTable, AnOldOrRepeatedCounterIsIgnored) {
    AttachTable<4> t;
    t.checkin(X, 10, 2250, 3, 0, 1000);
    EXPECT_EQ(CHECKIN_IGNORED_OLD, t.checkin(X, 10, 2250, 3, 0, 1010));
    EXPECT_EQ(CHECKIN_IGNORED_OLD, t.checkin(X, 8, 2250, 3, 0, 1010));
    EXPECT_EQ(3250u, t.find(X, 1010)->expires);   // unchanged
}

TEST(AttachTable, CountersWrapAround) {
    AttachTable<4> t;
    t.checkin(X, 65534, 2250, 3, 0, 1000);
    EXPECT_EQ(CHECKIN_REFRESHED, t.checkin(X, 0, 2250, 3, 0, 1100));
    EXPECT_EQ(CHECKIN_IGNORED_OLD, t.checkin(X, 65534, 2250, 3, 0, 1200));
}

TEST(AttachTable, AClientThatStopsCheckingInLapsesAndIsNewAgainWhenItReturns) {
    AttachTable<4> t;
    t.checkin(X, 2, 2250, 3, 0, 1000);
    EXPECT_NE(nullptr, t.find(X, 3249));
    EXPECT_EQ(NULL, t.find(X, 3250));
    EXPECT_EQ(CHECKIN_NEW, t.checkin(X, 4, 2250, 3, 0, 4000));
}

TEST(AttachTable, ExpireReportsWhoWentAway) {
    AttachTable<4> t;
    t.checkin(X, 2, 100, 3, 0, 0);
    t.checkin(Y, 2, 1000, 3, 0, 0);
    RouteId gone[4];
    EXPECT_EQ(1, t.expire(500, gone, 4));
    EXPECT_EQ(X, gone[0]);
    EXPECT_EQ(NULL, t.find(X, 500));
    EXPECT_NE(nullptr, t.find(Y, 500));
    EXPECT_EQ(0, t.expire(500));
}

TEST(AttachTable, AClientGoingAwayIsWithdrawnAtOnce) {
    AttachTable<4> t;
    t.checkin(X, 2, 2250, 3, 0, 0);
    EXPECT_EQ(CHECKIN_WITHDRAWN, t.checkin(X, 4, 0, 3, 0, 10));
    EXPECT_EQ(NULL, t.find(X, 10));
    EXPECT_EQ(CHECKIN_IGNORED_OLD, t.checkin(X, 6, 0, 3, 0, 20));      // nothing to withdraw
}

TEST(AttachTable, AnOldGoingAwayDoesNotRemoveAClientThatCheckedInSince) {
    AttachTable<4> t;
    t.checkin(X, 10, 2250, 3, 0, 0);
    EXPECT_EQ(CHECKIN_IGNORED_OLD, t.checkin(X, 8, 0, 3, 0, 10));
    EXPECT_NE(nullptr, t.find(X, 10));
}

TEST(AttachTable, AFullTableTakesALapsedSlot) {
    AttachTable<2> t;
    t.checkin(0x01000000, 2, 100, 3, 0, 0);
    t.checkin(0x02000000, 2, 5000, 3, 0, 0);
    EXPECT_EQ(CHECKIN_NEW, t.checkin(0x03000000, 2, 1000, 3, 0, 200));   // the first has lapsed
    EXPECT_NE(nullptr, t.find(0x02000000, 200));
}

TEST(AttachTable, AFullTableOfHealthyClientsRefusesAnotherUntilOneIsNearlyDone) {
    AttachTable<2> t;
    t.checkin(0x01000000, 2, 1000, 3, 0, 0);
    t.checkin(0x02000000, 2, 5000, 3, 0, 0);
    EXPECT_EQ(CHECKIN_NO_ROOM, t.checkin(0x03000000, 2, 1000, 3, 0, 100));   // 900 s left of 1000: far more than a quarter
    EXPECT_EQ(CHECKIN_NEW, t.checkin(0x03000000, 2, 1000, 3, 0, 800));       // 200 s left, under the new client's quarter (250)
    EXPECT_EQ(NULL, t.find(0x01000000, 800));
}

TEST(AttachTable, AClientAnnouncedElsewhereWithANewerCounterHasMovedOn) {
    AttachTable<4> t;
    t.checkin(X, 10, 2250, 3, 0, 0);
    EXPECT_FALSE(t.movedAway(X, 10));
    EXPECT_FALSE(t.movedAway(X, 8));
    EXPECT_TRUE(t.movedAway(X, 12));
    EXPECT_EQ(NULL, t.find(X, 1));
    EXPECT_FALSE(t.movedAway(X, 14));
}

int main(int argc, char** argv) {
    ::testing::InitGoogleTest(&argc, argv);
    return RUN_ALL_TESTS();
}
