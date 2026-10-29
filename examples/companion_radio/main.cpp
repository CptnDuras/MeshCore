#include <Arduino.h>   // needed for PlatformIO
#include <Mesh.h>
#include "MyMesh.h"

// Believe it or not, this std C function is busted on some platforms!
static uint32_t _atoi(const char* sp) {
  uint32_t n = 0;
  while (*sp && *sp >= '0' && *sp <= '9') {
    n *= 10;
    n += (*sp++ - '0');
  }
  return n;
}

// debug builds: where does the internal heap go (ESP32 only, needs WIFI_DEBUG_LOGGING)
#if defined(ESP32) && defined(WIFI_DEBUG_LOGGING) && WIFI_DEBUG_LOGGING
  #include <esp_heap_caps.h>
  #include <esp_rom_sys.h>
  #define HEAP_MARK(label) Serial.printf("HEAP: %-18s internal=%u largest=%u\n", label, \
    (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL), (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL))
  // runs inside the allocator: no Serial, no allocation
  static void heap_alloc_failed(size_t size, uint32_t caps, const char* fn) {
    esp_rom_printf("HEAP: ALLOC FAILED %u bytes caps=0x%x in %s (task %s)\n", (unsigned)size, (unsigned)caps, fn,
      pcTaskGetName(NULL));
  }
#else
  #define HEAP_MARK(label) ((void)0)
#endif

// interface manager
#include <helpers/MultiSerialInterface.h>
MultiSerialInterface interface_manager;

// include bluetooth interface
#if defined(BLE_PIN_CODE)
  #ifdef ESP32
    // include esp32 bluetooth interface
    #include <helpers/esp32/SerialBLEInterface.h>
    SerialBLEInterface bluetooth_interface;
  #elif defined(NRF52_PLATFORM)
    // include nrf52 bluetooth interface
    #include <helpers/nrf52/SerialBLEInterface.h>
    SerialBLEInterface bluetooth_interface;
  #elif defined(RP2040_PLATFORM)
    // include rp2040 (Pico W / CYW43) bluetooth interface
    #include <helpers/rp2040/SerialBLEInterface.h>
    SerialBLEInterface bluetooth_interface;
  #else
    #error "SerialBLEInterface is not defined for this platform"
  #endif
#endif

// include wifi interface
#ifdef ENABLE_WIFI_INTERFACE
  #ifndef WIFI_SSID
    #define WIFI_SSID ""
  #endif
  #ifndef WIFI_PWD
    #define WIFI_PWD ""
  #endif
  #ifndef TCP_PORT
    #define TCP_PORT 5000
  #endif
  #ifndef WIFI_RETRY_INTERVAL
    #if defined(RP2040_PLATFORM)
      #define WIFI_RETRY_INTERVAL 30000   // each attempt blocks loop(), so retry less often
    #else
      #define WIFI_RETRY_INTERVAL 10000   // millis between reconnect attempts
    #endif
  #endif
  #ifndef WIFI_RETRY_TIMEOUT
    #define WIFI_RETRY_TIMEOUT 5000     // RP2040: cap on how long one join may block loop()
  #endif
  #if defined(ESP32) || defined(RP2040_PLATFORM)
    #include <helpers/wifi/SerialWifiInterface.h>
    SerialWifiInterface wifi_interface;
    #ifdef WITH_WEBUI
      #include <helpers/wifi/WebUiInterface.h>
      WebUiInterface web_interface;
    #endif
  #else
    #error "SerialWifiInterface is not defined for this platform"
  #endif
#endif

// include usb interface
#if defined(ENABLE_USB_INTERFACE)
  #include <helpers/ArduinoSerialInterface.h>
  ArduinoSerialInterface usb_serial_interface;
#endif

// include ethernet interface
#if defined(ETHERNET_ENABLED)
  #include <helpers/ethernet/EthernetInterface.h>
  ETHERNET_CLASS ethernet_interface;
#endif

// include hardware serial interface
#if defined(SERIAL_RX)
  #include <helpers/ArduinoSerialInterface.h>
  ArduinoSerialInterface hardware_serial_interface;
  HardwareSerial companion_serial(1);
#endif

