#pragma once

#include <Arduino.h>
#include <helpers/IdentityStore.h> // FILESYSTEM

// Message history kept in flash so a client (the web page) can show earlier conversations after it reconnects.
// Two append-only files: when the current one is full it replaces the older one, so flash is written sequentially
// and the log always holds between one and two files' worth of the newest messages.
//
// A record is [len u8][kind u8][timestamp u32][snr i8][path_len u8][txt_type u8][target 6][text]
//   kind: 0 received from a contact, 1 received on a channel, 2 sent to a contact, 3 sent on a channel
//   target: contact public key prefix, or the channel index in the first byte
class MessageLog {
public:
  enum Kind : uint8_t { FROM_CONTACT = 0, FROM_CHANNEL = 1, TO_CONTACT = 2, TO_CHANNEL = 3 };
  static const int HEADER = 14;            // bytes of a record before the text, not counting len
  static const int MAX_TEXT = 150;
  static const uint32_t FILE_LIMIT = 24 * 1024;

  MessageLog() : _fs(NULL), _count_old(0), _count_cur(0), _cur_bytes(0) { }

  void begin(FILESYSTEM* fs) {
    _fs = fs;
    _count_old = scan(OLD_FILE, NULL, 0, 0, 0);
    _count_cur = scan(CUR_FILE, NULL, 0, 0, 0, &_cur_bytes);
  }

  uint16_t total() const { return _count_old + _count_cur; }

  void append(Kind kind, uint32_t timestamp, int8_t snr, uint8_t path_len, uint8_t txt_type,
              const uint8_t* target, const char* text) {
    if (!_fs) return;
    int tlen = strlen(text);
    if (tlen > MAX_TEXT) tlen = MAX_TEXT;
    uint8_t rec[1 + HEADER + MAX_TEXT];
    int n = 0;
    rec[n++] = HEADER + tlen;
    rec[n++] = kind;
    memcpy(&rec[n], &timestamp, 4); n += 4;
    rec[n++] = (uint8_t)snr;
    rec[n++] = path_len;
    rec[n++] = txt_type;
    memcpy(&rec[n], target, 6); n += 6;
    memcpy(&rec[n], text, tlen); n += tlen;

    if (_cur_bytes + n > FILE_LIMIT) rotate();
    File f = openAppend(CUR_FILE);
    if (!f) return;
    bool ok = f.write(rec, n) == (size_t)n;
    f.close();
    if (ok) { _cur_bytes += n; _count_cur++; }
  }

  // Copies whole records (each with its length byte) starting at record number `first`, oldest first, into dest.
  // Returns the bytes written; `count` gets the number of records.
  int read(uint16_t first, uint8_t* dest, int max, int& count) {
    count = 0;
    if (!_fs) return 0;
    int used = 0;
    if (first < _count_old) used = scan(OLD_FILE, dest, max, first, 0, NULL, &count);
    uint16_t next = first + count;
    if (next >= _count_old && next < total()) used += scan(CUR_FILE, dest + used, max - used, next - _count_old, 0, NULL, &count);
    return used;
  }

  void clear() {
    if (!_fs) return;
    _fs->remove(OLD_FILE); _fs->remove(CUR_FILE);
    _count_old = _count_cur = 0; _cur_bytes = 0;
  }

private:
  static constexpr const char* OLD_FILE = "/msglog.0";
  static constexpr const char* CUR_FILE = "/msglog.1";
  FILESYSTEM* _fs;
  uint16_t _count_old, _count_cur;
  uint32_t _cur_bytes;

  File openAppend(const char* name) {
#if defined(NRF52_PLATFORM) || defined(STM32_PLATFORM)
    return _fs->open(name, FILE_O_WRITE);
#elif defined(RP2040_PLATFORM)
    return _fs->open(name, "a");
#else
    return _fs->open(name, "a", true);
#endif
  }

  File openRead(const char* name) {
#if defined(NRF52_PLATFORM) || defined(STM32_PLATFORM)
    return _fs->open(name, FILE_O_READ);
#else
    return _fs->open(name, "r");
#endif
  }

  void rotate() {
    _fs->remove(OLD_FILE);
    // LittleFS/SPIFFS rename keeps the data; the new current file starts empty
    _fs->rename(CUR_FILE, OLD_FILE);
    _count_old = _count_cur; _count_cur = 0; _cur_bytes = 0;
  }

  // Counts the records in a file (dest NULL), or copies those from `skip` on into dest while they fit.
  int scan(const char* name, uint8_t* dest, int max, uint16_t skip, int, uint32_t* bytes = NULL, int* copied = NULL) {
    if (!_fs) return 0;
    File f = openRead(name);
    if (!f) { if (bytes) *bytes = 0; return 0; }
    int records = 0, used = 0;
    uint32_t pos = 0;
    while (true) {
      uint8_t len;
      if (f.read(&len, 1) != 1) break;
      if (len < HEADER || len > HEADER + MAX_TEXT) break; // damaged tail: ignore the rest
      if (dest == NULL) {
        f.seek(pos + 1 + len);
        pos += 1 + len; records++;
        continue;
      }
      if (records >= skip) {
        if (used + 1 + len > max) break;
        dest[used] = len;
        if (f.read(&dest[used + 1], len) != len) break;
        used += 1 + len;
        if (copied) (*copied)++;
      } else {
        f.seek(pos + 1 + len);
      }
      pos += 1 + len; records++;
    }
    f.close();
    if (bytes) *bytes = pos;
    return dest ? used : records;
  }
};
