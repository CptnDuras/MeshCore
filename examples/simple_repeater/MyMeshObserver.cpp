// Observer module glue for the simple repeater: MQTT uplink (MQTTBridge) and the
// browser/WiFi config portal (WebConfigServer).
//
// Everything that connects MyMesh to the observer lives here so the module can be
// swapped for another implementation: MyMesh.cpp only has the packet hooks
// (logRx/logTx/logRxRaw) and calls observerBegin()/observerLoop().
// The surface the repeater uses on the bridge is: begin/end/isRunning/
// onPacketReceived/sendPacket/storeRawRadioData/setSlotPreset/getQueueSize/
// requestForcedNtpSync/ntpDiag/set* metadata/setStatsSources.
#include "MyMesh.h"

#ifdef WITH_MQTT_BRIDGE

void MyMesh::observerConfigureBridge() {
  char device_id[65];
  mesh::Utils::toHex(device_id, self_id.pub_key, PUB_KEY_SIZE);   // public key keys the MQTT topics
  bridge->setDeviceID(device_id);
  bridge->setFirmwareVersion(getFirmwareVer());
  bridge->setBoardModel(_cli.getBoard()->getManufacturerName());
  bridge->setBuildDate(getBuildDate());
  bridge->setStatsSources(this, _radio, _cli.getBoard(), _ms);
}

void MyMesh::observerBegin() {
  if (_prefs.bridge_enabled) {
    // Constructed here, not statically, to avoid static-init crashes on classic ESP32.
    bridge = new MQTTBridge(&_prefs, _cli.getObserverPrefs(), _mgr, getRTCClock(), &self_id);
    if (bridge) {
      observerConfigureBridge();
      bridge->begin();
    }
  }

#if defined(WITH_WEBCONFIG) && !defined(WEBCONFIG_NO_AUTO_AP)
  // First-boot setup portal: raised only when no WiFi has ever been configured, so
  // an update onto an already-configured node can never open an AP.
  if (_cli.getObserverPrefs()->wifi_ssid[0] == 0) {
    char wc_reply[160];
    startWebConfig(false, wc_reply);
    Serial.println(wc_reply);
  }
#endif
}

void MyMesh::observerLoop() {
#ifdef WITH_WEBCONFIG
  if (_webconfig) {
    _webconfig->tick(millis());
    if (!_webconfig->isRunning() && !_webconfig->isStopping()) {
      delete _webconfig;   // teardown finished (or start failed): reclaim the heap
      _webconfig = NULL;
    }
  }
#endif
}

void MyMesh::setBridgeState(bool enable) {
  if (!bridge) {
    if (!enable) return;
    bridge = new MQTTBridge(&_prefs, _cli.getObserverPrefs(), _mgr, getRTCClock(), &self_id);
    if (!bridge) return;
  }
  if (enable == bridge->isRunning()) return;
  if (enable) {
    observerConfigureBridge();
    bridge->begin();
  } else {
    bridge->end();
  }
}

void MyMesh::restartBridge() {
  if (!bridge || !bridge->isRunning()) return;
#ifdef WITH_WEBCONFIG
  if (_wc_batch_active) {   // coalesced: applied once in onConfigBatchEnd()
    _wc_restart_pending = true;
    return;
  }
#endif
  bridge->end();
  observerConfigureBridge();
  bridge->begin();
}

void MyMesh::restartBridgeSlot(int slot) {
  if (!bridge || !bridge->isRunning()) return;
#ifdef WITH_WEBCONFIG
  if (_wc_batch_active && slot >= 0 && slot < 8) {
    _wc_slot_restart_mask |= (uint8_t)(1u << slot);
    return;
  }
#endif
  bridge->setSlotPreset(slot, _cli.getObserverPrefs()->mqtt_slot_preset[slot]);
}

bool MyMesh::syncMqttNtp() {
  if (!bridge || !bridge->isRunning()) return false;
  // Queued onto the MQTT task without blocking: this runs on the Arduino loop task
  // and blocking there would stall radio forwarding. Verify with `get mqtt.ntp.diag`.
  return bridge->requestForcedNtpSync(0);
}

bool MyMesh::runMqttNtpDiag(char* reply, size_t reply_size, bool verbose) {
  if (!bridge || !bridge->isRunning()) return false;
  return bridge->ntpDiag(reply, reply_size, verbose);
}

#ifdef WITH_WEBCONFIG
bool MyMesh::startWebConfig(bool force_ap, char* reply) {
  if (_webconfig && (_webconfig->isRunning() || _webconfig->isStopping())) {
    strcpy(reply, _webconfig->isStopping() ? "Err: webconfig still stopping, retry shortly"
                                           : "Err: webconfig already running");
    return true;
  }
  if (!_webconfig) {
    _webconfig = new WebConfigServer(&_prefs, _cli.getObserverPrefs(), this,
                                     self_id.pub_key, getFirmwareVer(), getBuildDate(), getRole(),
                                     _cli.getBoard()->getManufacturerName());
  }
  if (force_ap) {
    // The setup AP owns WiFi outright; refuse while the bridge holds the STA.
    if (bridge && bridge->isRunning()) {
      strcpy(reply, "Err: MQTT bridge is running - 'set bridge off' first");
      return true;
    }
    _webconfig->startSetupMode(reply);
  } else if (_cli.getObserverPrefs()->wifi_ssid[0] == 0) {
    _webconfig->startSetupMode(reply);   // unconfigured: same portal as first boot
  } else {
    _webconfig->startLanMode(reply);     // reports "WiFi not connected" if down
  }
  return true;
}

