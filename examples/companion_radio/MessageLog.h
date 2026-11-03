#pragma once

#include <Arduino.h>
#ifndef MESSAGE_LOG_HOST_TEST      // the host test supplies its own file system
#include <helpers/IdentityStore.h> // FILESYSTEM
#endif

// Message history kept in flash so a client (the web page) can show earlier conversations after it reconnects.
// One append-only file. When a record would take it past FILE_LIMIT, the oldest records are dropped: the file is rewritten without them (through a
// temporary file, so a power cut leaves the old file or the new one, never half of each) and holds between KEEP and FILE_LIMIT bytes of the newest.
//
// A record is [len u8][kind u8][timestamp u32][snr i8][path_len u8][txt_type u8][target 6][text]
//   kind: 0 received from a contact, 1 received on a channel, 2 sent to a contact, 3 sent on a channel
//   target: contact public key prefix, or the channel index in the first byte
class MessageLog {
public:
  enum Kind : uint8_t { FROM_CONTACT = 0, FROM_CHANNEL = 1, TO_CONTACT = 2, TO_CHANNEL = 3 };
  static const int HEADER = 14;            // bytes of a record before the text, not counting len
  static const int MAX_TEXT = 150;
  static const uint32_t FILE_LIMIT = 80UL * 1024;
  static const uint32_t KEEP = 60UL * 1024;

  // `limit` and `keep` are the sizes above; a smaller pair lets a test fill the file quickly.
  MessageLog(uint32_t limit = FILE_LIMIT, uint32_t keep = KEEP)
    : _fs(NULL), _limit(limit < FILE_LIMIT ? limit : FILE_LIMIT), _keep(keep < limit ? keep : limit / 2), _count(0), _bytes(0), _repair(false) { }

  void begin(FILESYSTEM* fs) {
    _fs = fs;
    closeCursor();
    recover();
    scan();
  }

  uint16_t total() const { return _count; }

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

    closeCursor();
    if (_repair && !rewrite(0, _bytes)) return;            // a write that failed left a damaged tail: cut it off before adding anything
    if (_bytes + n > _limit) compact();
    File f = openAppend(MAIN_FILE);
    if (!f) return;
    bool ok = f.write(rec, n) == (size_t)n;
    f.close();
    if (ok) {
      if (_count % STRIDE == 0 && _count / STRIDE < MAX_INDEX) _index[_count / STRIDE] = _bytes;
      _bytes += n; _count++;
    } else {
      _repair = true;
    }
  }

  // Copies whole records (each with its length byte) starting at record number `first`, oldest first, into dest.
  // Returns the bytes written; `count` gets the number of records.
  // A seek far into a file is slow on flash, and the page reads the log in a run of calls, each starting where the last one ended: the file is
  // kept open at that place, so a run costs one seek.
  int read(uint16_t first, uint8_t* dest, int max, int& count) {
    count = 0;
    if (!_fs || first >= _count) return 0;
    if (!_cursor_open || _cursor_rec != first) {
      if (!openCursor(first)) return 0;
    }
    int used = 0;
    while (_cursor_rec < _count) {
      if (_cursor_len == 0) {
        uint8_t len;
        if (_cursor.read(&len, 1) != 1 || len < HEADER || len > HEADER + MAX_TEXT) { closeCursor(); break; }
        _cursor_len = len;
      }
      if (used + 1 + _cursor_len > max) break;               // the cursor stays on this record for the next call
      dest[used] = _cursor_len;
      if (_cursor.read(&dest[used + 1], _cursor_len) != _cursor_len) { closeCursor(); break; }
      used += 1 + _cursor_len; count++;
      _cursor_len = 0; _cursor_rec++;
    }
    return used;
  }

  void clear() {
    if (!_fs) return;
    closeCursor();
    _fs->remove(MAIN_FILE); _fs->remove(TEMP_FILE);
    _count = 0; _bytes = 0; _repair = false;
  }

