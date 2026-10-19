#if defined(ESP_PLATFORM) && defined(WITH_WEBUI)

#include "WebUiInterface.h"
#include "WebUiPage.h"
#include <WiFi.h>
#include <ESPAsyncWebServer.h>
#include <string.h>

// Host part of an Origin header ("http://node.local:8080") compared to the Host header
// ("node.local:8080"). A page served by this node always sends matching values.
bool WebUiInterface::sameOrigin(const char* origin, const char* host) {
  const char* p = strstr(origin, "://");
  p = p ? p + 3 : origin;
  return strcasecmp(p, host) == 0;
}

void WebUiInterface::addOriginCheck() {
  _server->addMiddleware([](AsyncWebServerRequest* r, ArMiddlewareNext next) {
    if (r->hasHeader("Origin") && r->hasHeader("Host") &&
        !sameOrigin(r->header("Origin").c_str(), r->header("Host").c_str())) {
      r->send(403, "text/plain", "cross-origin request refused");
      return;
    }
    next();
  });
}

static const char SETUP_PAGE[] PROGMEM =
  "<!doctype html><html><head><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'>"
  "<title>Node setup</title><style>body{font:16px system-ui,sans-serif;max-width:26em;margin:2em auto;padding:0 1em}"
  "label{display:block;margin:1em 0 .2em}input{width:100%;padding:.6em;box-sizing:border-box;font:inherit}"
  "button{margin-top:1.2em;padding:.7em 1.4em;font:inherit}small{color:#666}</style></head><body>"
  "<h1>Node setup</h1><p>Give the node your WiFi and choose the password for its web page. It reboots and joins your WiFi; "
  "then open its address from there and sign in as <b>admin</b>.</p>"
  "<form method=post action=/save>"
  "<label>WiFi name</label><input name=ssid maxlength=32 required autocomplete=off>"
  "<label>WiFi password</label><input name=wpw maxlength=63 type=password autocomplete=off><small>Leave empty for an open network.</small>"
  "<label>Web page password</label><input name=webpw minlength=8 maxlength=32 type=password required autocomplete=off>"
  "<small>8 to 32 characters.</small><br><button>Save and reboot</button></form></body></html>";

void WebUiInterface::beginSetup(uint16_t port, WebUiSetupSaveFn onSave) {
  _onSave = onSave;
  _mux = xSemaphoreCreateMutex();
  _server = new AsyncWebServer(port);
  addOriginCheck();
  _server->on("/", HTTP_GET, [](AsyncWebServerRequest* r) { r->send(200, "text/html", SETUP_PAGE); });
  _server->on("/save", HTTP_POST, [this](AsyncWebServerRequest* r) {
    auto val = [r](const char* k) { return r->hasParam(k, true) ? r->getParam(k, true)->value() : String(); };
    String ssid = val("ssid"), wpw = val("wpw"), webpw = val("webpw");
    if (ssid.length() < 1 || ssid.length() > 32 || wpw.length() > 63 || webpw.length() < 8 || webpw.length() > 32) {
      r->send(400, "text/plain", "Check the lengths: WiFi name 1-32, WiFi password up to 63, web password 8-32.");
      return;
    }
    xSemaphoreTake(_mux, portMAX_DELAY);
    strcpy(_pSsid, ssid.c_str()); strcpy(_pWifiPwd, wpw.c_str()); strcpy(_pWebPwd, webpw.c_str());
    _savePending = true;
    xSemaphoreGive(_mux);
    r->send(200, "text/html", "<!doctype html><meta name=viewport content='width=device-width'><body style='font:16px system-ui;margin:2em'>"
                              "Saved. The node is rebooting and will join your WiFi.");
  });
  _server->onNotFound([](AsyncWebServerRequest* r) { r->redirect("/"); });
  _server->begin();
}

void WebUiInterface::startAccessPoint(bool keepStation) {
  if (_apOn) return;
  uint8_t mac[6];
  WiFi.macAddress(mac);
  char name[20];
  snprintf(name, sizeof(name), "MeshNode-%02X%02X", mac[4], mac[5]);
  WiFi.mode(keepStation ? WIFI_AP_STA : WIFI_AP);
  WiFi.softAP(name, WEBUI_AP_PASSWORD);
  _apOn = true;
  _apKeepsStation = keepStation;
  _apStart = millis();
}

