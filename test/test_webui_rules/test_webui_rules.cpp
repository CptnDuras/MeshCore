#include <gtest/gtest.h>
#include "helpers/wifi/WebUiRules.h"

TEST(WebUiSameOrigin, ThePageOfThisNodeMatches) {
  EXPECT_TRUE(webUiSameOrigin("http://192.168.88.41", "192.168.88.41"));
  EXPECT_TRUE(webUiSameOrigin("http://node.local:8080", "node.local:8080"));
}

TEST(WebUiSameOrigin, HostNamesAreCaseInsensitive) {
  EXPECT_TRUE(webUiSameOrigin("http://Node.Local", "node.local"));
}

TEST(WebUiSameOrigin, AnotherSiteIsRefused) {
  EXPECT_FALSE(webUiSameOrigin("http://evil.example", "192.168.88.41"));
  EXPECT_FALSE(webUiSameOrigin("https://192.168.88.41.evil.example", "192.168.88.41"));
}

TEST(WebUiSameOrigin, ADifferentPortIsADifferentOrigin) {
  EXPECT_FALSE(webUiSameOrigin("http://node.local:8081", "node.local:8080"));
  EXPECT_FALSE(webUiSameOrigin("http://node.local", "node.local:8080"));
}

TEST(WebUiSameOrigin, ASchemeIsNotRequired) {
  EXPECT_TRUE(webUiSameOrigin("node.local", "node.local"));
}

TEST(WebUiSetupValid, TheLimits) {
  EXPECT_TRUE(webUiSetupValid(1, 0, 8, 1));
  EXPECT_TRUE(webUiSetupValid(32, 63, 32, 1));
  EXPECT_FALSE(webUiSetupValid(33, 0, 8, 1));
  EXPECT_FALSE(webUiSetupValid(1, 64, 8, 1));
  EXPECT_FALSE(webUiSetupValid(1, 0, 7, 1));
  EXPECT_FALSE(webUiSetupValid(1, 0, 33, 1));
}

TEST(WebUiSetupValid, AnEmptyWiFiNameIsOnlyAllowedWhenTheBoardCanBeItsOwnWiFi) {
  EXPECT_FALSE(webUiSetupValid(0, 0, 8, 1));
  EXPECT_TRUE(webUiSetupValid(0, 0, 8, 0));
}

TEST(WebUiApPasswordValid, EightToThirtyTwoCharacters) {
  EXPECT_TRUE(webUiApPasswordValid("meshnode"));
  EXPECT_TRUE(webUiApPasswordValid("12345678901234567890123456789012"));
  EXPECT_FALSE(webUiApPasswordValid("short"));
  EXPECT_FALSE(webUiApPasswordValid("123456789012345678901234567890123"));
  EXPECT_FALSE(webUiApPasswordValid(""));
  EXPECT_FALSE(webUiApPasswordValid(nullptr));
}

int main(int argc, char** argv) {
  ::testing::InitGoogleTest(&argc, argv);
  return RUN_ALL_TESTS();
}
