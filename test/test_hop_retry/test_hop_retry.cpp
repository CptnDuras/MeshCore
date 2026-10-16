#include <gtest/gtest.h>
#include "helpers/HopRetryTable.h"
#include "Packet.h"

using namespace mesh;

static void hashOf(uint8_t seed, uint8_t out[MAX_HASH_SIZE]) {
    for (int i = 0; i < MAX_HASH_SIZE; i++) out[i] = seed + i;
}

static const uint8_t RAW[] = {1, 2, 3, 4, 5};

TEST(HopRetryTable, StartsEmpty) {
    HopRetryTable<4> t;
    EXPECT_EQ(0, t.count());
    EXPECT_EQ(-1, t.nextDue(0));
    EXPECT_EQ(NULL, t.at(0));
}

TEST(HopRetryTable, HearingTheNextHopPassItOnClearsTheWait) {
    HopRetryTable<4> t;
    uint8_t h[MAX_HASH_SIZE]; hashOf(10, h);
    ASSERT_GE(t.track(h, 2, RAW, sizeof(RAW), 0, 1000), 0);
    EXPECT_EQ(1, t.count());
    EXPECT_TRUE(t.overheard(h, 2));
    EXPECT_EQ(0, t.count());
    EXPECT_EQ(-1, t.nextDue(5000));          // nothing left to retry
}

TEST(HopRetryTable, OnlyTheShorterCopyCountsAsTheNextHopsForward) {
    HopRetryTable<4> t;
    uint8_t h[MAX_HASH_SIZE]; hashOf(10, h);
    t.track(h, 2, RAW, sizeof(RAW), 0, 1000);
    EXPECT_FALSE(t.overheard(h, 3));   // our own copy (or an earlier hop's) echoing back
    EXPECT_FALSE(t.overheard(h, 1));   // some other, later copy
    EXPECT_EQ(1, t.count());
    EXPECT_TRUE(t.overheard(h, 2));
}

TEST(HopRetryTable, AnotherPacketDoesNotClearIt) {
    HopRetryTable<4> t;
    uint8_t a[MAX_HASH_SIZE], b[MAX_HASH_SIZE]; hashOf(10, a); hashOf(99, b);
    t.track(a, 0, RAW, sizeof(RAW), 0, 1000);
    EXPECT_FALSE(t.overheard(b, 0));
    EXPECT_EQ(1, t.count());
}

TEST(HopRetryTable, ThereIsNothingToRetryUntilTheWaitRunsOut) {
    HopRetryTable<4> t;
    uint8_t h[MAX_HASH_SIZE]; hashOf(1, h);
    int slot = t.track(h, 0, RAW, sizeof(RAW), 0, 1000);
    EXPECT_EQ(-1, t.nextDue(999));
    EXPECT_EQ(slot, t.nextDue(1000));
    EXPECT_EQ(slot, t.nextDue(2500));
}

TEST(HopRetryTable, ARetriedEntryWaitsAgainAndCountsTheTry) {
    HopRetryTable<4> t;
    uint8_t h[MAX_HASH_SIZE]; hashOf(1, h);
    int slot = t.track(h, 0, RAW, sizeof(RAW), 0, 1000);
    t.retried(slot, 2000);
    EXPECT_EQ(1, t.at(slot)->tries);
    EXPECT_EQ(-1, t.nextDue(1500));
    EXPECT_EQ(slot, t.nextDue(2000));
    t.retried(slot, 3000);
    EXPECT_EQ(2, t.at(slot)->tries);
}

TEST(HopRetryTable, TheEarliestOverdueEntryComesFirst) {
    HopRetryTable<4> t;
    uint8_t a[MAX_HASH_SIZE], b[MAX_HASH_SIZE]; hashOf(1, a); hashOf(50, b);
    int late = t.track(a, 0, RAW, sizeof(RAW), 0, 3000);
    int early = t.track(b, 0, RAW, sizeof(RAW), 0, 1000);
    EXPECT_EQ(early, t.nextDue(5000));
    t.release(early);
    EXPECT_EQ(late, t.nextDue(5000));
}

TEST(HopRetryTable, AFullTableSkipsNewPacketsInsteadOfDroppingOldOnes) {
    HopRetryTable<2> t;
    uint8_t a[MAX_HASH_SIZE], b[MAX_HASH_SIZE], c[MAX_HASH_SIZE]; hashOf(1, a); hashOf(20, b); hashOf(40, c);
    EXPECT_GE(t.track(a, 0, RAW, sizeof(RAW), 0, 1000), 0);
    EXPECT_GE(t.track(b, 0, RAW, sizeof(RAW), 0, 1000), 0);
    EXPECT_EQ(-1, t.track(c, 0, RAW, sizeof(RAW), 0, 1000));
    EXPECT_EQ(2, t.count());
    t.overheard(a, 0);
    EXPECT_GE(t.track(c, 0, RAW, sizeof(RAW), 0, 1000), 0);   // room again
}

