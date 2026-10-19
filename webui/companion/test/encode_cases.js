// Prints the frames the page sends for fixed inputs, as {name: hex}, for the oracle to accept or refuse.
'use strict';
const MC = require('../proto.js');
const h = (f) => Buffer.from(f).toString('hex');
const key = '22'.repeat(32), T = 1700000200;
console.log(JSON.stringify({
  device_query: h(MC.enc.deviceQuery()),
  app_start: h(MC.enc.appStart('web')),
  get_contacts: h(MC.enc.getContacts(0)),
  get_contacts_since: h(MC.enc.getContacts(5)),
  sync_next: h(MC.enc.syncNext()),
  get_time: h(MC.enc.getTime()),
  set_time: h(MC.enc.setTime(T)),
  advert_zero_hop: h(MC.enc.advert(false)),
  advert_flood: h(MC.enc.advert(true)),
  battery: h(MC.enc.battery()),
  get_channel_1: h(MC.enc.getChannel(1)),
  send_text: h(MC.enc.sendText(key, 'hello', T, 0)),
  send_text_utf8_clip: h(MC.enc.sendText(key, 'é'.repeat(100), T, 0)),
  send_channel: h(MC.enc.sendChannel(1, 'hi all', T)),
  cli_get_name: h(MC.enc.cli('get name')),
}));