// platform file system
#if defined(NRF52_PLATFORM) || defined(STM32_PLATFORM)
  #include <InternalFileSystem.h>
  #if defined(QSPIFLASH)
    #include <CustomLFS_QSPIFlash.h>
    DataStore store(InternalFS, QSPIFlash, rtc_clock);
  #else
    #if defined(EXTRAFS)
      #include <CustomLFS.h>
      CustomLFS ExtraFS(0xD4000, 0x19000, 128);
      DataStore store(InternalFS, ExtraFS, rtc_clock);
    #else
      DataStore store(InternalFS, rtc_clock);
    #endif
  #endif
#elif defined(RP2040_PLATFORM)
  #include <LittleFS.h>
  DataStore store(LittleFS, rtc_clock);
#elif defined(ESP32)
  #include <SPIFFS.h>
  DataStore store(SPIFFS, rtc_clock);
#endif

/* GLOBAL OBJECTS */
#ifdef DISPLAY_CLASS
  #include "UITask.h"
  UITask ui_task(&board, &interface_manager);
#endif

StdRNG fast_rng;
SimpleMeshTables tables;
MyMesh the_mesh(radio_driver, fast_rng, rtc_clock, tables, store);

/* END GLOBAL OBJECTS */

void halt() {
  while (1) ;
}

/* WIFI RECONNECT TRACKERS */
#ifdef ENABLE_WIFI_INTERFACE
  bool wifi_needs_reconnect = false;
  unsigned long last_wifi_reconnect_attempt = 0;
  char wifi_ssid[33] = WIFI_SSID;   // replaced by stored prefs at boot, if set
  char wifi_pwd[64] = WIFI_PWD;
  bool wifi_was_connected = false;
  bool wifi_enabled = false;   // set at boot from prefs; false also when the effective SSID is blank
  #ifdef WEBUI_AP_MODE
  bool wifi_ap_mode = false;   // set at boot from prefs: be an access point (MeshNode-XXXX) instead of joining a network
  #else
  static const bool wifi_ap_mode = false;
  #endif
#endif

#if defined(WITH_WEBUI) && defined(ENABLE_WIFI_INTERFACE)
static unsigned long web_reboot_at = 0;   // after the setup form saved: reboot once the reply has gone out
static void web_setup_saved(const char* ssid, const char* wifiPwd, const char* webPwd) {
  NodePrefs* p = the_mesh.getNodePrefs();
  StrHelper::strncpy(p->wifi_ssid, ssid, sizeof(p->wifi_ssid));
  StrHelper::strncpy(p->wifi_pwd, wifiPwd, sizeof(p->wifi_pwd));
  StrHelper::strncpy(p->web_pwd, webPwd, sizeof(p->web_pwd));
#ifdef WEBUI_AP_MODE
  p->wifi_ap = ssid[0] ? 0 : 1;   // no WiFi name given: the node is its own WiFi
#endif
  p->wifi_enabled = 1;
  the_mesh.savePrefs();
  web_reboot_at = millis() + 2000;
}
#endif

