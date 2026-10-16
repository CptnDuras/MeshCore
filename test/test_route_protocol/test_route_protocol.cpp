#include <gtest/gtest.h>
#include "helpers/RouteProtocol.h"

using namespace mesh;

static void expectBytes(const uint8_t* got, int len, std::initializer_list<int> want) {
    ASSERT_EQ((int)want.size(), len);
    int i = 0;
    for (int b : want) EXPECT_EQ(b, got[i++]) << "byte " << i - 1;
}

TEST(RouteIds, TakenFromTheFirstBytesOfTheKey) {
    const uint8_t key[] = {0xA1, 0xB2, 0xC3, 0xD4, 0xE5};
    EXPECT_EQ(0xA1B2C3D4u, routeIdFromKey(key, 4));
    EXPECT_EQ(0xA1B2C300u, routeIdFromKey(key, 3));
    EXPECT_EQ(0xA1B20000u, routeIdFromKey(key, 2));
    EXPECT_EQ(0xFFFF0000u, routeIdMask(2));
    EXPECT_EQ(0xFFFFFF00u, routeIdMask(3));
    EXPECT_EQ(0xFFFFFFFFu, routeIdMask(4));
}

TEST(Checkin, HasTheDocumentedBytes) {
    Checkin c = {};
    c.mobile = true; c.id_bytes = 4; c.id = 0xD90E4417; c.counter = 0x0122; c.ttl_s = 2248;   // 281 units of 8 s
    uint8_t buf[16];
    int n = encodeCheckin(c, buf, sizeof(buf));
    expectBytes(buf, n, {0xD0 | 0x01 | (2 << 2), 0xD9, 0x0E, 0x44, 0x17, 0x22, 0x01, 0x19, 0x01});
}

TEST(Checkin, RoundTripsForEveryIdSize) {
    for (int bytes = 2; bytes <= 4; bytes++) {
        Checkin c = {};
        c.mobile = true; c.going_away = true; c.id_bytes = bytes;
        c.id = 0xD90E4417 & routeIdMask(bytes); c.counter = 65534; c.ttl_s = 800;
        uint8_t buf[16];
        int n = encodeCheckin(c, buf, sizeof(buf));
        ASSERT_EQ(1 + bytes + 4, n);
        Checkin d = {};
        ASSERT_TRUE(decodeCheckin(buf, n, d));
        EXPECT_EQ(c.id, d.id);
        EXPECT_EQ(bytes, d.id_bytes);
        EXPECT_TRUE(d.mobile);
        EXPECT_TRUE(d.going_away);
        EXPECT_EQ(65534, d.counter);
        EXPECT_EQ(800, d.ttl_s);
    }
}

TEST(Checkin, TheTimeToLiveRoundsUpToWholeUnits) {
    Checkin c = {};
    c.id_bytes = 4; c.id = 1; c.counter = 2; c.ttl_s = 1;
    uint8_t buf[16];
    int n = encodeCheckin(c, buf, sizeof(buf));
    Checkin d = {};
    ASSERT_TRUE(decodeCheckin(buf, n, d));
    EXPECT_EQ(8, d.ttl_s);                 // never rounds a live client down to zero
    c.ttl_s = 0;
    n = encodeCheckin(c, buf, sizeof(buf));
    ASSERT_TRUE(decodeCheckin(buf, n, d));
    EXPECT_EQ(0, d.ttl_s);
}

TEST(Checkin, TheIdIsCutToTheConfiguredLength) {
    Checkin c = {};
    c.id_bytes = 2; c.id = 0xD90E4417; c.counter = 2; c.ttl_s = 8;
    uint8_t buf[16];
    int n = encodeCheckin(c, buf, sizeof(buf));
    Checkin d = {};
    ASSERT_TRUE(decodeCheckin(buf, n, d));
    EXPECT_EQ(0xD90E0000u, d.id);
}

