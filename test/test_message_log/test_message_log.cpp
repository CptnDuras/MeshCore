#include <gtest/gtest.h>
#include <string>
#include <vector>
#include "FakeFS.h"

#define MESSAGE_LOG_HOST_TEST
#define FILESYSTEM FakeFS
#include "MessageLog.h"

static const uint8_t TARGET[6] = { 0, 1, 2, 3, 4, 5 };

static std::string text(int n) { return "message number " + std::to_string(n); }

static void add(MessageLog& log, int n) {
  std::string t = text(n);
  log.append(MessageLog::FROM_CHANNEL, 1000 + n, 0, 1, 0, TARGET, t.c_str());
}

// the numbers of all the messages the log holds, oldest first, read in frames of the size the node uses
static std::vector<int> held(MessageLog& log, int frame = 172) {
  std::vector<int> out;
  uint16_t first = 0;
  while (first < log.total()) {
    uint8_t buf[512];
    int count;
    int used = log.read(first, buf, frame, count);
    if (!count) break;
    int p = 0;
    for (int i = 0; i < count; i++) {
      int len = buf[p];
      std::string t((const char*)&buf[p + 1 + MessageLog::HEADER], len - MessageLog::HEADER);
      out.push_back(std::stoi(t.substr(strlen("message number "))));
      p += 1 + len;
    }
    EXPECT_EQ(used, p);
    first += count;
  }
  return out;
}

// a record as an earlier version wrote it
static void legacy(FakeFS& fs, const char* name, int from, int to, bool append = false) {
  auto f = fs.open(name, append ? "a" : "w", true);
  for (int n = from; n < to; n++) {
    std::string t = text(n);
    std::vector<uint8_t> r;
    r.push_back(MessageLog::HEADER + t.size());
    r.push_back(1);
    uint32_t ts = 1000 + n; r.insert(r.end(), (uint8_t*)&ts, (uint8_t*)&ts + 4);
    r.push_back(0); r.push_back(1); r.push_back(0);
    r.insert(r.end(), TARGET, TARGET + 6);
    r.insert(r.end(), t.begin(), t.end());
    f.write(r.data(), r.size());
  }
}

static std::vector<int> range(int from, int to) {
  std::vector<int> v;
  for (int n = from; n < to; n++) v.push_back(n);
  return v;
}

TEST(MessageLog, HoldsWhatWasAppendedInOrder) {
  FakeFS fs; MessageLog log; log.begin(&fs);
  for (int n = 0; n < 40; n++) add(log, n);
  EXPECT_EQ(40, log.total());
  EXPECT_EQ(range(0, 40), held(log));
}

TEST(MessageLog, ARecordIsReadFromAnyStartingPoint) {
  FakeFS fs; MessageLog log; log.begin(&fs);
  for (int n = 0; n < 100; n++) add(log, n);
  for (uint16_t first = 0; first < 100; first++) {
    uint8_t buf[200]; int count;
    ASSERT_GT(log.read(first, buf, sizeof(buf), count), 0) << first;
    std::string t((const char*)&buf[1 + MessageLog::HEADER], buf[0] - MessageLog::HEADER);
    EXPECT_EQ(text(first), t) << first;
  }
  uint8_t buf[200]; int count;
  EXPECT_EQ(0, log.read(100, buf, sizeof(buf), count));
  EXPECT_EQ(0, count);
}

TEST(MessageLog, TheOldestAreDroppedWhenItIsFullAndThereIsOnlyOneFile) {
  FakeFS fs; MessageLog log(3000, 2000); log.begin(&fs);
  for (int n = 0; n < 400; n++) {
    add(log, n);
    ASSERT_LE(fs.files["/msglog"]->size(), 3000u) << n;
  }
  std::vector<int> h = held(log);
  ASSERT_FALSE(h.empty());
  EXPECT_EQ(399, h.back());
  EXPECT_EQ(range(h.front(), 400), h) << "what is kept is the newest, without gaps";
  EXPECT_GT(h.size(), 40u) << "at least the keep size's worth stays";
  EXPECT_EQ(1u, fs.files.size()) << "no second or temporary file is left behind";
}

TEST(MessageLog, ASmallFrameStillGetsEveryRecord) {
  FakeFS fs; MessageLog log; log.begin(&fs);
  for (int n = 0; n < 60; n++) add(log, n);
  EXPECT_EQ(range(0, 60), held(log, 70));
}

TEST(MessageLog, SurvivesAReopen) {
  FakeFS fs;
  { MessageLog log(3000, 2000); log.begin(&fs); for (int n = 0; n < 150; n++) add(log, n); }
  MessageLog again(3000, 2000); again.begin(&fs);
  std::vector<int> h = held(again);
  EXPECT_EQ(149, h.back());
  add(again, 150);
  EXPECT_EQ(150, held(again).back());
}

TEST(MessageLog, ADamagedEndIsCutOffBeforeTheNextMessage) {
  FakeFS fs;
  { MessageLog log; log.begin(&fs); for (int n = 0; n < 20; n++) add(log, n); }
  uint8_t junk[] = { 3, 9, 9 };                 // a length shorter than any record
  fs.open("/msglog", "a", true).write(junk, sizeof(junk));
  MessageLog log; log.begin(&fs);
  EXPECT_EQ(20, log.total());
  add(log, 20);
  EXPECT_EQ(range(0, 21), held(log)) << "the new message is readable, not stranded behind the damage";
}

