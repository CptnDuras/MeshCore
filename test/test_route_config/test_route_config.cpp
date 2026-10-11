#include <gtest/gtest.h>
#include "helpers/RouteConfig.h"

using namespace mesh;

TEST(RouteConfig, DefaultsAreOffWithTheSpecifiedNumbers) {
    RouteConfigValues v;
    EXPECT_EQ(0, v.enabled);
    EXPECT_EQ(4, v.id_bytes);
    EXPECT_EQ(3600, v.full_period_s);
    EXPECT_EQ(7200, v.life_s);
    EXPECT_EQ(67, v.refresh_pct);
    EXPECT_EQ(60, v.min_gap_s);
    EXPECT_EQ(2, v.repeats);
}

TEST(RouteConfig, SetsEachValueAndSaysOK) {
    RouteConfigValues v;
    char r[80];
    EXPECT_TRUE(routeSet(v, "enable", "on", r)); EXPECT_STREQ("OK", r); EXPECT_EQ(1, v.enabled);
    EXPECT_TRUE(routeSet(v, "enable", "off", r)); EXPECT_EQ(0, v.enabled);
    EXPECT_TRUE(routeSet(v, "id_bytes", "2", r)); EXPECT_EQ(2, v.id_bytes);
    EXPECT_TRUE(routeSet(v, "full_period", "1800", r)); EXPECT_EQ(1800, v.full_period_s);
    EXPECT_TRUE(routeSet(v, "full_period", "28800", r)); EXPECT_EQ(28800, v.full_period_s);
    EXPECT_TRUE(routeSet(v, "full_period", "0", r)); EXPECT_EQ(0, v.full_period_s);
    EXPECT_TRUE(routeSet(v, "life", "600", r)); EXPECT_EQ(600, v.life_s);
    EXPECT_TRUE(routeSet(v, "refresh", "50", r)); EXPECT_EQ(50, v.refresh_pct);
    EXPECT_TRUE(routeSet(v, "min_gap", "120", r)); EXPECT_EQ(120, v.min_gap_s);
    EXPECT_TRUE(routeSet(v, "repeats", "3", r)); EXPECT_EQ(3, v.repeats);
}

TEST(RouteConfig, TheFullPeriodHasAThirtyMinuteFloor) {
    RouteConfigValues v;
    char r[80];
    EXPECT_FALSE(routeSet(v, "full_period", "1799", r));
    EXPECT_NE(nullptr, strstr(r, "1800"));
    EXPECT_FALSE(routeSet(v, "full_period", "60", r));
    EXPECT_FALSE(routeSet(v, "full_period", "28801", r));
    EXPECT_EQ(3600, v.full_period_s);                       // nothing changed
}

TEST(RouteConfig, RefusesOutOfRangeAndGarbage) {
    RouteConfigValues v;
    char r[80];
    EXPECT_FALSE(routeSet(v, "enable", "maybe", r));
    EXPECT_FALSE(routeSet(v, "enable", "", r));
    EXPECT_FALSE(routeSet(v, "id_bytes", "1", r));
    EXPECT_FALSE(routeSet(v, "id_bytes", "5", r));
    EXPECT_FALSE(routeSet(v, "id_bytes", "four", r));
    EXPECT_FALSE(routeSet(v, "life", "599", r));
    EXPECT_FALSE(routeSet(v, "life", "40000", r));
    EXPECT_FALSE(routeSet(v, "refresh", "9", r));
    EXPECT_FALSE(routeSet(v, "refresh", "96", r));
    EXPECT_FALSE(routeSet(v, "min_gap", "9", r));
    EXPECT_FALSE(routeSet(v, "min_gap", "601", r));
    EXPECT_FALSE(routeSet(v, "repeats", "0", r));
    EXPECT_FALSE(routeSet(v, "repeats", "4", r));
    EXPECT_FALSE(routeSet(v, "nonsense", "1", r));
    EXPECT_STREQ("Error, unknown route setting", r);
    RouteConfigValues fresh;
    EXPECT_EQ(fresh.life_s, v.life_s);
    EXPECT_EQ(fresh.repeats, v.repeats);
    EXPECT_EQ(0, v.enabled);
}

TEST(RouteConfig, ValuesWithTrailingTextAreRefused) {
    RouteConfigValues v;
    char r[80];
    EXPECT_FALSE(routeSet(v, "repeats", "2x", r));
    EXPECT_FALSE(routeSet(v, "enable", "onward", r));
    EXPECT_TRUE(routeSet(v, "repeats", "3 ", r));            // a trailing space is fine
}

TEST(RouteConfig, GetsEachValueAndAllOfThem) {
    RouteConfigValues v;
    char r[160];
    ASSERT_TRUE(routeGet(v, "enable", r)); EXPECT_STREQ("> off", r);
    ASSERT_TRUE(routeGet(v, "full_period", r)); EXPECT_STREQ("> 3600", r);
    ASSERT_TRUE(routeGet(v, "", r));
    EXPECT_STREQ("> off id_bytes=4 full_period=3600 life=7200 refresh=67 min_gap=60 repeats=2", r);
    EXPECT_FALSE(routeGet(v, "nonsense", r));
}

TEST(RouteConfig, SanitizeBringsBadSavedValuesBackInRange) {
    RouteConfigValues v;
    v.enabled = 7; v.id_bytes = 9; v.full_period_s = 60; v.life_s = 5; v.refresh_pct = 0; v.min_gap_s = 0; v.repeats = 99;
    routeSanitize(v);
    EXPECT_EQ(0, v.enabled);
    EXPECT_EQ(4, v.id_bytes);
    EXPECT_EQ(1800, v.full_period_s);
    EXPECT_EQ(600, v.life_s);
    EXPECT_EQ(67, v.refresh_pct);
    EXPECT_EQ(10, v.min_gap_s);
    EXPECT_EQ(2, v.repeats);
    v.full_period_s = 0;            // lifetimes mode survives
    v.full_period_s = 0;
    routeSanitize(v);
    EXPECT_EQ(0, v.full_period_s);
    v.full_period_s = 65000;
    routeSanitize(v);
    EXPECT_EQ(28800, v.full_period_s);
}

TEST(RouteConfig, BecomesTheRoutingCoreConfiguration) {
    RouteConfigValues v;
    v.id_bytes = 3; v.full_period_s = 0; v.life_s = 1200; v.refresh_pct = 50; v.min_gap_s = 90; v.repeats = 1;
    RoutingConfig c = toRoutingConfig(v, 9);
    EXPECT_EQ(3, c.id_bytes);
    EXPECT_EQ(9, c.sf);
    EXPECT_EQ(0, c.full_period_s);
    EXPECT_EQ(1200, c.life_s);
    EXPECT_EQ(50, c.refresh_pct);
    EXPECT_EQ(90, c.min_gap_s);
    EXPECT_EQ(1, c.repeats);
}

int main(int argc, char** argv) {
    ::testing::InitGoogleTest(&argc, argv);
    return RUN_ALL_TESTS();
}
