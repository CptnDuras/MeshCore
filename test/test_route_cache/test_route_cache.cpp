#include <gtest/gtest.h>
#include "helpers/RouteCache.h"

using namespace mesh;

static const uint8_t A[ROUTE_KEY_SIZE] = {1, 2, 3, 4, 5, 6, 7, 8};
static const uint8_t B[ROUTE_KEY_SIZE] = {9, 9, 9, 9, 9, 9, 9, 9};

static uint8_t plen(uint8_t hash_size, uint8_t hops) { return ((hash_size - 1) << 6) | hops; }

TEST(RouteCache, StartsEmpty) {
    RouteCache<4> rc;
    EXPECT_EQ(0, rc.count());
    EXPECT_EQ(NULL, rc.find(A));
    EXPECT_EQ(NULL, rc.at(0));
    EXPECT_EQ(NULL, rc.at(-1));
    EXPECT_EQ(NULL, rc.at(99));
}

TEST(RouteCache, LearnsADirectlyHeardNode) {
    RouteCache<4> rc;
    EXPECT_EQ(ROUTE_INSERTED, rc.learn(A, NULL, plen(1, 0), 100, -20));
    auto e = rc.find(A);
    ASSERT_NE(nullptr, e);
    EXPECT_EQ(0, e->hopCount());
    EXPECT_EQ(100u, e->heard);
    EXPECT_EQ(-20, e->snr);
}

TEST(RouteCache, StoresThePathAndItsHashSize) {
    RouteCache<4> rc;
    const uint8_t path[] = {0x11, 0x22, 0x33, 0x44};
    rc.learn(A, path, plen(2, 2), 100, 8);
    auto e = rc.find(A);
    ASSERT_NE(nullptr, e);
    EXPECT_EQ(2, e->hopCount());
    EXPECT_EQ(2, e->hashSize());
    EXPECT_EQ(4, e->pathBytes());
    EXPECT_EQ(0, memcmp(e->path, path, 4));
}

TEST(RouteCache, ASamePathIsConfirmedNotReplaced) {
    RouteCache<4> rc;
    const uint8_t path[] = {1, 2};
    rc.learn(A, path, plen(1, 2), 100, 0);
    EXPECT_EQ(ROUTE_CONFIRMED, rc.learn(A, path, plen(1, 2), 200, 4));
    EXPECT_EQ(1, rc.count());
    EXPECT_EQ(200u, rc.find(A)->heard);
    EXPECT_EQ(200u, rc.find(A)->path_seen);
}

TEST(RouteCache, AShorterPathReplacesALongerOne) {
    RouteCache<4> rc;
    const uint8_t longer[] = {1, 2, 3};
    const uint8_t shorter[] = {9};
    rc.learn(A, longer, plen(1, 3), 100, 0);
    EXPECT_EQ(ROUTE_REPLACED, rc.learn(A, shorter, plen(1, 1), 110, 0));
    EXPECT_EQ(1, rc.find(A)->hopCount());
    EXPECT_EQ(9, rc.find(A)->path[0]);
    EXPECT_EQ(0, rc.find(A)->path[1]);   // the old tail is cleared
}

TEST(RouteCache, ALongerPathDoesNotDisplaceAFreshBetterOne) {
    RouteCache<4> rc;
    const uint8_t shorter[] = {9};
    const uint8_t longer[] = {1, 2, 3};
    rc.learn(A, shorter, plen(1, 1), 100, 0);
    EXPECT_EQ(ROUTE_KEPT, rc.learn(A, longer, plen(1, 3), 200, 0));
    EXPECT_EQ(1, rc.find(A)->hopCount());
    EXPECT_EQ(200u, rc.find(A)->heard);        // but we did hear the node
    EXPECT_EQ(100u, rc.find(A)->path_seen);    // the path itself was not re-confirmed
}

TEST(RouteCache, AStalePathIsReplacedEvenByALongerOne) {
    RouteCache<4> rc;
    const uint8_t shorter[] = {9};
    const uint8_t longer[] = {1, 2, 3};
    rc.learn(A, shorter, plen(1, 1), 100, 0);
    uint32_t later = 100 + RouteCache<4>::STALE_SECS + 1;
    EXPECT_EQ(ROUTE_REPLACED, rc.learn(A, longer, plen(1, 3), later, 0));
    EXPECT_EQ(3, rc.find(A)->hopCount());
}

TEST(RouteCache, EvictsTheLeastRecentlyHeardWhenFull) {
    RouteCache<2> rc;
    uint8_t k1[ROUTE_KEY_SIZE] = {1}, k2[ROUTE_KEY_SIZE] = {2}, k3[ROUTE_KEY_SIZE] = {3};
    rc.learn(k1, NULL, plen(1, 0), 100, 0);
    rc.learn(k2, NULL, plen(1, 0), 200, 0);
    rc.learn(k1, NULL, plen(1, 0), 300, 0);   // k1 is now the most recent
    rc.learn(k3, NULL, plen(1, 0), 400, 0);   // evicts k2
    EXPECT_EQ(2, rc.count());
    EXPECT_NE(nullptr, rc.find(k1));
    EXPECT_EQ(NULL, rc.find(k2));
    EXPECT_NE(nullptr, rc.find(k3));
}

TEST(RouteCache, ReusesAFreedSlotBeforeEvictingAnything) {
    RouteCache<2> rc;
    uint8_t k1[ROUTE_KEY_SIZE] = {1}, k2[ROUTE_KEY_SIZE] = {2}, k3[ROUTE_KEY_SIZE] = {3};
    rc.learn(k1, NULL, plen(1, 0), 100, 0);
    rc.learn(k2, NULL, plen(1, 0), 200, 0);
    EXPECT_EQ(1, rc.expire(5000, 4850));      // k1 (4900 s old) expires, k2 (4800 s old) survives
    EXPECT_EQ(1, rc.count());
    rc.learn(k3, NULL, plen(1, 0), 5001, 0);
    EXPECT_EQ(2, rc.count());
    EXPECT_NE(nullptr, rc.find(k2));
    EXPECT_NE(nullptr, rc.find(k3));
}

TEST(RouteCache, ExpiresOnlyNodesPastTheMaximumAge) {
    RouteCache<4> rc;
    rc.learn(A, NULL, plen(1, 0), 100, 0);
    rc.learn(B, NULL, plen(1, 0), 900, 0);
    EXPECT_EQ(0, rc.expire(1000, 1000));   // nothing older than 1000 s
    EXPECT_EQ(1, rc.expire(1000, 500));    // A (900 s old) goes, B (100 s old) stays
    EXPECT_EQ(NULL, rc.find(A));
    EXPECT_NE(nullptr, rc.find(B));
}

TEST(RouteCache, AMalformedPathLengthIsTreatedAsDirectNotOverrun) {
    RouteCache<4> rc;
    uint8_t path[MAX_PATH_SIZE] = {0};
    // 3-byte hashes x 63 hops = 189 bytes, far more than the table can hold
    rc.learn(A, path, plen(3, 63), 100, 0);
    auto e = rc.find(A);
    ASSERT_NE(nullptr, e);
    EXPECT_EQ(0, e->hopCount());
}

TEST(RouteCache, ClearForgetsEverything) {
    RouteCache<4> rc;
    rc.learn(A, NULL, plen(1, 0), 100, 0);
    rc.clear();
    EXPECT_EQ(0, rc.count());
    EXPECT_EQ(NULL, rc.find(A));
}

int main(int argc, char** argv) {
    ::testing::InitGoogleTest(&argc, argv);
    return RUN_ALL_TESTS();
}
