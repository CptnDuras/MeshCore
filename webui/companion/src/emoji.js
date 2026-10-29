// :shortcode: to emoji. Only names in the table change; anything else is left as typed (":10:30:" is a time, not a code).
(function (root) {
  'use strict';
  var TABLE = 'smile=😄 grin=😁 grinning=😀 smiley=😃 laughing=😆 joy=😂 rofl=🤣 sweat_smile=😅 wink=😉 blush=😊 innocent=😇 slight_smile=🙂 ' +
    'upside_down=🙃 relaxed=☺️ yum=😋 heart_eyes=😍 kissing_heart=😘 star_struck=🤩 stuck_out_tongue=😛 stuck_out_tongue_winking_eye=😜 ' +
    'zany=🤪 money_mouth=🤑 hugs=🤗 thinking=🤔 zipper_mouth=🤐 raised_eyebrow=🤨 neutral=😐 expressionless=😑 no_mouth=😶 smirk=😏 ' +
    'unamused=😒 roll_eyes=🙄 grimacing=😬 relieved=😌 pensive=😔 sleepy=😪 sleeping=😴 mask=😷 sick=🤢 sneeze=🤧 hot=🥵 cold=🥶 ' +
    'dizzy_face=😵 exploding_head=🤯 cowboy=🤠 partying=🥳 sunglasses=😎 nerd=🤓 confused=😕 worried=😟 slight_frown=🙁 frowning=☹️ ' +
    'open_mouth=😮 hushed=😯 astonished=😲 flushed=😳 pleading=🥺 fearful=😨 cold_sweat=😰 cry=😢 sob=😭 scream=😱 confounded=😖 ' +
    'disappointed=😞 sweat=😓 weary=😩 tired=😫 yawn=🥱 triumph=😤 rage=😡 angry=😠 cursing=🤬 smiling_imp=😈 imp=👿 skull=💀 ' +
    'poop=💩 clown=🤡 ghost=👻 alien=👽 robot=🤖 see_no_evil=🙈 hear_no_evil=🙉 speak_no_evil=🙊 ' +
    '+1=👍 thumbsup=👍 -1=👎 thumbsdown=👎 ok_hand=👌 pinched=🤌 v=✌️ crossed_fingers=🤞 metal=🤘 call_me=🤙 point_left=👈 ' +
    'point_right=👉 point_up=👆 point_down=👇 raised_hand=✋ wave=👋 clap=👏 raised_hands=🙌 open_hands=👐 pray=🙏 handshake=🤝 ' +
    'muscle=💪 fist=✊ punch=👊 writing_hand=✍️ eyes=👀 eye=👁️ brain=🧠 tongue=👅 lips=👄 ' +
    'heart=❤️ orange_heart=🧡 yellow_heart=💛 green_heart=💚 blue_heart=💙 purple_heart=💜 black_heart=🖤 white_heart=🤍 ' +
    'broken_heart=💔 two_hearts=💕 sparkling_heart=💖 heartbeat=💓 heartpulse=💗 revolving_hearts=💞 love_letter=💌 kiss=💋 ' +
    '100=💯 boom=💥 sparkles=✨ star=⭐ star2=🌟 zap=⚡ fire=🔥 droplet=💧 sweat_drops=💦 dash=💨 tada=🎉 confetti=🎊 balloon=🎈 ' +
    'gift=🎁 trophy=🏆 medal=🏅 crown=👑 gem=💎 bell=🔔 mega=📣 loudspeaker=📢 speech_balloon=💬 thought_balloon=💭 zzz=💤 ' +
    'check=✅ white_check_mark=✅ x=❌ warning=⚠️ no_entry=⛔ stop=🛑 question=❓ exclamation=❗ bangbang=‼️ info=ℹ️ ' +
    'sun=☀️ cloud=☁️ partly_sunny=⛅ rain=🌧️ umbrella=☔ snowflake=❄️ snowman=⛄ rainbow=🌈 moon=🌙 full_moon=🌕 earth=🌍 ' +
    'ocean=🌊 mountain=⛰️ volcano=🌋 tent=⛺ camping=🏕️ evergreen=🌲 tree=🌳 palm=🌴 cactus=🌵 herb=🌿 four_leaf_clover=🍀 ' +
    'leaves=🍃 rose=🌹 sunflower=🌻 tulip=🌷 blossom=🌼 mushroom=🍄 ' +
    'dog=🐶 cat=🐱 mouse=🐭 rabbit=🐰 fox=🦊 bear=🐻 panda=🐼 koala=🐨 tiger=🐯 lion=🦁 cow=🐮 pig=🐷 frog=🐸 monkey=🐵 ' +
    'chicken=🐔 penguin=🐧 bird=🐦 eagle=🦅 owl=🦉 bat=🦇 wolf=🐺 horse=🐴 unicorn=🦄 bee=🐝 bug=🐛 butterfly=🦋 snail=🐌 ' +
    'turtle=🐢 snake=🐍 octopus=🐙 fish=🐟 dolphin=🐬 whale=🐳 shark=🦈 crab=🦀 ' +
    'apple=🍎 banana=🍌 grapes=🍇 strawberry=🍓 lemon=🍋 peach=🍑 avocado=🥑 pizza=🍕 hamburger=🍔 fries=🍟 hotdog=🌭 taco=🌮 ' +
    'popcorn=🍿 cake=🍰 cookie=🍪 donut=🍩 chocolate=🍫 candy=🍬 coffee=☕ tea=🍵 beer=🍺 beers=🍻 wine=🍷 cocktail=🍸 ' +
    'car=🚗 taxi=🚕 bus=🚌 truck=🚚 bike=🚲 motorcycle=🏍️ train=🚆 airplane=✈️ rocket=🚀 helicopter=🚁 boat=⛵ ship=🚢 anchor=⚓ ' +
    'house=🏠 office=🏢 tent2=🎪 hospital=🏥 school=🏫 church=⛪ ' +
    'phone=📱 computer=💻 keyboard=⌨️ battery=🔋 plug=🔌 bulb=💡 flashlight=🔦 satellite=📡 antenna=📶 radio=📻 tv=📺 camera=📷 ' +
    'video_camera=📹 mag=🔍 lock=🔒 unlock=🔓 key=🔑 wrench=🔧 hammer=🔨 gear=⚙️ link=🔗 pushpin=📌 paperclip=📎 memo=📝 book=📖 ' +
    'calendar=📅 chart=📈 clipboard=📋 package=📦 mailbox=📫 email=📧 bomb=💣 compass=🧭 map=🗺️ pin=📍 flag=🚩 ' +
    'soccer=⚽ basketball=🏀 football=🏈 baseball=⚾ tennis=🎾 golf=⛳ ski=🎿 surfer=🏄 swimmer=🏊 running=🏃 hiking=🥾 ' +
    'guitar=🎸 music=🎵 notes=🎶 microphone=🎤 headphones=🎧 art=🎨 dice=🎲 video_game=🎮 ' +
    'arrow_up=⬆️ arrow_down=⬇️ arrow_left=⬅️ arrow_right=➡️ recycle=♻️ infinity=♾️ peace=☮️ yin_yang=☯️';
  var map = null;

  function load() {
    map = {};
    TABLE.split(' ').forEach(function (p) { var i = p.indexOf('='); map[p.slice(0, i)] = p.slice(i + 1); });
  }
  // every complete :name: that is in the table; names are letters, digits, _ + -
  function replace(text) {
    if (!map) load();
    return String(text).replace(/:([a-z0-9_+-]+):/gi, function (all, name) {
      var e = map[name.toLowerCase()];
      return e === undefined ? all : e;
    });
  }
  // the names that start with `prefix`, for a picker (at most `max`)
  function find(prefix, max) {
    if (!map) load();
    var p = String(prefix).toLowerCase(), out = [];
    for (var k in map) if (k.indexOf(p) === 0) { out.push(k); if (out.length >= max) break; }
    return out;
  }
  root.Emoji = { replace: replace, find: find, get: function (n) { if (!map) load(); return map[String(n).toLowerCase()]; } };
})(window);
