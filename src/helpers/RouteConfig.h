#pragma once

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "RoutingCore.h"

namespace mesh {

/**
 * The runtime settings for routing, kept with the repeater's other saved settings. Parsing and range checks live here, apart from
 * the command line and the saved-settings file, so they can be tested on a PC.
 *
 *   route.enable      on | off              (default off: nothing is created, nothing is sent)
 *   route.id_bytes    2 | 3 | 4             (default 4; the whole network must agree)
 *   route.full_period 0 | 1800 .. 28800     seconds between whole-table adverts; 0 = lifetimes instead (default 3600)
 *   route.life        600 .. 32640          lifetimes mode: how long this repeater's own entry is believed (default 7200)
 *   route.refresh     10 .. 95              lifetimes mode: refresh when this percent of a lifetime is left (default 67)
 *   route.min_gap     10 .. 600             at most one advert per this many seconds (default 60)
 *   route.repeats     1 .. 3                times a change is sent unless a neighbour is heard passing it on (default 2)
 */
#define ROUTE_CFG_FULL_PERIOD_MIN   1800
#define ROUTE_CFG_FULL_PERIOD_MAX   28800

struct RouteConfigValues {
  uint8_t  enabled;
  uint8_t  id_bytes;
  uint16_t full_period_s;
  uint16_t life_s;
  uint8_t  refresh_pct;
  uint16_t min_gap_s;
  uint8_t  repeats;
  uint16_t boots;          // counts restarts; this repeater's own sequence number, so each start outranks the one before

