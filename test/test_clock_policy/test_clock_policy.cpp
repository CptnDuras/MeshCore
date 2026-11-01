#include <gtest/gtest.h>
#include "helpers/ClockPolicy.h"

static const uint32_t TODAY = 1793000000; // an ordinary date
static const uint32_t YEAR = 365UL * 24 * 3600;
static const uint32_t IN_2072 = 3200000000UL;

TEST(ClockSetAllowed, ForwardIsAllowed) {
  EXPECT_TRUE(clockSetAllowed(TODAY + 10, TODAY, false));
  EXPECT_TRUE(clockSetAllowed(TODAY, TODAY, false));
}

TEST(ClockSetAllowed, BackwardsIsRefused) {
  EXPECT_FALSE(clockSetAllowed(TODAY - 10, TODAY, false));
  EXPECT_FALSE(clockSetAllowed(TODAY - YEAR, TODAY, false)); // exactly a year is still within the limit
}

TEST(ClockSetAllowed, ABadClockMoreThanAYearAheadCanBeCorrected) {
  EXPECT_TRUE(clockSetAllowed(TODAY, IN_2072, false));
  EXPECT_TRUE(clockSetAllowed(TODAY - YEAR - 1, TODAY, false));
}

TEST(ClockSetAllowed, ForceSetsAnyTime) {
  EXPECT_TRUE(clockSetAllowed(TODAY - 10, TODAY, true));
  EXPECT_TRUE(clockSetAllowed(TODAY, TODAY + 60, true));
  EXPECT_TRUE(clockSetAllowed(0, TODAY, true));
}

TEST(ClockSetForced, OnlyASixthByteOfOneForces) {
  const uint8_t five[5] = { 6, 0, 0, 0, 0 };
  const uint8_t one[6] = { 6, 0, 0, 0, 0, 1 };
  const uint8_t zero[6] = { 6, 0, 0, 0, 0, 0 };
  const uint8_t two[6] = { 6, 0, 0, 0, 0, 2 };
  const uint8_t longer[8] = { 6, 0, 0, 0, 0, 1, 9, 9 };
  EXPECT_FALSE(clockSetForced(five, 5));
  EXPECT_TRUE(clockSetForced(one, 6));
  EXPECT_FALSE(clockSetForced(zero, 6));
  EXPECT_FALSE(clockSetForced(two, 6));
  EXPECT_TRUE(clockSetForced(longer, 8));
}

TEST(ClockSetForced, AByteBeyondTheLengthIsNotRead) {
  // a stale sixth byte left in the buffer from an earlier, longer frame must not force a five-byte one
  const uint8_t buf[6] = { 6, 0, 0, 0, 0, 1 };
  EXPECT_FALSE(clockSetForced(buf, 5));
}

// What upstream does today: set the time only when it is not earlier than the clock. The new rule must agree with it everywhere
// except the two cases it was added for (a clock a year ahead, and a forced set), so an old app sees no change.
TEST(ClockSetAllowed, AgreesWithTheOldUpstreamRuleForOrdinaryFrames) {
  const uint32_t clocks[] = { 0, 1, 1000, TODAY, TODAY + YEAR, 0xFFFFFF00u };
  const int32_t offsets[] = { -4000000, -1000, -1, 0, 1, 1000, 4000000 };
  for (uint32_t current : clocks) {
    for (int32_t off : offsets) {
      uint32_t secs = current + (uint32_t)off;
      bool oldRule = secs >= current;
      bool wrapped = (off < 0) != (secs < current); // the grid wrapped past 0 or 2^32: not a case a real frame makes
      if (wrapped) continue;
      bool aYearAhead = current - secs > CLOCK_MAX_AHEAD_SECS && secs < current;
      if (aYearAhead) continue; // the new rule allows this one on purpose
      EXPECT_EQ(oldRule, clockSetAllowed(secs, current, false)) << "clock " << current << " secs " << secs;
    }
  }
}

TEST(ClockSetAllowed, TheOnlyExtraCasesAreAYearAheadAndForce) {
  // everything the old rule refused and the new one allows is one of those two
  const uint32_t current = TODAY;
  for (uint32_t secs = current - 3 * YEAR; secs < current; secs += YEAR / 7) {
    bool allowed = clockSetAllowed(secs, current, false);
    EXPECT_EQ(current - secs > CLOCK_MAX_AHEAD_SECS, allowed) << secs;
    EXPECT_TRUE(clockSetAllowed(secs, current, true));
  }
}

TEST(BootClockFloor, NoStampsLeavesTheClock) {
  BootClockFloor f(TODAY);
  uint32_t t = 0;
  EXPECT_FALSE(f.newTime(t));
}

TEST(BootClockFloor, TheNewestStampPlusOneWhenTheClockIsBehindIt) {
  BootClockFloor f(1000);
  f.add(2000);
  f.add(5000);
  f.add(3000);
  uint32_t t = 0;
  ASSERT_TRUE(f.newTime(t));
  EXPECT_EQ(5001u, t);
}

TEST(BootClockFloor, NeverMovesTheClockBack) {
  BootClockFloor f(TODAY);
  f.add(TODAY - 500);
  uint32_t t = 0;
  EXPECT_FALSE(f.newTime(t));
}

TEST(BootClockFloor, AStampEqualToTheClockStillMovesItForwardByOne) {
  BootClockFloor f(TODAY);
  f.add(TODAY);
  uint32_t t = 0;
  ASSERT_TRUE(f.newTime(t));
  EXPECT_EQ(TODAY + 1, t);
}

TEST(BootClockFloor, AStampFromAWrongClockIsIgnored) {
  // a contact heard while the node thought it was 2072, saved, and met again at every boot
  BootClockFloor f(TODAY);
  f.add(IN_2072);
  f.add(TODAY + 100);
  uint32_t t = 0;
  ASSERT_TRUE(f.newTime(t));
  EXPECT_EQ(TODAY + 101, t);
}

TEST(BootClockFloor, OnlyWrongStampsLeavesTheClock) {
  BootClockFloor f(TODAY);
  f.add(IN_2072);
  uint32_t t = 0;
  EXPECT_FALSE(f.newTime(t));
}

TEST(BootClockFloor, TheCeilingIsInclusive) {
  BootClockFloor f(TODAY);
  f.add(TODAY + YEAR);
  f.add(TODAY + YEAR + 1);
  uint32_t t = 0;
  ASSERT_TRUE(f.newTime(t));
  EXPECT_EQ(TODAY + YEAR + 1, t);
}

int main(int argc, char** argv) {
  ::testing::InitGoogleTest(&argc, argv);
  return RUN_ALL_TESTS();
}
