#include <gtest/gtest.h>
#include "helpers/FloodSuppress.h"

using namespace mesh;

TEST(FloodCancelCopies, OffCancelsNothing) {
    for (int heard = 0; heard < 20; heard++) EXPECT_EQ(0, floodCancelCopies(0, heard));
}

TEST(FloodCancelCopies, AFixedSettingIgnoresHowManyRepeatersAreHeard) {
    for (uint8_t k = 1; k <= 8; k++) {
        EXPECT_EQ(k, floodCancelCopies(k, 0));
        EXPECT_EQ(k, floodCancelCopies(k, 30));
    }
}

TEST(FloodCancelCopies, AnUnknownSettingIsOff) {
    EXPECT_EQ(0, floodCancelCopies(10, 12));
    EXPECT_EQ(0, floodCancelCopies(255, 12));
}

TEST(FloodCancelCopies, AutoFollowsTheTiers) {   // FSP-002
    EXPECT_EQ(0, floodCancelCopies(FLOOD_CANCEL_AUTO, 0));
    EXPECT_EQ(0, floodCancelCopies(FLOOD_CANCEL_AUTO, 2));   // a chain or a bridge: never cancel
    EXPECT_EQ(2, floodCancelCopies(FLOOD_CANCEL_AUTO, 3));
    EXPECT_EQ(2, floodCancelCopies(FLOOD_CANCEL_AUTO, 7));
    EXPECT_EQ(1, floodCancelCopies(FLOOD_CANCEL_AUTO, 8));
    EXPECT_EQ(1, floodCancelCopies(FLOOD_CANCEL_AUTO, 200));
}

TEST(HeardRepeaters, CountsEachRepeaterOnce) {
    HeardRepeaters h;
    EXPECT_EQ(0, h.count(1000));
    h.note(0x10, 1000);
    h.note(0x10, 1010);
    h.note(0x20, 1020);
    EXPECT_EQ(2, h.count(1030));
}

TEST(HeardRepeaters, ARepeaterHeardTwentyFourHoursAndAMinuteAgoNoLongerCounts) {   // FSP-003
    HeardRepeaters h;
    h.note(0x10, 600);                       // minute 10
    EXPECT_EQ(1, h.count(600 + 24 * 3600));  // exactly 24 h later
    EXPECT_EQ(0, h.count(600 + 24 * 3600 + 60));
}

TEST(HeardRepeaters, HashZeroIsCounted) {
    HeardRepeaters h;
    h.note(0x00, 5000);
    h.note(0xFF, 5000);
    EXPECT_EQ(2, h.count(5000));
}

TEST(HeardRepeaters, HearingAgainRefreshesTheEntry) {
    HeardRepeaters h;
    h.note(0x33, 0);
    h.note(0x33, 20 * 3600);
    EXPECT_EQ(1, h.count(40 * 3600));
}

TEST(HeardRepeaters, ClearForgetsEverything) {
    HeardRepeaters h;
    h.note(1, 100); h.note(2, 100);
    h.clear();
    EXPECT_EQ(0, h.count(100));
}

TEST(AdvertJitter, StaysWithinTenPercent) {   // ADJ-001
    EXPECT_EQ(900u, advertJitterMs(1000, 900));
    EXPECT_EQ(1100u, advertJitterMs(1000, 1100));
    EXPECT_EQ(1000u, advertJitterMs(1000, 1000));
}

TEST(AdvertJitter, FactorsOutsideTheRangeAreClamped) {   // neg: 0.89 and 1.11 are never used
    EXPECT_EQ(900u, advertJitterMs(1000, 890));
    EXPECT_EQ(1100u, advertJitterMs(1000, 1110));
    EXPECT_EQ(900u, advertJitterMs(1000, 0));
}

TEST(AdvertJitter, ALongIntervalDoesNotOverflow) {
    uint32_t forty_seven_hours = 47u * 3600 * 1000;   // 169 million ms: times 1100 overflows 32 bits
    EXPECT_EQ((uint32_t)(47ull * 3600 * 1000 * 11 / 10), advertJitterMs(forty_seven_hours, 1100));
}

TEST(AdvertJitter, TheMeanOfManyGapsIsTheConfiguredInterval) {   // ADJ-002
    uint64_t sum = 0;
    int n = 0;
    for (uint32_t r = 900; r <= 1100; r++, n++) sum += advertJitterMs(120000, r);
    EXPECT_NEAR(120000.0, (double)sum / n, 1200.0);
}

int main(int argc, char** argv) {
    ::testing::InitGoogleTest(&argc, argv);
    return RUN_ALL_TESTS();
}