  RouteConfigValues()
      : enabled(0), id_bytes(ROUTE_ID_BYTES_DEFAULT), full_period_s(3600), life_s(7200), refresh_pct(67), min_gap_s(60), repeats(2),
        boots(0) {}
};

// bring values read from a saved file (or anywhere) back inside their ranges
static inline void routeSanitize(RouteConfigValues& v) {
  if (v.enabled > 1) v.enabled = 0;
  if (v.id_bytes < 2 || v.id_bytes > 4) v.id_bytes = ROUTE_ID_BYTES_DEFAULT;
  if (v.full_period_s != 0) {
    if (v.full_period_s < ROUTE_CFG_FULL_PERIOD_MIN) v.full_period_s = ROUTE_CFG_FULL_PERIOD_MIN;
    if (v.full_period_s > ROUTE_CFG_FULL_PERIOD_MAX) v.full_period_s = ROUTE_CFG_FULL_PERIOD_MAX;
  }
  if (v.life_s < 600) v.life_s = 600;
  if (v.life_s > ROUTE_LIFE_UNIT_S * 255) v.life_s = ROUTE_LIFE_UNIT_S * 255;
  if (v.refresh_pct < 10 || v.refresh_pct > 95) v.refresh_pct = 67;
  if (v.min_gap_s < 10) v.min_gap_s = 10;
  if (v.min_gap_s > 600) v.min_gap_s = 600;
  if (v.repeats < 1 || v.repeats > 3) v.repeats = 2;
}

static inline RoutingConfig toRoutingConfig(const RouteConfigValues& v, int sf) {
  RoutingConfig c;
  c.id_bytes = v.id_bytes;
  c.sf = sf;
  c.full_period_s = v.full_period_s;
  c.life_s = v.life_s;
  c.refresh_pct = v.refresh_pct;
  c.min_gap_s = v.min_gap_s;
  c.repeats = v.repeats;
  return c;
}

// true if the text is "on" / "off"; sets *on
static inline bool routeParseOnOff(const char* s, bool* on) {
  if (strncmp(s, "on", 2) == 0 && (s[2] == 0 || s[2] == ' ')) { *on = true; return true; }
  if (strncmp(s, "off", 3) == 0 && (s[3] == 0 || s[3] == ' ')) { *on = false; return true; }
  return false;
}

// parses a whole number; false if there is anything else in the text
static inline bool routeParseInt(const char* s, long* out) {
  if (*s == 0) return false;
  char* end;
  long v = strtol(s, &end, 10);
  if (end == s || (*end != 0 && *end != ' ')) return false;
  *out = v;
  return true;
}

/**
 * \brief  Apply `route.<name> <value>`. `name` is what follows "route." and `value` what follows the space.
 * \returns  true if the setting changed (reply says "OK"); false with an explanation in reply otherwise
 */
static inline bool routeSet(RouteConfigValues& v, const char* name, const char* value, char* reply) {
  long n;
  bool on;
  if (strcmp(name, "enable") == 0) {
    if (!routeParseOnOff(value, &on)) { strcpy(reply, "Error, must be: on or off"); return false; }
    v.enabled = on;
  } else if (strcmp(name, "id_bytes") == 0) {
    if (!routeParseInt(value, &n) || n < 2 || n > 4) { strcpy(reply, "Error, must be 2, 3 or 4"); return false; }
    v.id_bytes = (uint8_t)n;
  } else if (strcmp(name, "full_period") == 0) {
    if (!routeParseInt(value, &n) || (n != 0 && (n < ROUTE_CFG_FULL_PERIOD_MIN || n > ROUTE_CFG_FULL_PERIOD_MAX))) {
      sprintf(reply, "Error, must be 0 (lifetimes) or %d-%d seconds", ROUTE_CFG_FULL_PERIOD_MIN, ROUTE_CFG_FULL_PERIOD_MAX);
      return false;
    }
    v.full_period_s = (uint16_t)n;
  } else if (strcmp(name, "life") == 0) {
    if (!routeParseInt(value, &n) || n < 600 || n > ROUTE_LIFE_UNIT_S * 255) {
      sprintf(reply, "Error, must be 600-%d seconds", ROUTE_LIFE_UNIT_S * 255);
      return false;
    }
    v.life_s = (uint16_t)n;
  } else if (strcmp(name, "refresh") == 0) {
    if (!routeParseInt(value, &n) || n < 10 || n > 95) { strcpy(reply, "Error, must be 10-95 (percent)"); return false; }
    v.refresh_pct = (uint8_t)n;
  } else if (strcmp(name, "min_gap") == 0) {
    if (!routeParseInt(value, &n) || n < 10 || n > 600) { strcpy(reply, "Error, must be 10-600 seconds"); return false; }
    v.min_gap_s = (uint16_t)n;
  } else if (strcmp(name, "repeats") == 0) {
    if (!routeParseInt(value, &n) || n < 1 || n > 3) { strcpy(reply, "Error, must be 1-3"); return false; }
    v.repeats = (uint8_t)n;
  } else {
    strcpy(reply, "Error, unknown route setting");
    return false;
  }
  strcpy(reply, "OK");
  return true;
}

// the reply to `get route.<name>`; name "" gives all settings on one line
static inline bool routeGet(const RouteConfigValues& v, const char* name, char* reply) {
  if (strcmp(name, "enable") == 0) sprintf(reply, "> %s", v.enabled ? "on" : "off");
  else if (strcmp(name, "id_bytes") == 0) sprintf(reply, "> %d", v.id_bytes);
  else if (strcmp(name, "full_period") == 0) sprintf(reply, "> %d", v.full_period_s);
  else if (strcmp(name, "life") == 0) sprintf(reply, "> %d", v.life_s);
  else if (strcmp(name, "refresh") == 0) sprintf(reply, "> %d", v.refresh_pct);
  else if (strcmp(name, "min_gap") == 0) sprintf(reply, "> %d", v.min_gap_s);
  else if (strcmp(name, "repeats") == 0) sprintf(reply, "> %d", v.repeats);
  else if (*name == 0)
    sprintf(reply, "> %s id_bytes=%d full_period=%d life=%d refresh=%d min_gap=%d repeats=%d", v.enabled ? "on" : "off", v.id_bytes,
            v.full_period_s, v.life_s, v.refresh_pct, v.min_gap_s, v.repeats);
  else return false;
  return true;
}

}  // namespace mesh
