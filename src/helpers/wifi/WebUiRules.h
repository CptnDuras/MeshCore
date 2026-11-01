#pragma once

#include <string.h>
#include <strings.h>

// The web UI's decisions that need no network or board, kept apart so they can be tested off the board.

// Host part of an Origin header ("http://node.local:8080") compared to the Host header ("node.local:8080").
// A page served by this node always sends matching values; a page from another site does not.
inline bool webUiSameOrigin(const char* origin, const char* host) {
  const char* p = strstr(origin, "://");
  p = p ? p + 3 : origin;
  return strcasecmp(p, host) == 0;
}

// The first-boot form's lengths: WiFi name ssidMin..32, WiFi password up to 63, web password 8..32.
inline bool webUiSetupValid(size_t ssidLen, size_t wifiPwdLen, size_t webPwdLen, size_t ssidMin) {
  return ssidLen >= ssidMin && ssidLen <= 32 && wifiPwdLen <= 63 && webPwdLen >= 8 && webPwdLen <= 32;
}

// WPA2 needs 8 to 32 characters (as this node takes them) for the access point's key.
inline bool webUiApPasswordValid(const char* password) {
  size_t n = password ? strlen(password) : 0;
  return n >= 8 && n <= 32;
}