bool MyMesh::stopWebConfig(char* reply) {
  if (!_webconfig || !_webconfig->isRunning()) {
    strcpy(reply, "Err: webconfig not running");
    return true;
  }
  _webconfig->requestStop();
  strcpy(reply, "OK - webconfig stopping");
  return true;
}

void MyMesh::onConfigBatchEnd() {
  _wc_batch_active = false;
  if (_wc_restart_pending) {
    // A full restart re-applies every slot config; drop the per-slot requests.
    _wc_restart_pending = false;
    _wc_slot_restart_mask = 0;
    restartBridge();
  } else if (_wc_slot_restart_mask) {
    uint8_t mask = _wc_slot_restart_mask;
    _wc_slot_restart_mask = 0;
    for (int i = 0; i < RUNTIME_MQTT_SLOTS; i++) {
      if (mask & (1u << i)) restartBridgeSlot(i);
    }
  }
}

// Stats snapshot for GET /api/stats. Runs on the loop task (from tick());
// same sources as the REQ_TYPE_GET_STATUS reply and `get mqtt.stats`.
void MyMesh::buildStatsJson(char* buf, size_t buf_size) {
  char ip[20] = "";
  int wifi_rssi = 0;
  if (WiFi.status() == WL_CONNECTED) {
    strncpy(ip, WiFi.localIP().toString().c_str(), sizeof(ip) - 1);
    wifi_rssi = WiFi.RSSI();
  } else if (_webconfig && _webconfig->mode() == WebConfigServer::MODE_SETUP) {
    strncpy(ip, WiFi.softAPIP().toString().c_str(), sizeof(ip) - 1);
  }
  int pos = snprintf(buf, buf_size,
      "{\"uptime_s\":%lu,\"batt_mv\":%u,"
      "\"heap_free\":%lu,\"heap_min\":%lu,\"heap_max_alloc\":%lu,"
      "\"noise\":%d,\"rssi\":%d,\"snr\":%.1f,"
      "\"airtime_s\":%lu,\"rx_airtime_s\":%lu,"
      "\"recv\":%lu,\"sent\":%lu,\"rx_err\":%lu,"
      "\"sent_flood\":%lu,\"sent_direct\":%lu,\"recv_flood\":%lu,\"recv_direct\":%lu,"
      "\"tx_queue\":%d,\"wifi_rssi\":%d,\"ip\":\"%s\",\"mqtt_queue\":%d,\"slots\":[",
      (unsigned long)(uptime_millis / 1000), (unsigned)board.getBattMilliVolts(),
      (unsigned long)ESP.getFreeHeap(), (unsigned long)ESP.getMinFreeHeap(),
      (unsigned long)ESP.getMaxAllocHeap(),
      (int)_radio->getNoiseFloor(), (int)radio_driver.getLastRSSI(),
      radio_driver.getLastSNR(),
      (unsigned long)(getTotalAirTime() / 1000), (unsigned long)(getReceiveAirTime() / 1000),
      (unsigned long)radio_driver.getPacketsRecv(), (unsigned long)radio_driver.getPacketsSent(),
      (unsigned long)radio_driver.getPacketsRecvErrors(),
      (unsigned long)getNumSentFlood(), (unsigned long)getNumSentDirect(),
      (unsigned long)getNumRecvFlood(), (unsigned long)getNumRecvDirect(),
      (int)_mgr->getOutboundCount(0xFFFFFFFF), wifi_rssi, ip,
      bridge ? bridge->getQueueSize() : 0);
  if (pos < 0 || pos >= (int)buf_size - 3) return;  // truncated; snprintf terminated it
  bool first = true;
  for (int i = 0; i < RUNTIME_MQTT_SLOTS; i++) {
    MQTTBridge::SlotStatusSnapshot s;
    if (!MQTTBridge::getSlotStatusSnapshot(i, &s)) continue;
    // "filt" is omitted for the all-types default, so the portal only has to
    // render the exception and the JSON stays inside the stats buffer.
    char filt[24];
    filt[0] = '\0';
    if (s.filter_mask != MQTTPacketFilter::kAllPacketTypes) {
      snprintf(filt, sizeof(filt), ",\"filt\":%u", (unsigned)s.filter_mask);
    }
    int n = snprintf(buf + pos, buf_size - pos,
                     "%s{\"n\":%d,\"name\":\"%s\",\"state\":\"%s\",\"ok\":%lu,\"err\":%lu%s}",
                     first ? "" : ",", i + 1, s.name, s.state, s.publish_ok, s.publish_err,
                     filt);
    if (n < 0 || n >= (int)(buf_size - pos)) break;
    pos += n;
    first = false;
  }
  snprintf(buf + pos, buf_size - pos, "]}");
}
#endif

#endif  // WITH_MQTT_BRIDGE
