#include <gtest/gtest.h>
#include "helpers/PingProtocol.h"

using namespace mesh;

static PingRequest req(uint8_t filter = 0xFF, uint8_t window = 0, uint8_t prob = 255) {
    PingRequest r;
    r.type_filter = filter; r.tag = 0xA1B2C3D4; r.probability = prob; r.window_s = window;
    return r;
}

TEST(PingRequest, SurvivesEncodingAndDecoding) {
    uint8_t buf[16];
    size_t n = pingEncodeRequest(req(0x06, 5, 128), buf);
    EXPECT_EQ(PING_REQ_LEN, n);
    PingRequest got;
    ASSERT_TRUE(pingDecodeRequest(buf, n, got));
    EXPECT_EQ(0x06, got.type_filter);
    EXPECT_EQ(0xA1B2C3D4u, got.tag);
    EXPECT_EQ(5, got.window_s);
    EXPECT_EQ(128, got.probability);
}

TEST(PingRequest, IsZeroHopOnlyBecauseTheTopBitIsSet) {
    uint8_t buf[16];
    pingEncodeRequest(req(), buf);
    EXPECT_NE(0, buf[0] & 0x80);   // the mesh never forwards control types with the top bit set
    EXPECT_TRUE(pingIsRequest(buf, PING_REQ_LEN));
    EXPECT_FALSE(pingIsResponse(buf, PING_REQ_LEN));
    PingResponse r; memset(&r, 0, sizeof(r));
    size_t n = pingEncodeResponse(r, buf);
    EXPECT_NE(0, buf[0] & 0x80);
    EXPECT_TRUE(pingIsResponse(buf, n));
}

TEST(PingRequest, DoesNotCollideWithDiscovery) {
    uint8_t discover_req = 0x80, discover_resp = 0x90;
    EXPECT_FALSE(pingIsRequest(&discover_req, 1));
    EXPECT_FALSE(pingIsRequest(&discover_resp, 1));
    EXPECT_FALSE(pingIsResponse(&discover_req, 1));
    EXPECT_FALSE(pingIsResponse(&discover_resp, 1));
}

TEST(PingRequest, ShortOrWrongPacketsAreRejected) {
    uint8_t buf[16];
    size_t n = pingEncodeRequest(req(), buf);
    PingRequest got;
    EXPECT_FALSE(pingDecodeRequest(buf, n - 1, got));
    EXPECT_FALSE(pingDecodeRequest(buf, 0, got));
    buf[0] = 0x80;   // a DISCOVER_REQ is not a ping
    EXPECT_FALSE(pingDecodeRequest(buf, n, got));
}

static PingResponse resp(const char* name) {
    PingResponse r; memset(&r, 0, sizeof(r));
    r.node_type = 2; r.snr_x4 = -26; r.tag = 77; r.fw_ver = 14;
    for (int i = 0; i < 8; i++) r.pubkey_prefix[i] = (uint8_t)(0x10 + i);
    strncpy(r.name, name, PING_MAX_NAME);
    return r;
}

TEST(PingResponse, SurvivesEncodingAndDecoding) {
    uint8_t buf[64];
    size_t n = pingEncodeResponse(resp("Buffalo Hill"), buf);
    PingResponse got;
    ASSERT_TRUE(pingDecodeResponse(buf, n, got));
    EXPECT_EQ(2, got.node_type);
    EXPECT_EQ(-26, got.snr_x4);
    EXPECT_EQ(77u, got.tag);
    EXPECT_EQ(14, got.fw_ver);
    EXPECT_EQ(0x13, got.pubkey_prefix[3]);
    EXPECT_STREQ("Buffalo Hill", got.name);
}

TEST(PingResponse, ANameLongerThanTheLimitIsCutNotOverrun) {
    uint8_t buf[64];
    PingResponse r = resp("");
    memset(r.name, 'x', PING_MAX_NAME);       // exactly full, no terminator
    size_t n = pingEncodeResponse(r, buf);
    EXPECT_EQ(PING_RESP_MIN_LEN + PING_MAX_NAME, n);
    PingResponse got;
    ASSERT_TRUE(pingDecodeResponse(buf, n, got));
    EXPECT_EQ(PING_MAX_NAME, (int)strlen(got.name));
}

TEST(PingResponse, AnEmptyNameIsFine) {
    uint8_t buf[64];
    size_t n = pingEncodeResponse(resp(""), buf);
    PingResponse got;
    ASSERT_TRUE(pingDecodeResponse(buf, n, got));
    EXPECT_STREQ("", got.name);
}