void WebUiInterface::begin(uint16_t port, const char* user, const char* password) {
  if (!password || !password[0]) return;   // no password, no web UI

  _mux = xSemaphoreCreateMutex();
  _server = new AsyncWebServer(port);
  _ws = new AsyncWebSocket("/ws");
  _auth = new AsyncAuthenticationMiddleware();
  _auth->setUsername(user);
  _auth->setPassword(password);
  _auth->setRealm("meshnode");
  _auth->setAuthType(AsyncAuthType::AUTH_DIGEST);

  _ws->onEvent([this](AsyncWebSocket*, AsyncWebSocketClient* c, AwsEventType t, void* arg, uint8_t* d, size_t n) {
    onEvent(c, (int)t, arg, d, n);
  });

  addOriginCheck();   // outermost: refuse cross-site requests before authenticating
  _server->addMiddleware(_auth);

  _server->addHandler(_ws);
  _server->on("/", HTTP_GET, [](AsyncWebServerRequest* r) {
    AsyncWebServerResponse* resp = r->beginResponse(200, "text/html", WEBUI_PAGE_GZ, WEBUI_PAGE_GZ_LEN);
    resp->addHeader("Content-Encoding", "gzip");
    resp->addHeader("Cache-Control", "no-store");
    r->send(resp);
  });
  _server->onNotFound([](AsyncWebServerRequest* r) { r->send(404, "text/plain", "not found"); });
  _server->begin();
}

void WebUiInterface::onEvent(AsyncWebSocketClient* client, int type, void* arg, uint8_t* data, size_t len) {
  switch ((AwsEventType)type) {
    case WS_EVT_CONNECT:
      if (_ws->count() > WEBUI_MAX_CLIENTS) {
        client->close(1013);   // try again later
      }
      _clients = _ws->count();
      break;
    case WS_EVT_DISCONNECT:
    case WS_EVT_ERROR:
      _clients = _ws->count();
      break;
    case WS_EVT_DATA: {
      AwsFrameInfo* info = (AwsFrameInfo*)arg;
      // one companion frame is one unfragmented binary message
      if (!info->final || info->index != 0 || info->len != len || info->opcode != WS_BINARY) break;
      if (len == 0 || len > MAX_FRAME_SIZE) break;
      xSemaphoreTake(_mux, portMAX_DELAY);
      if (_recv_len < RECV_QUEUE_SIZE) {
        _recv[_recv_len].len = len;
        memcpy(_recv[_recv_len].buf, data, len);
        _recv_len++;
      }   // else dropped: the page waits for each reply before sending the next command
      xSemaphoreGive(_mux);
      break;
    }
    default:
      break;
  }
}

void WebUiInterface::enable() {
  _isEnabled = true;
  _send_len = 0;
}

void WebUiInterface::disable() {
  _isEnabled = false;
}

size_t WebUiInterface::writeFrame(const uint8_t src[], size_t len) {
  if (!_isEnabled || _clients == 0 || len == 0 || len > MAX_FRAME_SIZE) return 0;
  if (_send_len >= SEND_QUEUE_SIZE) return 0;
  _send[_send_len].len = len;
  memcpy(_send[_send_len].buf, src, len);
  _send_len++;
  return len;
}

void WebUiInterface::loop() {
  if (_savePending && _onSave) {   // form values arrive on the async task; saving prefs happens here
    xSemaphoreTake(_mux, portMAX_DELAY);
    char s[33], w[64], p[33];
    strcpy(s, _pSsid); strcpy(w, _pWifiPwd); strcpy(p, _pWebPwd);
    _savePending = false;
    xSemaphoreGive(_mux);
    _onSave(s, w, p);
  }
  if (_apOn) {
    // setup AP: closes after the time limit. Recovery AP: closes as soon as the station side is back.
    bool timeUp = !_apKeepsStation && millis() - _apStart > WEBUI_AP_MAX_MS;
    bool stationBack = _apKeepsStation && WiFi.status() == WL_CONNECTED;
    if (timeUp || stationBack) {
      WiFi.softAPdisconnect(true);
      if (_apKeepsStation) WiFi.mode(WIFI_STA);
      _apOn = false;
    }
  }
  if (!_ws) return;
  _ws->cleanupClients(WEBUI_MAX_CLIENTS);
  _clients = _ws->count();
  if (_clients == 0) {
    _send_len = 0;   // nobody to tell
    return;
  }
  // push queued frames while every client can take one; a slow client holds the queue
  while (_send_len > 0 && _ws->availableForWriteAll()) {
    _ws->binaryAll(_send[0].buf, _send[0].len);
    _send_len--;
    for (int i = 0; i < _send_len; i++) _send[i] = _send[i + 1];
  }
}

size_t WebUiInterface::checkRecvFrame(uint8_t dest[]) {
  if (!_mux) return 0;
  size_t n = 0;
  xSemaphoreTake(_mux, portMAX_DELAY);
  if (_recv_len > 0) {
    n = _recv[0].len;
    memcpy(dest, _recv[0].buf, n);
    _recv_len--;
    for (int i = 0; i < _recv_len; i++) _recv[i] = _recv[i + 1];
  }
  xSemaphoreGive(_mux);
  return n;
}

#endif
