#pragma once

#include <cstdint>
#include <cstring>
#include <map>
#include <memory>
#include <string>
#include <vector>

// A file system in memory with the few calls MessageLog uses, and a way to make a write fall short (a full or failing flash).

class File {
public:
  File() { }
  File(std::shared_ptr<std::vector<uint8_t>> d, bool append, int64_t* budget) : _d(d), _append(append), _budget(budget) { if (append) _pos = d->size(); }
  explicit operator bool() const { return (bool)_d; }
  size_t size() const { return _d ? _d->size() : 0; }
  bool seek(uint32_t pos) { if (!_d || pos > _d->size()) return false; _pos = pos; return true; }
  size_t read(uint8_t* dest, size_t n) {
    if (!_d || _pos >= _d->size()) return 0;
    if (n > _d->size() - _pos) n = _d->size() - _pos;
    memcpy(dest, _d->data() + _pos, n); _pos += n;
    return n;
  }
  size_t write(const uint8_t* src, size_t n) {
    if (!_d) return 0;
    if (_budget && *_budget >= 0) { if ((int64_t)n > *_budget) n = (size_t)*_budget; *_budget -= n; }
    if (_append) _pos = _d->size();
    if (_pos + n > _d->size()) _d->resize(_pos + n);
    memcpy(_d->data() + _pos, src, n); _pos += n;
    return n;
  }
  void close() { }
private:
  std::shared_ptr<std::vector<uint8_t>> _d;
  size_t _pos = 0;
  bool _append = false;
  int64_t* _budget = nullptr;
};

class FakeFS {
public:
  std::map<std::string, std::shared_ptr<std::vector<uint8_t>>> files;
  int64_t write_budget = -1;                  // bytes that may still be written; below zero means no limit

  File open(const char* name, const char* mode, bool create = false) {
    auto it = files.find(name);
    if (mode[0] == 'r') return it == files.end() ? File() : File(it->second, false, &write_budget);
    if (mode[0] == 'w' || it == files.end()) {
      if (mode[0] != 'w' && !create) return File();
      files[name] = std::make_shared<std::vector<uint8_t>>();
      it = files.find(name);
    }
    return File(it->second, mode[0] == 'a', &write_budget);
  }
  bool exists(const char* name) { return files.count(name) > 0; }
  bool remove(const char* name) { return files.erase(name) > 0; }
  bool rename(const char* from, const char* to) {
    auto it = files.find(from);
    if (it == files.end()) return false;
    files[to] = it->second; files.erase(from);
    return true;
  }
};