TEST(Checkin, RefusesWhatIsMalformed) {
    Checkin c = {}, d = {};
    uint8_t buf[16];
    c.id_bytes = 4; c.id = 1; c.counter = 2; c.ttl_s = 8;
    int n = encodeCheckin(c, buf, sizeof(buf));
    EXPECT_FALSE(decodeCheckin(buf, n - 1, d));      // truncated
    uint8_t longer[16]; memcpy(longer, buf, n); longer[n] = 0;
    EXPECT_FALSE(decodeCheckin(longer, n + 1, d));   // extra byte
    EXPECT_FALSE(decodeCheckin(buf, 0, d));
    uint8_t bad[16]; memcpy(bad, buf, n);
    bad[0] = 0xC0 | (2 << 2);                        // that is a route advert
    EXPECT_FALSE(decodeCheckin(bad, n, d));
    memcpy(bad, buf, n); bad[0] = 0xD0 | (3 << 2);   // id size code 3 does not exist
    EXPECT_FALSE(decodeCheckin(bad, n, d));
    c.id_bytes = 5;
    EXPECT_EQ(0, encodeCheckin(c, buf, sizeof(buf)));
    c.id_bytes = 4;
    EXPECT_EQ(0, encodeCheckin(c, buf, 5));          // buffer too small
}

static RouteAdv exampleAdv() {
    RouteAdv a = {};
    a.id_bytes = 4; a.origin = 0xA1B2C3D4; a.count = 4;
    a.entries[0] = {0xA1B2C3D4, 0, 68, 7168};     // 56 units of 128 s
    a.entries[1] = {0x7F03E911, 1, 73, 6912};     // 54
    a.entries[2] = {0x2C58B6A0, 1, 72, 6784};     // 53
    a.entries[3] = {0xD90E4417, 17, 290, 384};    // 3
    return a;
}

TEST(RouteAdv, HasTheBytesShownInTheSpec) {
    uint8_t buf[200];
    int n = encodeRouteAdv(exampleAdv(), buf, sizeof(buf));
    expectBytes(buf, n, {0xC8, 0xA1, 0xB2, 0xC3, 0xD4, 0x04,
                         0xA1, 0xB2, 0xC3, 0xD4, 0x00, 0x44, 0x00, 0x38,
                         0x7F, 0x03, 0xE9, 0x11, 0x01, 0x49, 0x00, 0x36,
                         0x2C, 0x58, 0xB6, 0xA0, 0x01, 0x48, 0x00, 0x35,
                         0xD9, 0x0E, 0x44, 0x17, 0x11, 0x22, 0x01, 0x03});
}

TEST(RouteAdv, RoundTrips) {
    RouteAdv a = exampleAdv();
    a.full = true; a.reply_requested = true;
    uint8_t buf[200];
    int n = encodeRouteAdv(a, buf, sizeof(buf));
    RouteAdv b = {};
    ASSERT_TRUE(decodeRouteAdv(buf, n, b));
    EXPECT_TRUE(b.full);
    EXPECT_TRUE(b.reply_requested);
    EXPECT_EQ(4, b.id_bytes);
    EXPECT_EQ(a.origin, b.origin);
    ASSERT_EQ(4, b.count);
    for (int i = 0; i < 4; i++) {
        EXPECT_EQ(a.entries[i].dest, b.entries[i].dest);
        EXPECT_EQ(a.entries[i].cost, b.entries[i].cost);
        EXPECT_EQ(a.entries[i].seq, b.entries[i].seq);
        EXPECT_EQ(a.entries[i].life_s, b.entries[i].life_s);
    }
}

TEST(RouteAdv, LifetimesRoundUpToWholeUnitsAndSaturate) {
    RouteAdv a = exampleAdv();
    a.count = 3;
    a.entries[0].life_s = 1;        // -> 128
    a.entries[1].life_s = 129;      // -> 256
    a.entries[2].life_s = 60000;    // beyond 255 units (32640 s)
    uint8_t buf[200];
    int n = encodeRouteAdv(a, buf, sizeof(buf));
    RouteAdv b = {};
    ASSERT_TRUE(decodeRouteAdv(buf, n, b));
    EXPECT_EQ(128, b.entries[0].life_s);
    EXPECT_EQ(256, b.entries[1].life_s);
    EXPECT_EQ(255 * 128, b.entries[2].life_s);
}

