#include <gtest/gtest.h>
#include "helpers/FrameRing.h"

typedef FrameRing<4, 8> Ring;

static void push1(Ring& r, uint8_t v) {
  uint8_t b[2] = { v, (uint8_t)(v + 1) };
  ASSERT_TRUE(r.push(b, 2));
}

TEST(FrameRing, NothingWorksUntilAllocated) {
  Ring r;
  uint8_t b[1] = { 1 };
  EXPECT_FALSE(r.allocated());
  EXPECT_FALSE(r.push(b, 1));
  EXPECT_TRUE(r.empty());
  EXPECT_EQ(0u, r.take(b));
  EXPECT_TRUE(r.alloc());
  EXPECT_TRUE(r.allocated());
  EXPECT_TRUE(r.alloc()); // a second call keeps the first storage
  EXPECT_TRUE(r.push(b, 1));
}

TEST(FrameRing, FramesComeOutOldestFirst) {
  Ring r;
  ASSERT_TRUE(r.alloc());
  push1(r, 10);
  push1(r, 20);
  push1(r, 30);
  EXPECT_EQ(3, r.size());
  uint8_t out[8];
  EXPECT_EQ(2u, r.take(out));
  EXPECT_EQ(10, out[0]);
  EXPECT_EQ(11, out[1]);
  EXPECT_EQ(2u, r.take(out));
  EXPECT_EQ(20, out[0]);
  EXPECT_EQ(2u, r.take(out));
  EXPECT_EQ(30, out[0]);
  EXPECT_EQ(0u, r.take(out));
  EXPECT_TRUE(r.empty());
}

TEST(FrameRing, AFullRingRefusesAndKeepsWhatItHas) {
  Ring r;
  ASSERT_TRUE(r.alloc());
  for (uint8_t i = 0; i < 4; i++) push1(r, i);
  EXPECT_TRUE(r.full());
  uint8_t b[1] = { 99 };
  EXPECT_FALSE(r.push(b, 1));
  EXPECT_EQ(4, r.size());
  uint8_t out[8];
  r.take(out);
  EXPECT_EQ(0, out[0]);
}

TEST(FrameRing, TheIndexWrapsAroundTheEnd) {
  Ring r;
  ASSERT_TRUE(r.alloc());
  uint8_t out[8];
  for (uint8_t round = 0; round < 10; round++) { // far more frames than slots
    push1(r, round);
    push1(r, round + 100);
    EXPECT_EQ(2u, r.take(out));
    EXPECT_EQ(round, out[0]);
    EXPECT_EQ(2u, r.take(out));
    EXPECT_EQ(round + 100, out[0]);
  }
  EXPECT_TRUE(r.empty());
}

TEST(FrameRing, WrapKeepsOrderWhenPartlyFull) {
  Ring r;
  ASSERT_TRUE(r.alloc());
  uint8_t out[8];
  push1(r, 1);
  push1(r, 2);
  push1(r, 3);
  r.take(out);
  r.take(out); // head is now 2
  push1(r, 4);
  push1(r, 5);
  push1(r, 6); // the last two wrap past the end
  EXPECT_TRUE(r.full());
  for (uint8_t want = 3; want <= 6; want++) {
    EXPECT_EQ(2u, r.take(out));
    EXPECT_EQ(want, out[0]);
  }
}

TEST(FrameRing, FrontShowsTheOldestWithoutRemovingIt) {
  Ring r;
  ASSERT_TRUE(r.alloc());
  size_t n = 0;
  EXPECT_EQ(nullptr, r.front(n));
  push1(r, 7);
  const uint8_t* f = r.front(n);
  ASSERT_NE(nullptr, f);
  EXPECT_EQ(2u, n);
  EXPECT_EQ(7, f[0]);
  EXPECT_EQ(1, r.size());
  r.pop();
  EXPECT_TRUE(r.empty());
  r.pop(); // popping an empty ring does nothing
  EXPECT_EQ(0, r.size());
}

TEST(FrameRing, EmptyAndOversizeFramesAreRefused) {
  Ring r;
  ASSERT_TRUE(r.alloc());
  uint8_t big[9] = { 0 };
  EXPECT_FALSE(r.push(big, 0));
  EXPECT_FALSE(r.push(big, 9));
  EXPECT_TRUE(r.push(big, 8)); // the largest that fits
}

TEST(FrameRing, ClearForgetsEverythingAndStartsFromTheTop) {
  Ring r;
  ASSERT_TRUE(r.alloc());
  push1(r, 1);
  push1(r, 2);
  r.clear();
  EXPECT_TRUE(r.empty());
  push1(r, 9);
  uint8_t out[8];
  r.take(out);
  EXPECT_EQ(9, out[0]);
}

int main(int argc, char** argv) {
  ::testing::InitGoogleTest(&argc, argv);
  return RUN_ALL_TESTS();
}
