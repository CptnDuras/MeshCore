# Companion web UI

A chat page served by the node itself over WiFi. Open `http://<node-ip>/`, sign in as `admin`, and you get channels,
contacts, send/receive with delivery confirmation, node info, advert buttons and a command console. No phone app, no
internet, nothing loaded from outside the node.

## How it works

The page talks to the node over a WebSocket at `/ws`. One binary WebSocket message is one companion-protocol frame:
the same bytes the phone apps exchange over BLE, USB or TCP port 5000, without the length header. The firmware side
(`src/helpers/wifi/WebUiInterface.*`) is one more `BaseSerialInterface` registered in the `MultiSerialInterface`, so
the companion code needed no changes to support it. The page's protocol code is `src/proto.js`.

The web UI runs next to TCP port 5000 and BLE, it does not replace them.

## Turn it on

1. Build an env with `-D WITH_WEBUI` and `ENABLE_WIFI_INTERFACE`. Ready-made: `Heltec_v3_companion_radio_wifi_web`,
   `heltec_v4_companion_radio_wifi_web`, `heltec_v4_tft_companion_radio_wifi_web`,
   `heltec_v4_r8_companion_radio_wifi_web`, `heltec_v4_r8_tft_companion_radio_wifi_web`.
2. Give the node WiFi (from the phone app console, a terminal on the USB serial port at 115200 baud, or build flags):
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
(+84 KB, 35.7 % of the app partition), 178,420 bytes RAM (+3.7 KB static). The page is about 178 KB, 50 KB gzipped (+42 KB of flash on the V4).

## What is in the page

Sections (side rail on a computer, tab bar on a phone): **Channels** (list, add, join hashtag / private / public, edit,
delete, communities, regions, replies, reactions), **Contacts** (search, filter, sort, groups, favourites, direct messages
with delivery status and automatic retries, rooms, discovered nodes, import and share links, route reset and discovery),
a **repeater hub** (sign in, status, neighbours, sensors, the routing features of this firmware, a console), **Tools**
(ping, discover, radio statistics, node console, sensors) and **Settings** (name, position, radio with presets, route
detail, privacy, automatic adding, regions, clock, GPX export, and per-browser preferences).

A **Map** of nodes with a position, and a **Planner** (`geo.js` engine, `slippy.js` map, `v-plan.js` view): it estimates what the
repeaters you can hear cover and suggests where new ones would add the most, from terrain and a radio model (free-space loss plus
knife-edge diffraction over the worst ridge, earth radius factor as in the MeshCore app, a flat allowance for trees and buildings). Like the app, coverage by default means a clear line of sight from the antenna to a handheld (ground below the straight line, earth curve included); paths over a ridge, 60% Fresnel clearance and a noise margin are options. Range goes to 300 km and large areas load coarser terrain instead of failing. Terrain tiles come
from Mapterhorn over the internet, like the map tiles. It is an estimate: check a site on the ground. A plan (planned sites, which
repeaters are used, antenna heights and the radio settings) exports to a JSON file (`app: "meshcore-planner"`) and imports back
(the file is checked first: positions, heights and settings are validated); the map with the coverage saves as a PNG with a caption,
legend and attribution. Message text containing
coordinates or map links gets a button that opens the place on the map.

Not in yet: path trace, QR codes and camera scanning (the page is served over plain http, where browsers do not
offer the camera or the clipboard API; copy and paste text instead), image messages, translation.

## Editing the page

The sources are in `src/`: `index.html` (template), `style.css`, and the scripts listed in order in `scripts/gen_webui.py`
(`proto.js` codec, `crypto.js` SHA-256/HMAC, `core.js` link and messaging engine, `ui.js` toolkit, one file per view).
After a change run `python3 scripts/gen_webui.py`, which writes `src/helpers/wifi/WebUiPage.h` (the gzipped page as a byte
array). `gen_webui.py --check` fails if the header is stale; `--html FILE` writes the plain page for the browser tests.

## Tests

- `node test/decode_fixtures.js`: decodes frames captured from the stock companion firmware run on a host
  (`test/fixtures.json`) and checks every field.
- The fixtures, and the encoder checks (frames the page sends are accepted by the stock firmware), are produced by
  `oracle/compare_webui.py` in the meshnode repo. `oracle/test_webui_e2e.py` there drives the page in a headless browser
  against the stock companion code through a WebSocket bridge (22 checks: connect, a long contact list, channels, search, receive,
  send, delivery confirmation, hostile names, settings, console, statistics, reconnect).
- `node test/plan_engine.js`: the planner's engine on made-up terrain (free-space loss on flat ground, a ridge's shadow, earth
  curvature, link profiles, candidate sites, tile stitching).
- Frame layouts that are newer than the hosted 1.17.1 firmware (the console, command 66) are checked against the
  source of this tree instead.
