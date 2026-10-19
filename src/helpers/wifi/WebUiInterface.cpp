#if defined(ESP_PLATFORM) && defined(WITH_WEBUI)

#include "WebUiInterface.h"
#include "WebUiPage.h"
#include <ESPAsyncWebServer.h>
#include <string.h>

// Host part of an Origin header ("http://node.local:8080") compared to the Host header
// ("node.local:8080"). A page served by this node always sends matching values.
bool WebUiInterface::sameOrigin(const char* origin, const char* host) {
  const char* p = strstr(origin, "://");
  p = p ? p + 3 : origin;
  return strcasecmp(p, host) == 0;
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

  // outermost first: refuse cross-site requests before authenticating
  _server->addMiddleware([](AsyncWebServerRequest* r, ArMiddlewareNext next) {
    if (r->hasHeader("Origin") && r->hasHeader("Host") &&
        !sameOrigin(r->header("Origin").c_str(), r->header("Host").c_str())) {
      r->send(403, "text/plain", "cross-origin request refused");
      return;
    }
    next();
  });
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