TEST(MessageLog, AWriteThatFallsShortIsRepairedBeforeTheNextOne) {
  FakeFS fs; MessageLog log; log.begin(&fs);
  for (int n = 0; n < 10; n++) add(log, n);
  fs.write_budget = 7;                           // the flash takes part of the next record only
  add(log, 10);
  fs.write_budget = -1;
  EXPECT_EQ(10, log.total());
  add(log, 11);
  std::vector<int> h = held(log);
  EXPECT_EQ(range(0, 10), std::vector<int>(h.begin(), h.begin() + 10));
  EXPECT_EQ(11, h.back());
}

TEST(MessageLog, ARewriteThatCannotFinishLeavesTheFileAsItWas) {
  FakeFS fs; MessageLog log(3000, 2000); log.begin(&fs);
  for (int n = 0; n < 40; n++) add(log, n);
  size_t before = fs.files["/msglog"]->size();
  fs.write_budget = 100;                         // not enough room for the copy the rewrite needs
  for (int n = 40; n < 120; n++) add(log, n);
  fs.write_budget = -1;
  EXPECT_FALSE(fs.exists("/msglog.tmp"));
  EXPECT_GE(fs.files["/msglog"]->size(), before);
  add(log, 120);
  EXPECT_EQ(120, held(log).back());
}

TEST(MessageLog, TakesOverTheTwoFilesOfAnEarlierVersion) {
  FakeFS fs;
  legacy(fs, "/msglog.0", 0, 30);
  legacy(fs, "/msglog.1", 30, 45);
  MessageLog log; log.begin(&fs);
  EXPECT_EQ(range(0, 45), held(log));
  EXPECT_FALSE(fs.exists("/msglog.0"));
  EXPECT_FALSE(fs.exists("/msglog.1"));
  EXPECT_FALSE(fs.exists("/msglog.tmp"));
  add(log, 45);
  EXPECT_EQ(range(0, 46), held(log));
}

TEST(MessageLog, AnEarlierVersionsDamagedTailIsNotCarriedOver) {
  FakeFS fs;
  legacy(fs, "/msglog.0", 0, 10);
  uint8_t junk[] = { 200, 1, 2 };
  fs.open("/msglog.0", "a", true).write(junk, sizeof(junk));
  legacy(fs, "/msglog.1", 10, 15);
  MessageLog log; log.begin(&fs);
  EXPECT_EQ(range(0, 15), held(log));
}

TEST(MessageLog, ACopyThatWasInterruptedIsStartedAgain) {
  FakeFS fs;
  legacy(fs, "/msglog.0", 0, 12);
  legacy(fs, "/msglog.tmp", 0, 3);               // half of a copy
  MessageLog log; log.begin(&fs);
  EXPECT_EQ(range(0, 12), held(log));
}

TEST(MessageLog, FinishesARewriteThatWasCutShort) {
  FakeFS fs;
  legacy(fs, "/msglog.tmp", 5, 20);              // the new file was complete, the old one already removed
  MessageLog log; log.begin(&fs);
  EXPECT_EQ(range(5, 20), held(log));
  EXPECT_FALSE(fs.exists("/msglog.tmp"));

  FakeFS fs2;
  legacy(fs2, "/msglog", 0, 20);
  legacy(fs2, "/msglog.tmp", 5, 8);              // the copy had not finished: the old file is whole
  MessageLog log2; log2.begin(&fs2);
  EXPECT_EQ(range(0, 20), held(log2));
  EXPECT_FALSE(fs2.exists("/msglog.tmp"));
}

TEST(MessageLog, ClearEmptiesIt) {
  FakeFS fs; MessageLog log; log.begin(&fs);
  for (int n = 0; n < 5; n++) add(log, n);
  log.clear();
  EXPECT_EQ(0, log.total());
  add(log, 5);
  EXPECT_EQ(std::vector<int>{5}, held(log));
}

TEST(MessageLog, AMessageAddedBetweenTwoReadsIsSeenByTheSecond) {
  FakeFS fs; MessageLog log; log.begin(&fs);
  for (int n = 0; n < 10; n++) add(log, n);
  uint8_t buf[200]; int count;
  ASSERT_GT(log.read(0, buf, sizeof(buf), count), 0);
  ASSERT_LT(count, 10) << "the first read must not have taken everything";
  add(log, 10);
  EXPECT_EQ(range(0, 11), held(log)) << "a read that was under way before the append still ends with the new message";
  uint8_t last[200];
  ASSERT_GT(log.read(10, last, sizeof(last), count), 0);
  EXPECT_EQ(1, count);
}

TEST(MessageLog, ReadingBackAndForthGivesTheRightRecordEachTime) {
  FakeFS fs; MessageLog log; log.begin(&fs);
  for (int n = 0; n < 80; n++) add(log, n);
  const int order[] = { 70, 71, 5, 6, 7, 78, 0, 79, 40, 41, 40 };
  for (int first : order) {
    uint8_t buf[200]; int count;
    ASSERT_GT(log.read(first, buf, sizeof(buf), count), 0) << first;
    std::string t((const char*)&buf[1 + MessageLog::HEADER], buf[0] - MessageLog::HEADER);
    EXPECT_EQ(text(first), t) << first;
  }
}

int main(int argc, char** argv) {
  ::testing::InitGoogleTest(&argc, argv);
  return RUN_ALL_TESTS();
}