TEST(RouteAdv, TheMostEntriesDependOnTheIdSize) {
    EXPECT_EQ(18, routeAdvMaxEntries(4));
    EXPECT_EQ(20, routeAdvMaxEntries(3));
    EXPECT_EQ(24, routeAdvMaxEntries(2));
    for (int bytes = 2; bytes <= 4; bytes++) {
        RouteAdv a = {};
        a.id_bytes = bytes; a.origin = 0x01020304 & routeIdMask(bytes);
        a.count = routeAdvMaxEntries(bytes);
        for (int i = 0; i < a.count; i++) a.entries[i] = {(RouteId)(0x10000000u * (i % 15 + 1)) & routeIdMask(bytes), (uint8_t)i, (uint16_t)(i * 3), 128};
        uint8_t buf[200];
        int n = encodeRouteAdv(a, buf, sizeof(buf));
        ASSERT_GT(n, 0);
        EXPECT_LE(n, 150);
        RouteAdv b = {};
        ASSERT_TRUE(decodeRouteAdv(buf, n, b));
        EXPECT_EQ(a.count, b.count);
        a.count++;
        EXPECT_EQ(0, encodeRouteAdv(a, buf, sizeof(buf)));   // one more does not fit
    }
}

TEST(RouteAdv, ARepeaterWithNothingToSayIsStillValid) {
    RouteAdv a = {};
    a.id_bytes = 3; a.origin = 0x010203FF;
    uint8_t buf[16];
    int n = encodeRouteAdv(a, buf, sizeof(buf));
    EXPECT_EQ(1 + 3 + 1, n);
    RouteAdv b = {};
    ASSERT_TRUE(decodeRouteAdv(buf, n, b));
    EXPECT_EQ(0, b.count);
    EXPECT_EQ(0x01020300u, b.origin);
}

TEST(RouteAdv, RefusesWhatIsMalformed) {
    uint8_t buf[200];
    int n = encodeRouteAdv(exampleAdv(), buf, sizeof(buf));
    RouteAdv b = {};
    EXPECT_FALSE(decodeRouteAdv(buf, n - 1, b));     // truncated mid entry
    EXPECT_FALSE(decodeRouteAdv(buf, 5, b));         // header only, count missing
    uint8_t more[200]; memcpy(more, buf, n); more[n] = 0;
    EXPECT_FALSE(decodeRouteAdv(more, n + 1, b));    // trailing byte
    uint8_t bad[200]; memcpy(bad, buf, n);
    bad[5] = 5;                                      // claims five entries but carries four
    EXPECT_FALSE(decodeRouteAdv(bad, n, b));
    memcpy(bad, buf, n); bad[5] = 19;
    EXPECT_FALSE(decodeRouteAdv(bad, n, b));         // more than a packet can hold
    memcpy(bad, buf, n); bad[0] = 0xD8;              // that is a check-in
    EXPECT_FALSE(decodeRouteAdv(bad, n, b));
    memcpy(bad, buf, n); bad[0] = 0xC0 | (3 << 2);
    EXPECT_FALSE(decodeRouteAdv(bad, n, b));         // id size code 3
    EXPECT_FALSE(decodeRouteAdv(buf, 0, b));
}

TEST(RouteAdv, TheTypeCheckMatchesOnlyTheseSubtypes) {
    uint8_t p = 0xC8;
    EXPECT_TRUE(isRouteAdv(&p, 1));
    EXPECT_FALSE(isCheckin(&p, 1));
    p = 0xD8;
    EXPECT_TRUE(isCheckin(&p, 1));
    p = 0xA0;   // ping
    EXPECT_FALSE(isRouteAdv(&p, 1));
    EXPECT_FALSE(isCheckin(&p, 1));
    p = 0x80;   // node discovery
    EXPECT_FALSE(isRouteAdv(&p, 1));
    EXPECT_FALSE(isRouteAdv(&p, 0));
}

int main(int argc, char** argv) {
    ::testing::InitGoogleTest(&argc, argv);
    return RUN_ALL_TESTS();
}