private:
  static constexpr const char* MAIN_FILE = "/msglog";
  static constexpr const char* TEMP_FILE = "/msglog.tmp";
  static constexpr const char* LEGACY_0 = "/msglog.0";   // the two files an earlier version kept: oldest, then newest
  static constexpr const char* LEGACY_1 = "/msglog.1";
  static const uint16_t STRIDE = 16;                       // the index remembers where every 16th record starts
  static const uint16_t MAX_INDEX = FILE_LIMIT / (HEADER + 1) / STRIDE + 2;
  FILESYSTEM* _fs;
  uint32_t _limit, _keep;
  uint16_t _count;
  uint32_t _bytes;                                         // the readable records, which may stop short of the end of a damaged file
  bool _repair;
  uint32_t _index[MAX_INDEX];
  File _cursor;                                            // the file open for reading, at the start of record _cursor_rec
  bool _cursor_open = false;
  uint16_t _cursor_rec = 0;
  uint8_t _cursor_len = 0;                                 // its length byte, if already read

  void closeCursor() {
    if (_cursor_open) _cursor.close();
    _cursor_open = false; _cursor_len = 0;
  }

  // Opens the file at record `first`: seeks to the nearest start the index knows, then reads past the records before it.
  bool openCursor(uint16_t first) {
    closeCursor();
    _cursor = openRead(MAIN_FILE);
    if (!_cursor) return false;
    uint16_t rec = (first / STRIDE) * STRIDE;
    if (!_cursor.seek(_index[first / STRIDE])) { _cursor.close(); return false; }
    uint8_t skip[HEADER + MAX_TEXT];
    while (rec < first) {
      uint8_t len;
      if (_cursor.read(&len, 1) != 1 || len < HEADER || len > HEADER + MAX_TEXT || _cursor.read(skip, len) != len) { _cursor.close(); return false; }
      rec++;
    }
    _cursor_open = true; _cursor_rec = first; _cursor_len = 0;
    return true;
  }

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

  File openNew(const char* name) {
#if defined(NRF52_PLATFORM) || defined(STM32_PLATFORM)
    _fs->remove(name);
    return _fs->open(name, FILE_O_WRITE);
#elif defined(RP2040_PLATFORM)
    return _fs->open(name, "w");
#else
    return _fs->open(name, "w", true);
#endif
  }

  // Finishes what a power cut interrupted, and takes over the two files an earlier version kept.
  void recover() {
    if (_fs->exists(LEGACY_0) || _fs->exists(LEGACY_1)) {
      _fs->remove(TEMP_FILE);                              // a copy that did not finish: start it again
      if (!_fs->exists(MAIN_FILE)) {
        File out = openNew(TEMP_FILE);
        bool ok = (bool)out;
        const char* old[2] = { LEGACY_0, LEGACY_1 };
        for (int i = 0; ok && i < 2; i++) {
          uint32_t end = validLength(old[i]);
          ok = copyRange(out, old[i], 0, end);
        }
        if (out) out.close();
        if (!ok) { _fs->remove(TEMP_FILE); return; }       // leave the old files for the next start
        _fs->rename(TEMP_FILE, MAIN_FILE);
      }
      _fs->remove(LEGACY_0); _fs->remove(LEGACY_1);
    } else if (_fs->exists(TEMP_FILE)) {
      if (_fs->exists(MAIN_FILE)) _fs->remove(TEMP_FILE);  // the rewrite did not finish: the file is still whole
      else _fs->rename(TEMP_FILE, MAIN_FILE);              // it finished but was not put in place
    }
  }

  // The length of the readable records at the start of a file: a damaged record ends them.
  uint32_t validLength(const char* name) {
    File f = openRead(name);
    if (!f) return 0;
    uint32_t pos = 0;
    while (true) {
      uint8_t len;
      if (f.read(&len, 1) != 1 || len < HEADER || len > HEADER + MAX_TEXT) break;
      if (!f.seek(pos + 1 + len)) break;
      pos += 1 + len;
    }
    f.close();
    return pos;
  }

  bool copyRange(File& out, const char* name, uint32_t from, uint32_t to) {
    File in = openRead(name);
    if (!in) return from >= to;
    bool ok = in.seek(from);
    uint8_t buf[128];
    while (ok && from < to) {
      size_t n = to - from < sizeof(buf) ? to - from : sizeof(buf);
      ok = in.read(buf, n) == n && out.write(buf, n) == n;
      from += n;
    }
    in.close();
    return ok;
  }

  // Counts the records, remembers where every STRIDE-th starts, and notes whether the file has a damaged end.
  void scan() {
    _count = 0; _bytes = 0; _repair = false;
    File f = openRead(MAIN_FILE);
    if (!f) return;
    uint32_t size = f.size(), pos = 0;
    while (true) {
      uint8_t len;
      if (f.read(&len, 1) != 1 || len < HEADER || len > HEADER + MAX_TEXT) break;
      if (_count % STRIDE == 0 && _count / STRIDE < MAX_INDEX) _index[_count / STRIDE] = pos;
      if (!f.seek(pos + 1 + len)) break;
      pos += 1 + len; _count++;
    }
    f.close();
    _bytes = pos;
    _repair = size > pos;
  }

  // Keeps the file from `from` to `to`. False if that could not be done, and then the file is as it was.
  bool rewrite(uint32_t from, uint32_t to) {
    File out = openNew(TEMP_FILE);
    if (!out) return false;
    bool ok = copyRange(out, MAIN_FILE, from, to);
    out.close();
    if (!ok) { _fs->remove(TEMP_FILE); return false; }
    _fs->remove(MAIN_FILE);
    _fs->rename(TEMP_FILE, MAIN_FILE);
    scan();
    return true;
  }

  // Drops the oldest records: the cut falls at the first remembered record start that leaves at most `keep` bytes.
  void compact() {
    if (_bytes <= _keep) return;
    uint32_t cut = 0;
    for (uint16_t i = 0; i * STRIDE < _count && i < MAX_INDEX; i++) {
      cut = _index[i];
      if (_bytes - cut <= _keep) break;
    }
    if (cut > 0) rewrite(cut, _bytes);
  }
};