void setup() {
  Serial.begin(115200);
#if defined(ESP32) && defined(WIFI_DEBUG_LOGGING) && WIFI_DEBUG_LOGGING
  heap_caps_register_failed_alloc_callback(heap_alloc_failed);
#endif
#if defined(ESP32) && defined(EXTMEM_MALLOC_LIMIT) && EXTMEM_MALLOC_LIMIT > 0   // 0 turns it off
  // plain malloc/new of this size or more goes to PSRAM; WiFi's DMA buffers, task stacks and ISR code stay internal.
  // Bluetooth and the web server take over 80 KB of the internal heap, and WiFi stops answering when it runs out.
  if (heap_caps_get_total_size(MALLOC_CAP_SPIRAM) > 0) heap_caps_malloc_extmem_enable(EXTMEM_MALLOC_LIMIT);
#endif
  HEAP_MARK("setup start");
  board.begin();
  HEAP_MARK("board.begin");

#ifdef HAS_EXTERNAL_WATCHDOG
  external_watchdog.begin();
#endif

#ifdef DISPLAY_CLASS
  DisplayDriver* disp = NULL;
  bool display_ok = display.begin();
#if defined(WIFI_DEBUG_LOGGING) && WIFI_DEBUG_LOGGING
  Serial.printf("DISPLAY: begin() returned %d, internal heap %u\n", (int)display_ok, (unsigned)ESP.getFreeHeap());
#endif
  if (display_ok) {
    disp = &display;
    disp->startFrame();
  #ifdef ST7789
    disp->setTextSize(2);
  #endif
    disp->drawTextCentered(disp->width() / 2, 28, "Loading...");
    disp->endFrame();
  }
#endif

  HEAP_MARK("display");
  if (!radio_init()) { halt(); }
  HEAP_MARK("radio_init");

  fast_rng.begin(radio_driver.getRngSeed());

#if defined(NRF52_PLATFORM) || defined(STM32_PLATFORM)
  InternalFS.begin();
  #if defined(QSPIFLASH)
    if (!QSPIFlash.begin()) {
      // debug output might not be available at this point, might be too early. maybe should fall back to InternalFS here?
      MESH_DEBUG_PRINTLN("CustomLFS_QSPIFlash: failed to initialize");
    } else {
      MESH_DEBUG_PRINTLN("CustomLFS_QSPIFlash: initialized successfully");
    }
  #else
  #if defined(EXTRAFS)
      ExtraFS.begin();
  #endif
  #endif
  store.begin();
  the_mesh.begin();
#elif defined(RP2040_PLATFORM)
  LittleFS.begin();
  store.begin();
  the_mesh.begin();
#elif defined(ESP32)
  SPIFFS.begin(true);
  HEAP_MARK("SPIFFS");
  store.begin();
  the_mesh.begin();
  HEAP_MARK("the_mesh.begin");
#else
  #error "need to define filesystem"
#endif

#ifdef BLE_PIN_CODE // 123456 by default
  if (the_mesh.getNodePrefs()->ble_pin == 0) {
#ifdef DISPLAY_CLASS
    if (disp != NULL && BLE_PIN_CODE == 123456) {
      StdRNG rng;
      the_mesh.setBLEPin(rng.nextInt(100000, 999999)); // random pin each session
    } else {
      the_mesh.setBLEPin(BLE_PIN_CODE); // otherwise static pin
    }
#else
    the_mesh.setBLEPin(BLE_PIN_CODE); // otherwise static pin
#endif
  } else {
    the_mesh.setBLEPin(the_mesh.getNodePrefs()->ble_pin);
  }
#else
  the_mesh.setBLEPin(0);
#endif

// add bluetooth interface (BLE_START_LAST: after WiFi and the web page are up instead of before)
#if defined(BLE_PIN_CODE) && !defined(BLE_START_LAST)
  bluetooth_interface.begin(BLE_NAME_PREFIX, the_mesh.getNodePrefs()->node_name, the_mesh.getBLEPin());
  interface_manager.addInterface(InterfaceType::Bluetooth, &bluetooth_interface);
#endif

// add wifi interface
#ifdef ENABLE_WIFI_INTERFACE
  // use wifi ssid and password from prefs if ssid is not empty, otherwise use the build flag defaults
  if (the_mesh.getNodePrefs()->wifi_ssid[0]) {
    strcpy(wifi_ssid, the_mesh.getNodePrefs()->wifi_ssid);
    strcpy(wifi_pwd, the_mesh.getNodePrefs()->wifi_pwd);
  }
  // only start wifi if enabled and ssid is not empty
  wifi_enabled = the_mesh.getNodePrefs()->wifi_enabled;
#ifdef WEBUI_AP_MODE
  wifi_ap_mode = wifi_enabled && the_mesh.getNodePrefs()->wifi_ap;
#endif
  if (wifi_enabled && wifi_ssid[0] && !wifi_ap_mode) {
#if defined(ESP32)
    board.setInhibitSleep(true);   // prevent sleep when WiFi is active
    WiFi.setAutoReconnect(true);

    WiFi.onEvent([](WiFiEvent_t event, WiFiEventInfo_t info){
        if (event == ARDUINO_EVENT_WIFI_STA_DISCONNECTED) {
            WIFI_DEBUG_PRINTLN("WiFi disconnected (reason=%s). Flagging for reconnect...",
              WiFi.disconnectReasonName((wifi_err_reason_t)info.wifi_sta_disconnected.reason));
            wifi_needs_reconnect = true;
        } else if (event == ARDUINO_EVENT_WIFI_STA_GOT_IP) {
            WIFI_DEBUG_PRINTLN("WiFi connected successfully!");
#if WIFI_DEBUG_LOGGING && ARDUINO
            WIFI_DEBUG_PRINTLN("ip=%s gw=%s mask=%s ssid=%s bssid=%s ch=%d rssi=%d mac=%s",
              WiFi.localIP().toString().c_str(), WiFi.gatewayIP().toString().c_str(),
              WiFi.subnetMask().toString().c_str(), WiFi.SSID().c_str(), WiFi.BSSIDstr().c_str(),
              (int)WiFi.channel(), (int)WiFi.RSSI(), WiFi.macAddress().c_str());
#endif
            wifi_needs_reconnect = false;
        }
    });
#endif

    WIFI_DEBUG_PRINTLN("connecting to %s", wifi_ssid);

#if defined(RP2040_PLATFORM)
    // the join itself blocks inside the core (CYW43::begin busy-waits for the
    // association), so every attempt stalls the mesh loop. beginNoBlock() only skips the
    // extra DHCP wait. Give the first connect a full window, then bound the retries below.
    WiFi.beginNoBlock(wifi_ssid, wifi_pwd);
    last_wifi_reconnect_attempt = millis();   // let DHCP finish before the poll can retry
#else
    WiFi.begin(wifi_ssid, wifi_pwd);
#endif
#if defined(ESP32) && defined(BLE_PIN_CODE) && defined(WIFI_NO_SLEEP)
    // Bluetooth and WiFi share one radio: with the default modem sleep the node stops answering on the network
    // (the router cannot even resolve its address) while Bluetooth is active, so keep the WiFi side awake.
    WiFi.setSleep(false);
#endif
    HEAP_MARK("before wifi iface");
    wifi_interface.begin(TCP_PORT);
    interface_manager.addInterface(InterfaceType::WiFi, &wifi_interface);
    HEAP_MARK("wifi iface");
  } else {
    WIFI_DEBUG_PRINTLN("wifi disabled");
  }
#ifdef WITH_WEBUI
  if (wifi_enabled) {
    if (the_mesh.getNodePrefs()->web_pwd[0]) {
      web_interface.begin(WEBUI_PORT, WEBUI_USER, the_mesh.getNodePrefs()->web_pwd);
#ifdef WEBUI_AP_MODE
      if (wifi_ap_mode) web_interface.startAccessPoint(false, true, the_mesh.getNodePrefs()->ap_pwd);   // stays up: join it and open 192.168.4.1
#endif
    } else {
      // not configured yet: an access point with a setup form (WiFi name and password, web password)
      web_interface.beginSetup(WEBUI_PORT, web_setup_saved);
      web_interface.startAccessPoint(wifi_ssid[0] != 0 && !wifi_ap_mode, wifi_ap_mode, wifi_ap_mode ? the_mesh.getNodePrefs()->ap_pwd : nullptr);
    }
    interface_manager.addInterface(InterfaceType::Web, &web_interface);
  }
  HEAP_MARK("web iface");
#endif
#endif

#if defined(BLE_PIN_CODE) && defined(BLE_START_LAST)
  bluetooth_interface.begin(BLE_NAME_PREFIX, the_mesh.getNodePrefs()->node_name, the_mesh.getBLEPin());
  interface_manager.addInterface(InterfaceType::Bluetooth, &bluetooth_interface);
  HEAP_MARK("ble begin");
#endif

// add usb interface
#if defined(ENABLE_USB_INTERFACE)
  usb_serial_interface.begin(Serial);
  interface_manager.addInterface(InterfaceType::USB, &usb_serial_interface);
#endif

// add ethernet interface
#if defined(ETHERNET_ENABLED)
  ethernet_interface.begin();
  interface_manager.addInterface(InterfaceType::Ethernet, &ethernet_interface);
#endif

// add hardware serial interface
#if defined(SERIAL_RX)
  companion_serial.setPins(SERIAL_RX, SERIAL_TX);
  companion_serial.begin(115200);
  hardware_serial_interface.begin(companion_serial);
  interface_manager.addInterface(InterfaceType::HardwareSerial, &hardware_serial_interface);
#endif

  the_mesh.startInterface(interface_manager);
  HEAP_MARK("startInterface");
  sensors.begin();

#if ENV_INCLUDE_GPS == 1
  the_mesh.applyGpsPrefs();
#endif

#ifdef DISPLAY_CLASS
  ui_task.begin(disp, &sensors, the_mesh.getNodePrefs());  // still want to pass this in as dependency, as prefs might be moved
  HEAP_MARK("ui_task.begin");
  the_mesh.setListener(&ui_task);
#endif

  board.onBootComplete();
}

