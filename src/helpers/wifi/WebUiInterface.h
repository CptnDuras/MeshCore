#pragma once

// Companion web UI over WiFi (ESP32).
//
// Serves one self-contained page and a WebSocket at /ws. Each binary WebSocket message is one
// companion-protocol frame, exactly the bytes the phone apps exchange (no '<' / '>' length
// header: the WebSocket message boundary frames it). The page therefore speaks the stock
// protocol and the firmware needs no UI-specific logic.
//
// Concurrency: AsyncWebServer callbacks run on the async_tcp task. They only enqueue received
// frames (under _mux). Everything that touches the mesh (checkRecvFrame, writeFrame, loop) runs
// on the Arduino loop task, which also does the actual WebSocket sends.
//
// Security: every route needs digest authentication, and a WebSocket upgrade whose Origin is not
// the page's own host is refused (stops other sites in the user's browser reaching the node).
// There is no TLS: the password is not sent in clear, but the traffic is. Keep it on a trusted LAN.

#if defined(ESP_PLATFORM) && defined(WITH_WEBUI)

#include "../BaseSerialInterface.h"
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>

class AsyncWebServer;
class AsyncWebSocket;
class AsyncWebSocketClient;
class AsyncAuthenticationMiddleware;

#ifndef WEBUI_PORT
  #define WEBUI_PORT 80
#endif
#ifndef WEBUI_MAX_CLIENTS
  #define WEBUI_MAX_CLIENTS 3
#endif
#ifndef WEBUI_USER
  #define WEBUI_USER "admin"
#endif

// Called on the Arduino loop task with the values entered in the setup form (already validated).
typedef void (*WebUiSetupSaveFn)(const char* ssid, const char* wifiPwd, const char* webPwd);

#ifndef WEBUI_AP_PASSWORD
  #define WEBUI_AP_PASSWORD "meshnode"   // WPA2 key of the setup access point (printed in the docs)
#endif
#ifndef WEBUI_RECOVERY_AP_MS
  #define WEBUI_RECOVERY_AP_MS 90000UL   // station never connected this long after boot: raise the access point
#endif
#ifndef WEBUI_AP_MAX_MS
  #define WEBUI_AP_MAX_MS (15UL * 60UL * 1000UL)
#endif

class WebUiInterface : public BaseSerialInterface {
  struct Frame {
    uint8_t len;
    uint8_t buf[MAX_FRAME_SIZE];
  };
  static const int RECV_QUEUE_SIZE = 4;
  static const int SEND_QUEUE_SIZE = 16;

  AsyncWebServer* _server = nullptr;
  AsyncWebSocket* _ws = nullptr;
  AsyncAuthenticationMiddleware* _auth = nullptr;
  SemaphoreHandle_t _mux = nullptr;
  bool _isEnabled = false;
  volatile int _clients = 0;

  Frame _recv[RECV_QUEUE_SIZE];
  int _recv_len = 0;
  Frame _send[SEND_QUEUE_SIZE];
  int _send_len = 0;

  // access point and first-boot setup form
  bool _apOn = false;
  bool _apKeepsStation = false;
  unsigned long _apStart = 0;
  WebUiSetupSaveFn _onSave = nullptr;
  bool _savePending = false;
  char _pSsid[33], _pWifiPwd[64], _pWebPwd[33];

  static bool sameOrigin(const char* origin, const char* host);
  void addOriginCheck();
  void onEvent(AsyncWebSocketClient* client, int type, void* arg, uint8_t* data, size_t len);

public:
  // Starts the HTTP server. Does nothing if the password is empty (the UI stays off).
  void begin(uint16_t port, const char* user, const char* password);

  // First-boot setup: no web password yet, so serve only a form (WiFi name, WiFi password, web password) on the
  // access point. Open to anyone in radio range until saved or WEBUI_AP_MAX_MS passes, then the AP shuts off.
  void beginSetup(uint16_t port, WebUiSetupSaveFn onSave);
  // Raises "MeshNode-XXXX". keepStation: leave the station connection attempts running (recovery mode).
  void startAccessPoint(bool keepStation);
  bool accessPointOn() const { return _apOn; }

  void enable() override;
  void disable() override;
  bool isEnabled() const override { return _isEnabled; }
  bool isConnected() const override { return _isEnabled && _clients > 0; }
  void loop() override;
  bool isWriteBusy() const override { return _send_len >= SEND_QUEUE_SIZE / 2; }
  size_t writeFrame(const uint8_t src[], size_t len) override;
  size_t checkRecvFrame(uint8_t dest[]) override;
};

#endif
