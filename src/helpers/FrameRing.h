#pragma once

#include <stdint.h>
#include <string.h>
#include <new>

// A fixed-capacity ring of byte frames (each at most MAX_LEN bytes). The storage is allocated by alloc(), not held in the object, so
// an owner that is never started holds none of it and, where malloc prefers PSRAM, it lives outside the internal heap.
// COUNT must be a power of two: an index wraps with a mask. Not thread-safe; the owner locks around it if it needs to.
template <int COUNT, int MAX_LEN>
class FrameRing {
  static_assert(COUNT > 0 && (COUNT & (COUNT - 1)) == 0, "COUNT must be a power of two");
  struct Frame {
    uint8_t len;
    uint8_t buf[MAX_LEN];
  };
  Frame* _frames = nullptr;
  int _head = 0, _len = 0;

public:
  ~FrameRing() { delete[] _frames; }

  bool alloc() {
    if (!_frames) _frames = new (std::nothrow) Frame[COUNT];
    return _frames != nullptr;
  }
  bool allocated() const { return _frames != nullptr; }

  int size() const { return _len; }
  bool full() const { return _len >= COUNT; }
  bool empty() const { return _len == 0; }
  void clear() { _head = _len = 0; }

  // false when it is full, empty or too long, or alloc() has not succeeded
  bool push(const uint8_t* src, size_t len) {
    if (!_frames || _len >= COUNT || len == 0 || len > MAX_LEN) return false;
    Frame& f = _frames[(_head + _len) & (COUNT - 1)];
    f.len = (uint8_t)len;
    memcpy(f.buf, src, len);
    _len++;
    return true;
  }
  // the oldest frame, or null when empty; valid until pop()
  const uint8_t* front(size_t& len) const {
    if (_len == 0) return nullptr;
    len = _frames[_head].len;
    return _frames[_head].buf;
  }
  void pop() {
    if (_len == 0) return;
    _head = (_head + 1) & (COUNT - 1);
    _len--;
  }
  // copies the oldest frame out and removes it; returns its length, 0 when empty
  size_t take(uint8_t* dest) {
    size_t n = 0;
    const uint8_t* p = front(n);
    if (!p) return 0;
    memcpy(dest, p, n);
    pop();
    return n;
  }
};