TEST(HopRetryTable, TheSamePacketIsNotTrackedTwice) {
    HopRetryTable<4> t;
    uint8_t h[MAX_HASH_SIZE]; hashOf(1, h);
    EXPECT_GE(t.track(h, 0, RAW, sizeof(RAW), 0, 1000), 0);
    EXPECT_EQ(-1, t.track(h, 0, RAW, sizeof(RAW), 0, 2000));
    EXPECT_EQ(1, t.count());
}

TEST(HopRetryTable, KeepsAnExactCopyOfWhatToResend) {
    HopRetryTable<4> t;
    uint8_t h[MAX_HASH_SIZE]; hashOf(1, h);
    uint8_t raw[200];
    for (int i = 0; i < 200; i++) raw[i] = (uint8_t)(i * 7);
    int slot = t.track(h, 4, raw, sizeof(raw), 3, 10);
    ASSERT_NE(nullptr, t.at(slot));
    EXPECT_EQ(200, t.at(slot)->raw_len);
    EXPECT_EQ(3, t.at(slot)->priority);
    EXPECT_EQ(0, memcmp(t.at(slot)->raw, raw, 200));
}

TEST(HopRetryTable, WorksAcrossTheMillisecondCounterWrapping) {
    HopRetryTable<4> t;
    uint8_t h[MAX_HASH_SIZE]; hashOf(1, h);
    uint32_t near_wrap = 0xFFFFFF00u;
    int slot = t.track(h, 0, RAW, sizeof(RAW), 0, near_wrap + 0x200u);   // due just after the wrap
    EXPECT_EQ(-1, t.nextDue(near_wrap));
    EXPECT_EQ(-1, t.nextDue(near_wrap + 0x100u));   // still before it
    EXPECT_EQ(slot, t.nextDue(near_wrap + 0x200u));
}

TEST(HopRetryTable, ClearForgetsEverything) {
    HopRetryTable<4> t;
    uint8_t h[MAX_HASH_SIZE]; hashOf(1, h);
    t.track(h, 0, RAW, sizeof(RAW), 0, 1000);
    t.clear();
    EXPECT_EQ(0, t.count());
}

// The idea rests on the hash staying the same when a repeater removes itself from the path.
TEST(HopRetryTable, AForwardedCopyHasTheSameHashButAShorterPath) {
    Packet sent;
    sent.header = ROUTE_TYPE_DIRECT | (PAYLOAD_TYPE_TXT_MSG << PH_TYPE_SHIFT);
    sent.setPathHashSizeAndCount(1, 3);
    sent.path[0] = 0xA1; sent.path[1] = 0xB2; sent.path[2] = 0xC3;
    sent.payload_len = 20;
    for (int i = 0; i < 20; i++) sent.payload[i] = (uint8_t)(i + 1);

    Packet forwarded = sent;           // what the next repeater sends after removing itself
    forwarded.setPathHashSizeAndCount(1, 2);
    forwarded.path[0] = 0xB2; forwarded.path[1] = 0xC3;

    uint8_t h1[MAX_HASH_SIZE], h2[MAX_HASH_SIZE];
    sent.calculatePacketHash(h1);
    forwarded.calculatePacketHash(h2);
    EXPECT_EQ(0, memcmp(h1, h2, MAX_HASH_SIZE));

    HopRetryTable<4> t;
    uint8_t raw[MAX_TRANS_UNIT];
    uint8_t len = sent.writeTo(raw);
    t.track(h1, forwarded.getPathHashCount(), raw, len, 0, 1000);
    EXPECT_TRUE(t.overheard(h2, forwarded.getPathHashCount()));
}

TEST(HopRetryTable, RemembersWhetherWeWerePassingItOnForSomeoneElse) {
    HopRetryTable<4> t;
    uint8_t h1[MAX_HASH_SIZE], h2[MAX_HASH_SIZE]; hashOf(10, h1); hashOf(50, h2);
    int own = t.track(h1, 2, RAW, sizeof(RAW), 0, 1000);              // our own send: no flag
    int relayed = t.track(h2, 2, RAW, sizeof(RAW), 0, 1000, true);    // relayed for someone else
    ASSERT_GE(own, 0);
    ASSERT_GE(relayed, 0);
    EXPECT_FALSE(t.at(own)->relay);
    EXPECT_TRUE(t.at(relayed)->relay);
}

int main(int argc, char** argv) {
    ::testing::InitGoogleTest(&argc, argv);
    return RUN_ALL_TESTS();
}
