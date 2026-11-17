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

// note a repeater by its hash, written as the bytes of a path
static void note(HeardRepeaters& h, std::initializer_list<uint8_t> hash, uint32_t now_s) {
    uint8_t b[3] = {0, 0, 0};
    int n = 0;
    for (uint8_t x : hash) b[n++] = x;
    h.note(b, (uint8_t)n, now_s);
}

TEST(HeardRepeaters, CountsEachRepeaterOnce) {
    HeardRepeaters h;
    EXPECT_EQ(0, h.count(1000));
    note(h, {0x10}, 1000);
    note(h, {0x10}, 1010);
    note(h, {0x20}, 1020);
    EXPECT_EQ(2, h.count(1030));
}

TEST(HeardRepeaters, ARepeaterHeardTwentyFourHoursAndAMinuteAgoNoLongerCounts) {   // FSP-003
    HeardRepeaters h;
    note(h, {0x10}, 600);                    // minute 10
    EXPECT_EQ(1, h.count(600 + 24 * 3600));  // exactly 24 h later
    EXPECT_EQ(0, h.count(600 + 24 * 3600 + 60));
}

TEST(HeardRepeaters, HashZeroIsCounted) {
    HeardRepeaters h;
    note(h, {0x00}, 5000);
    note(h, {0xFF}, 5000);
    EXPECT_EQ(2, h.count(5000));
}

TEST(HeardRepeaters, HearingAgainRefreshesTheEntry) {
    HeardRepeaters h;
    note(h, {0x33}, 0);
    note(h, {0x33}, 20 * 3600);
    EXPECT_EQ(1, h.count(40 * 3600));
}

TEST(HeardRepeaters, ClearForgetsEverything) {
    HeardRepeaters h;
    note(h, {1}, 100); note(h, {2}, 100);
    h.clear();
    EXPECT_EQ(0, h.count(100));
}

TEST(HeardRepeaters, TwoByteHashesThatShareAFirstByteAreTwoRepeaters) {
    HeardRepeaters h;
    note(h, {0xA1, 0x01}, 100);
    note(h, {0xA1, 0x02}, 100);
    note(h, {0xA1, 0x01}, 110);
    EXPECT_EQ(2, h.count(120));
}

TEST(HeardRepeaters, OneByteHashesThatShareAByteAreOneRepeater) {
    HeardRepeaters h;
    note(h, {0xA1}, 100);
    note(h, {0xA1}, 100);
    EXPECT_EQ(1, h.count(100));
}

TEST(HeardRepeaters, ThreeByteHashesAreComparedInFull) {
    HeardRepeaters h;
    note(h, {1, 2, 3}, 100);
    note(h, {1, 2, 4}, 100);
    note(h, {1, 3, 3}, 100);
    EXPECT_EQ(3, h.count(100));
}

TEST(HeardRepeaters, ALongerHashAndTheShorterOneItStartsWithAreOneRepeater) {
    HeardRepeaters h;
    note(h, {0xA1}, 100);
    note(h, {0xA1, 0x07}, 110);   // the same repeater, now in a flood with 2-byte hashes
    EXPECT_EQ(1, h.count(120));
    note(h, {0xA1, 0x08}, 130);   // a different repeater that starts the same way
    EXPECT_EQ(2, h.count(140));
}

TEST(HeardRepeaters, ASizeOfZeroIsIgnoredAndALongOneIsCutToThree) {
    HeardRepeaters h;
    uint8_t b[5] = {9, 8, 7, 6, 5};
    h.note(b, 0, 100);
    EXPECT_EQ(0, h.count(100));
    h.note(b, 5, 100);
    uint8_t c[3] = {9, 8, 7};
    h.note(c, 3, 110);
    EXPECT_EQ(1, h.count(120));
}

TEST(HeardRepeaters, AFullTableReplacesTheRepeaterHeardLongestAgo) {
    HeardRepeaters h;
    for (int i = 0; i < HeardRepeaters::CAPACITY; i++) note(h, {(uint8_t)i, 0x55}, 60 + i * 60);
    EXPECT_EQ(HeardRepeaters::CAPACITY, h.count(60 + 64 * 60));
    note(h, {0xEE, 0xEE}, 60 + 70 * 60);   // replaces the one from minute 1
    EXPECT_EQ(HeardRepeaters::CAPACITY, h.count(60 + 70 * 60));
    note(h, {0x01, 0x55}, 60 + 71 * 60);   // the newest-but-one survived; this is heard again, so refreshed and not a new slot
    EXPECT_EQ(HeardRepeaters::CAPACITY, h.count(60 + 71 * 60));
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