TEST(PingResponse, ALyingNameLengthIsRejected) {
    uint8_t buf[64];
    size_t n = pingEncodeResponse(resp("abc"), buf);
    buf[PING_RESP_MIN_LEN - 1] = 200;          // claims 200 bytes of name
    PingResponse got;
    EXPECT_FALSE(pingDecodeResponse(buf, n, got));
    buf[PING_RESP_MIN_LEN - 1] = 10;           // claims more than is there
    EXPECT_FALSE(pingDecodeResponse(buf, n, got));
}

TEST(PingResponse, TruncatedOrWrongPacketsAreRejected) {
    uint8_t buf[64];
    size_t n = pingEncodeResponse(resp("abc"), buf);
    PingResponse got;
    EXPECT_FALSE(pingDecodeResponse(buf, PING_RESP_MIN_LEN - 1, got));
    buf[0] = CTL_TYPE_PING_REQ;
    EXPECT_FALSE(pingDecodeResponse(buf, n, got));
}

TEST(PingPolicy, OnlyTheRequestedKindsAnswer) {
    // filter bit n = ADV_TYPE n: 1 chat client, 2 repeater, 3 room, 4 sensor
    PingRequest repeaters = req(1 << 2);
    EXPECT_TRUE(pingShouldRespond(repeaters, 2, 0));
    EXPECT_FALSE(pingShouldRespond(repeaters, 1, 0));
    EXPECT_FALSE(pingShouldRespond(repeaters, 3, 0));
    EXPECT_TRUE(pingShouldRespond(req(0xFF), 1, 0));
    EXPECT_FALSE(pingShouldRespond(req(0x00), 2, 0));
    EXPECT_FALSE(pingShouldRespond(req(0xFF), 9, 0));   // an unknown type never answers
}

TEST(PingPolicy, ProbabilityControlsTheShareThatAnswers) {
    EXPECT_TRUE(pingShouldRespond(req(0xFF, 3, 255), 2, 255));   // 255 = always
    EXPECT_FALSE(pingShouldRespond(req(0xFF, 3, 0), 2, 0));      // 0 = never
    int answered = 0;
    for (int b = 0; b < 256; b++) if (pingShouldRespond(req(0xFF, 3, 64), 2, (uint8_t)b)) answered++;
    EXPECT_EQ(64, answered);                                      // a quarter of the possible draws
}

TEST(PingPolicy, AnswersAreSpreadOverTheRequestedWindowAndNeverImmediate) {
    PingRequest r = req(0xFF, 10);
    uint32_t lo = 0xFFFFFFFF, hi = 0;
    for (uint32_t v = 0; v < 10000; v += 13) {
        uint32_t d = pingResponseDelayMs(r, v);
        if (d < lo) lo = d;
        if (d > hi) hi = d;
    }
    EXPECT_GE(lo, 300u);              // never straight away
    EXPECT_LT(hi, 300u + 10000u);     // never later than the window
    EXPECT_GT(hi, 9000u);             // and really uses the window
}

TEST(PingPolicy, AZeroWindowMeansTheDefaultAndABigOneIsCapped) {
    EXPECT_LT(pingResponseDelayMs(req(0xFF, 0), 999999), 300u + PING_DEFAULT_WINDOW_S * 1000u);
    uint32_t cap = 300u + PING_MAX_WINDOW_S * 1000u;
    for (uint32_t v = 0; v < 100000; v += 997) EXPECT_LT(pingResponseDelayMs(req(0xFF, 255), v), cap);
}

TEST(PingRateLimiter, AllowsUpToTheLimitThenStops) {
    PingRateLimiter l(3, 100);
    EXPECT_TRUE(l.allow(1000));
    EXPECT_TRUE(l.allow(1001));
    EXPECT_TRUE(l.allow(1002));
    EXPECT_FALSE(l.allow(1003));
    EXPECT_FALSE(l.allow(1099));    // still inside the window that began at 1000
}

TEST(PingRateLimiter, RecoversWhenTheWindowEnds) {
    PingRateLimiter l(2, 100);
    l.allow(1000); l.allow(1010);
    EXPECT_FALSE(l.allow(1050));
    EXPECT_TRUE(l.allow(1100));     // 100 s after the window opened
    EXPECT_TRUE(l.allow(1101));
    EXPECT_FALSE(l.allow(1102));
}

TEST(PingRateLimiter, TheFirstCallWorksEvenAtTimeZero) {
    PingRateLimiter l(1, 100);
    EXPECT_TRUE(l.allow(0));
    EXPECT_FALSE(l.allow(5));
}

int main(int argc, char** argv) {
    ::testing::InitGoogleTest(&argc, argv);
    return RUN_ALL_TESTS();
}
