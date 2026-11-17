#include <gtest/gtest.h>
#include "helpers/ChannelLoad.h"

using namespace mesh;

// the radio receives `rx_per_s` ms of every second; the load is asked at the end
static uint16_t run(ChannelLoad& c, uint32_t start_ms, uint32_t seconds, uint32_t rx_per_s, uint32_t& rx_total) {
    uint32_t now = start_ms;
    for (uint32_t s = 0; s < seconds; s++) {
        now += 1000;
        rx_total += rx_per_s;
        c.update(now, rx_total);
    }
    return c.permille(now, rx_total);
}

TEST(ChannelLoad, NothingIsReportedBeforeThereIsHistory) {
    ChannelLoad c;
    EXPECT_EQ(0, c.permille(5000, 100));
    c.update(5000, 100);
    EXPECT_EQ(0, c.permille(9000, 4000));   // under one step of history
}

TEST(ChannelLoad, AQuietChannelReadsNearZeroAndABusyOneNearItsShare) {
    uint32_t rx = 0;
    ChannelLoad quiet, busy;
    EXPECT_EQ(0, run(quiet, 0, 120, 0, rx));
    rx = 0;
    EXPECT_NEAR(300, run(busy, 0, 120, 300, rx), 20);   // 300 ms of every second: 30 percent
}

TEST(ChannelLoad, OnlyTheLastMinuteCounts) {
    ChannelLoad c;
    uint32_t rx = 0;
    run(c, 0, 120, 900, rx);                            // two busy minutes...
    uint16_t p = run(c, 120000, 70, 0, rx);             // ...then a quiet minute and a bit
    EXPECT_LT(p, 80);
}

TEST(ChannelLoad, ItFollowsALoadThatRises) {
    ChannelLoad c;
    uint32_t rx = 0;
    run(c, 0, 90, 100, rx);
    EXPECT_NEAR(800, run(c, 90000, 90, 800, rx), 40);
}

TEST(ChannelLoad, ItIsCappedAtOneThousand) {
    ChannelLoad c;
    uint32_t rx = 0;
    EXPECT_EQ(1000, run(c, 0, 90, 1500, rx));          // a counter that ran ahead of the clock
}

TEST(ChannelLoad, ItSurvivesTheMillisecondClockWrapping) {
    ChannelLoad c;
    uint32_t rx = 0;
    uint32_t start = 0xFFFFFFFFu - 40000;               // wraps 40 s in
    EXPECT_NEAR(500, run(c, start, 100, 500, rx), 30);
}

TEST(ChannelLoad, ClearForgetsTheHistory) {
    ChannelLoad c;
    uint32_t rx = 0;
    run(c, 0, 90, 500, rx);
    c.clear();
    EXPECT_EQ(0, c.permille(91000, rx));
}

TEST(RetrySpacing, GrowsWithTheAttemptAndScalesWithTheFactor) {
    EXPECT_EQ(5000u, retrySpacingMs(0, 5000, 1000));
    EXPECT_EQ(10000u, retrySpacingMs(1, 5000, 1000));
    EXPECT_EQ(15000u, retrySpacingMs(2, 5000, 1000));
    EXPECT_EQ(2500u, retrySpacingMs(0, 5000, 500));
    EXPECT_EQ(7500u, retrySpacingMs(0, 5000, 1500));
}

TEST(RetrySpacing, ZeroSpacingIsOffAndTheFactorIsCutToItsRange) {
    EXPECT_EQ(0u, retrySpacingMs(3, 0, 1000));
    EXPECT_EQ(2500u, retrySpacingMs(0, 5000, 100));     // 0.1 is cut to 0.5
    EXPECT_EQ(7500u, retrySpacingMs(0, 5000, 9000));    // 9.0 is cut to 1.5
}

TEST(RetrySpacing, AnAttemptNumberOfFourOrMoreDoesNotOverflow) {
    EXPECT_EQ(25000u, retrySpacingMs(4, 5000, 1000));
    EXPECT_EQ((uint32_t)(60000ull * 256 * 1500 / 1000), retrySpacingMs(255, 60000, 1500));
}

int main(int argc, char** argv) {
    ::testing::InitGoogleTest(&argc, argv);
    return RUN_ALL_TESTS();
}
