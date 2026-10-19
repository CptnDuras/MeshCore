# Companion web UI

A chat page served by the node itself over WiFi. Open `http://<node-ip>/`, sign in as `admin`, and you get channels,
contacts, send/receive with delivery confirmation, node info, advert buttons and a command console. No phone app, no
internet, nothing loaded from outside the node.

## How it works

The page talks to the node over a WebSocket at `/ws`. One binary WebSocket message is one companion-protocol frame:
the same bytes the phone apps exchange over BLE, USB or TCP port 5000, without the length header. The firmware side
(`src/helpers/wifi/WebUiInterface.*`) is one more `BaseSerialInterface` registered in the `MultiSerialInterface`, so
the companion code needed no changes to support it. The page's protocol code is `proto.js`.

The web UI runs next to TCP port 5000 and BLE, it does not replace them.

## Turn it on

1. Build an env with `-D WITH_WEBUI` and `ENABLE_WIFI_INTERFACE`. Ready-made: `Heltec_v3_companion_radio_wifi_web`,
   `heltec_v4_companion_radio_wifi_web`, `heltec_v4_tft_companion_radio_wifi_web`,
   `heltec_v4_r8_companion_radio_wifi_web`, `heltec_v4_r8_tft_companion_radio_wifi_web`.
2. Give the node WiFi (from the phone app console, USB serial, or build flags):
   `set wifi.ssid <name>`, `set wifi.pwd <password>`, reboot.
3. Set the web password: `set web.pwd <8 to 32 characters>`, reboot. The user name is `admin`.
4. `get web.status` prints the address. `set web.off` turns it off again.

With no password set the web server is never started.

## Security

- Every request needs digest authentication, including the WebSocket upgrade.
- A request whose `Origin` is not the node's own `Host` is refused, so another website open in your browser cannot
  reach the node.
- There is **no TLS**. The password is not sent in the clear, but messages and keys are. Use it on a network you trust.
- Everything that arrives from the mesh (names, message text) is inserted with `textContent`, never as HTML.
- At most 2 browser sessions at a time.

## Limits to know about

- Replies go to every connected interface. If a phone app and the web page are connected at once, both see every
  response, and both can pull messages from the node's single offline queue, so each will miss messages the other took.
  Use one at a time.
- Message history is kept in the browser (`localStorage`), not on the node, so it is per browser.
- Sending to repeaters, sensors and room login are not in the page yet; use the console for repeater commands.
- The console needs a firmware with `CMD_RUN_CLI_COMMAND` (this tree has it).
- Not yet tested on hardware: digest authentication of the WebSocket upgrade in real browsers, and heap use with
  WiFi, TCP and the web server together under load.

## Cost

Heltec V4 (all four web envs build): about +84 KB flash over the stock WiFi env (1,107,393 to 1,191,657 bytes on the OLED
env, 18.2 % of the 6.5 MB app partition) and +3.7 KB RAM. Built only, not run on a V4 board.

Heltec V3, ESP32-S3:

Stock `Heltec_v3_companion_radio_wifi`: 1,109,065 bytes flash, 174,704 bytes RAM. With the web UI: 1,193,417 bytes flash
(+84 KB, 35.7 % of the app partition), 178,420 bytes RAM (+3.7 KB static). The page is 23.9 KB, 8.4 KB gzipped.

## Editing the page

`index.html` and `proto.js` are the sources. After a change run `python3 scripts/gen_webui.py`, which writes
`src/helpers/wifi/WebUiPage.h` (the gzipped page as a byte array). `gen_webui.py --check` fails if the header is stale.

## Tests

- `node test/decode_fixtures.js`: decodes frames captured from the stock companion firmware run on a host
  (`test/fixtures.json`) and checks every field.
- The fixtures, and the encoder checks (frames the page sends are accepted by the stock firmware), are produced by
  `oracle/compare_webui.py` in the meshnode repo. `oracle/test_webui_e2e.py` there drives the page in a headless browser
  against the stock companion code through a WebSocket bridge (16 checks: connect, lists, receive, send, delivery
  confirmation, channels, hostile names, reconnect).
- Frame layouts that are newer than the hosted 1.17.1 firmware (the console, command 66) are checked against the
  source of this tree instead.
