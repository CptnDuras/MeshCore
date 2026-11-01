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