void loop() {
#if WIFI_DEBUG_LOGGING && ARDUINO && defined(ESP32)
  static unsigned long last_wifi_status = 0;
  if (millis() - last_wifi_status >= 1000) {
    last_wifi_status = millis();
    static unsigned prev_internal = 0;
    unsigned internal = (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL);
    WIFI_DEBUG_PRINTLN("status=%d ip=%s rssi=%d internal=%u min=%u largest=%u psram=%u up=%lus",
      (int)WiFi.status(), WiFi.localIP().toString().c_str(), (int)WiFi.RSSI(), internal,
      (unsigned)heap_caps_get_minimum_free_size(MALLOC_CAP_INTERNAL),
      (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL),
      (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM), millis() / 1000);
    if (prev_internal && (internal + 2048 < prev_internal || prev_internal + 2048 < internal))
      WIFI_DEBUG_PRINTLN("HEAP: internal %u -> %u (%+d)", prev_internal, internal, (int)internal - (int)prev_internal);
    prev_internal = internal;
  }
#endif
  the_mesh.loop();
  interface_manager.loop();
  sensors.loop();
#ifdef DISPLAY_CLASS
  ui_task.loop();
#endif
  rtc_clock.tick();
  board.loop();
#ifdef HAS_EXTERNAL_WATCHDOG
  external_watchdog.loop();
#endif

  if (!the_mesh.hasPendingWork()) {
#if defined(NRF52_PLATFORM)
    board.sleep(0); // nrf ignores seconds param, sleeps whenever possible
#endif
  }

#if defined(WITH_WEBUI) && defined(ENABLE_WIFI_INTERFACE)
  if (web_reboot_at && millis() > web_reboot_at) board.reboot();
  // web page set up but the home WiFi never came up (wrong password, moved house): raise the access point so the
  // page, which is reachable at 192.168.4.1 with the web password, can fix the WiFi settings through its console
  if (wifi_enabled && !wifi_ap_mode && the_mesh.getNodePrefs()->web_pwd[0] && !web_interface.accessPointOn() &&
      millis() > WEBUI_RECOVERY_AP_MS && WiFi.status() != WL_CONNECTED) {
    web_interface.startAccessPoint(true);
  }
#endif
#ifdef ENABLE_WIFI_INTERFACE
  if (wifi_enabled) {
    // RP2040 has no WiFi event callbacks, so poll the link state instead
  #if defined(RP2040_PLATFORM)
      wifi_needs_reconnect = (WiFi.status() != WL_CONNECTED);
      if (wifi_was_connected == wifi_needs_reconnect) {   // link state changed
        wifi_was_connected = !wifi_needs_reconnect;
        if (wifi_was_connected) {
          WIFI_DEBUG_PRINTLN("connected, listening on %s:%d", WiFi.localIP().toString().c_str(), TCP_PORT);
        } else {
          WIFI_DEBUG_PRINTLN("link lost");
        }
      }
  #endif

    // Safely attempt to reconnect if flagged. On RP2040 each attempt blocks the mesh loop
    // for up to WIFI_RETRY_TIMEOUT, so retry less often and cap how long a join may stall.
    if (wifi_needs_reconnect && (millis() - last_wifi_reconnect_attempt > WIFI_RETRY_INTERVAL)) {
      WIFI_DEBUG_PRINTLN("Attempting manual WiFi reconnect to %s (status %d)...", wifi_ssid, WiFi.status());
    #if defined(RP2040_PLATFORM)
        WiFi.setTimeout(WIFI_RETRY_TIMEOUT);
        WiFi.beginNoBlock(wifi_ssid, wifi_pwd);   // no reconnect() on this platform
    #else
        WiFi.disconnect();
        WiFi.reconnect();
    #endif
      last_wifi_reconnect_attempt = millis();
    }
  }
#endif
}
