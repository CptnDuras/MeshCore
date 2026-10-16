#include <gtest/gtest.h>
#include "helpers/RoutedHints.h"

using namespace mesh;

TEST(EntryTracker, NothingHeardMeansNoEntryRepeater) {
    EntryTracker t;
    uint8_t h[3]; uint8_t n;
    EXPECT_FALSE(t.get(h, n, 100));
}

TEST(EntryTracker, TheStrongestRecentRepeaterIsKept) {
    EntryTracker t;
    uint8_t a[2] = {0xAA, 0x01}, b[2] = {0xBB, 0x02}, h[3]; uint8_t n;
    t.heard(a, 2, 36, 100);              // 9 dB
    t.heard(b, 2, 8, 110);               // 2 dB: weaker, and the strong one is recent
    ASSERT_TRUE(t.get(h, n, 120));
    EXPECT_EQ(2, n); EXPECT_EQ(0xAA, h[0]);
    t.heard(b, 2, 40, 130);              // stronger: it takes over
    ASSERT_TRUE(t.get(h, n, 140));
    EXPECT_EQ(0xBB, h[0]);
}

TEST(EntryTracker, AWeakerOneTakesOverWhenTheStrongOneGoesQuiet) {
    EntryTracker t;
    uint8_t a[1] = {0xAA}, b[1] = {0xBB}, h[3]; uint8_t n;
    t.heard(a, 1, 40, 100);
    t.heard(b, 1, 4, 100 + EntryTracker::HOLD_S + 1);
    ASSERT_TRUE(t.get(h, n, 100 + EntryTracker::HOLD_S + 2));
    EXPECT_EQ(0xBB, h[0]);
}

TEST(EntryTracker, ItIsForgottenWhenNothingHasBeenHeardForAWhile) {
    EntryTracker t;
    uint8_t a[1] = {0xAA}, h[3]; uint8_t n;
    t.heard(a, 1, 40, 100);
    EXPECT_TRUE(t.get(h, n, 100 + EntryTracker::STALE_S));
    EXPECT_FALSE(t.get(h, n, 101 + EntryTracker::STALE_S));
}

TEST(EntryTracker, BadHashSizesAreIgnored) {
    EntryTracker t;
    uint8_t a[4] = {1, 2, 3, 4}, h[3]; uint8_t n;
    t.heard(a, 4, 40, 100);
    t.heard(a, 0, 40, 100);
    EXPECT_FALSE(t.get(h, n, 101));
}

TEST(HomeCache, RemembersTheHomeOfEachContact) {
    HomeCache<4> c;
    uint8_t k1[32] = {1, 1, 1, 1}, k2[32] = {2, 2, 2, 2}, h[3]; uint8_t n;
    uint8_t home1[2] = {0xA1, 0xA2}, home2[1] = {0xB1};
    c.set(k1, home1, 2, 10);
    c.set(k2, home2, 1, 11);
    ASSERT_TRUE(c.get(k1, h, n)); EXPECT_EQ(2, n); EXPECT_EQ(0xA2, h[1]);
    ASSERT_TRUE(c.get(k2, h, n)); EXPECT_EQ(1, n); EXPECT_EQ(0xB1, h[0]);
    uint8_t k3[32] = {3, 3, 3, 3};
    EXPECT_FALSE(c.get(k3, h, n));
}

TEST(HomeCache, ANewAdvertReplacesTheOldHome) {
    HomeCache<4> c;
    uint8_t k[32] = {1, 1, 1, 1}, h[3]; uint8_t n;
    uint8_t a[1] = {0xA1}, b[1] = {0xB1};
    c.set(k, a, 1, 10);
    c.set(k, b, 1, 20);
    ASSERT_TRUE(c.get(k, h, n));
    EXPECT_EQ(0xB1, h[0]);
}

TEST(HomeCache, WhenFullTheLeastRecentlyUsedIsReplaced) {
    HomeCache<2> c;
    uint8_t k1[32] = {1, 0, 0, 0}, k2[32] = {2, 0, 0, 0}, k3[32] = {3, 0, 0, 0}, h[3]; uint8_t n;
    uint8_t x[1] = {0x77};
    c.set(k1, x, 1, 10);
    c.set(k2, x, 1, 20);
    c.set(k3, x, 1, 30);
    EXPECT_FALSE(c.get(k1, h, n));       // the oldest went
    EXPECT_TRUE(c.get(k2, h, n));
    EXPECT_TRUE(c.get(k3, h, n));
}

TEST(RoutingSeen, OnlyARepeaterHeardSendingRouteAdvertsCounts) {
    RoutingSeen s;
    uint8_t id[4] = {0xA1, 0xB2, 0xC3, 0xD4}, h1[1] = {0xA1}, h2[2] = {0xA1, 0xB2}, other[2] = {0xA1, 0xFF};
    EXPECT_FALSE(s.seen(h1, 1, 100));
    s.heard(id, 4, 100);
    EXPECT_TRUE(s.seen(h1, 1, 200));
    EXPECT_TRUE(s.seen(h2, 2, 200));
    EXPECT_FALSE(s.seen(other, 2, 200));
}

TEST(RoutingSeen, AShortIdOnlyProvesAShortHash) {
    RoutingSeen s;
    uint8_t id[2] = {0xA1, 0xB2}, h2[2] = {0xA1, 0xB2}, h3[3] = {0xA1, 0xB2, 0xC3};
    s.heard(id, 2, 100);
    EXPECT_TRUE(s.seen(h2, 2, 101));
    EXPECT_FALSE(s.seen(h3, 3, 101));    // the advert did not carry a third byte to compare
    uint8_t bad[1] = {0xA1};
    s.heard(bad, 1, 100);                 // an id of one byte is not a thing
}

TEST(RoutingSeen, TheEvidenceExpires) {
    RoutingSeen s;
    uint8_t id[4] = {1, 2, 3, 4}, h[1] = {1};
    s.heard(id, 4, 100);
    EXPECT_TRUE(s.seen(h, 1, 100 + 28800));
    EXPECT_FALSE(s.seen(h, 1, 100 + 28801));
    s.heard(id, 4, 40000);                  // heard again: good again
    EXPECT_TRUE(s.seen(h, 1, 40001));
}

int main(int argc, char** argv) {
    ::testing::InitGoogleTest(&argc, argv);
    return RUN_ALL_TESTS();
}
