#pragma once

#include <stdint.h>
#include <string.h>

namespace mesh {

/*
 * PING: ask who is in radio range right now, and get a few facts back from each node that answers.
 *
 * Both packets are zero-hop CONTROL data: the upper 4 bits of the first byte are the sub-type, and sub-types with the
 * top bit set are delivered to the neighbours that hear them and never forwarded by anyone (that is how DISCOVER_REQ and
 * DISCOVER_RESP, 0x80 and 0x90, already work). A ping therefore reaches only what the sender can hear directly, and each
 * answer goes straight back the same way. Nothing is routed or repeated.
 *
 *   PING_REQ   0xA0 | reserved(4)
 *              type_filter (1)   bit n set = nodes of ADV_TYPE n should answer (0xFF = everyone)
 *              tag (4)           random, copied into every answer
 *              probability (1)   0..255: chance (x/255) that a node answers; 255 = always, 0 = never
 *              window_s (1)      answers are spread over this many seconds (0 = the default)
 *
 *   PING_RESP  0xB0 | node_type(4)
 *              snr (1)           signed, SNR*4 at which the answering node heard the request
 *              tag (4)
 *              fw_ver (1)        firmware version code of the answerer (0 if unknown)
 *              pubkey_prefix (8)
 *              name_len (1), name (name_len bytes, at most PING_MAX_NAME)
 *
 * In a crowded place many nodes may answer at once, so answers are delayed by a random amount within the window, the
 * request can ask for only some nodes to answer (probability) or only some kinds (type_filter), each node rate-limits how
 * often it answers, and ordinary clients answer only if their owner has made them visible.
 */

#define CTL_TYPE_PING_REQ    0xA0
#define CTL_TYPE_PING_RESP   0xB0
#define CTL_SUBTYPE_MASK     0xF0

#define PING_MAX_NAME        16
#define PING_REQ_LEN         8
#define PING_RESP_MIN_LEN    (1 + 1 + 4 + 1 + 8 + 1)
#define PING_DEFAULT_WINDOW_S  3
#define PING_MAX_WINDOW_S      60

struct PingRequest {
  uint8_t  type_filter;
  uint32_t tag;
  uint8_t  probability;
  uint8_t  window_s;
};

struct PingResponse {
  uint8_t  node_type;
  int8_t   snr_x4;
  uint32_t tag;
  uint8_t  fw_ver;
  uint8_t  pubkey_prefix[8];
  char     name[PING_MAX_NAME + 1];   // always null-terminated
};

inline bool pingIsRequest(const uint8_t* payload, size_t len) {
  return len >= 1 && (payload[0] & CTL_SUBTYPE_MASK) == CTL_TYPE_PING_REQ;
}

inline bool pingIsResponse(const uint8_t* payload, size_t len) {
  return len >= 1 && (payload[0] & CTL_SUBTYPE_MASK) == CTL_TYPE_PING_RESP;
}

inline size_t pingEncodeRequest(const PingRequest& r, uint8_t* out) {
  out[0] = CTL_TYPE_PING_REQ;
  out[1] = r.type_filter;
  memcpy(&out[2], &r.tag, 4);
  out[6] = r.probability;
  out[7] = r.window_s;
  return PING_REQ_LEN;
}

inline bool pingDecodeRequest(const uint8_t* p, size_t len, PingRequest& r) {
  if (len < PING_REQ_LEN || !pingIsRequest(p, len)) return false;
  r.type_filter = p[1];
  memcpy(&r.tag, &p[2], 4);
  r.probability = p[6];
  r.window_s = p[7];
  return true;
}

inline size_t pingEncodeResponse(const PingResponse& r, uint8_t* out) {
  size_t i = 0;
  out[i++] = CTL_TYPE_PING_RESP | (r.node_type & 0x0F);
  out[i++] = (uint8_t)r.snr_x4;
  memcpy(&out[i], &r.tag, 4); i += 4;
  out[i++] = r.fw_ver;
  memcpy(&out[i], r.pubkey_prefix, 8); i += 8;
  size_t n = strnlen(r.name, PING_MAX_NAME);
  out[i++] = (uint8_t)n;
  memcpy(&out[i], r.name, n); i += n;
  return i;
}

inline bool pingDecodeResponse(const uint8_t* p, size_t len, PingResponse& r) {
  if (len < PING_RESP_MIN_LEN || !pingIsResponse(p, len)) return false;
  size_t i = 0;
  r.node_type = p[i++] & 0x0F;
  r.snr_x4 = (int8_t)p[i++];
  memcpy(&r.tag, &p[i], 4); i += 4;
  r.fw_ver = p[i++];
  memcpy(r.pubkey_prefix, &p[i], 8); i += 8;
  size_t n = p[i++];
  if (n > PING_MAX_NAME || i + n > len) return false;   // never trust a length from the air
  memcpy(r.name, &p[i], n);
  r.name[n] = 0;
  return true;
}

/** Should a node of `my_node_type` answer, given a random byte? */
inline bool pingShouldRespond(const PingRequest& r, uint8_t my_node_type, uint8_t random_byte) {
  if (my_node_type > 7 || (r.type_filter & (1 << my_node_type)) == 0) return false;
  if (r.probability == 0) return false;
  if (r.probability == 255) return true;
  return random_byte < r.probability;
}

/**
 * How long to wait before answering, in milliseconds: never straight away (the pinger is still finishing its own
 * transmission), and spread over the requested window so a crowd does not all answer at once.
 */
inline uint32_t pingResponseDelayMs(const PingRequest& r, uint32_t random_value) {
  uint32_t window_s = r.window_s == 0 ? PING_DEFAULT_WINDOW_S : r.window_s;
  if (window_s > PING_MAX_WINDOW_S) window_s = PING_MAX_WINDOW_S;
  return 300 + (random_value % (window_s * 1000));
}

/** A node answers at most `max` pings per `window_secs` seconds, so repeated pings cannot make it chatter. */
class PingRateLimiter {
  uint32_t window_start;
  uint8_t  count;
  uint8_t  max_count;
  uint32_t window_secs;
public:
  PingRateLimiter(uint8_t max = 4, uint32_t window = 120) : window_start(0), count(0), max_count(max), window_secs(window) { }

  bool allow(uint32_t now_secs) {
    if (count == 0 || now_secs - window_start >= window_secs) {   // a new window
      window_start = now_secs;
      count = 0;
    }
    if (count >= max_count) return false;
    count++;
    return true;
  }
};

}
