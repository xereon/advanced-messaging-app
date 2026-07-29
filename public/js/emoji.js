// emoji.js — the emoji picker: categories, search, and what you used recently.
//
// A hand-picked set rather than the whole of Unicode. Every entry carries the
// words somebody would actually type to find it, because a picker you have to
// scroll is a picker you stop using — and searching "thanks" should find 🙏
// even though that is not its Unicode name.
//
// Kept out of ui.js so the data does not drown the code that uses it.

export const CATEGORIES = [
  {
    id: 'recent', name: 'Recent', icon: '🕘', emoji: [],
  },
  {
    id: 'people',
    name: 'Smileys and people',
    icon: '🙂',
    emoji: [
      ['😀', 'grin happy smile'], ['😃', 'smile happy'], ['😄', 'smile laugh happy'],
      ['😁', 'beam grin'], ['😆', 'laugh squint'], ['😅', 'sweat laugh relief phew'],
      ['🤣', 'rofl laughing floor'], ['😂', 'tears joy laughing crying'],
      ['🙂', 'slight smile'], ['🙃', 'upside down silly'], ['😉', 'wink'],
      ['😊', 'blush smile happy'], ['😇', 'halo angel innocent'],
      ['🥰', 'love hearts adore'], ['😍', 'heart eyes love'], ['😘', 'kiss'],
      ['😗', 'kissing'], ['😚', 'kissing closed'], ['🤗', 'hug hugging'],
      ['🤩', 'star struck excited wow'], ['🤔', 'thinking hmm think'],
      ['🤨', 'raised eyebrow sceptical suspicious'], ['😐', 'neutral straight face'],
      ['😑', 'expressionless blank'], ['😶', 'no mouth silent speechless'],
      ['🙄', 'eye roll rolling eyes'], ['😏', 'smirk sly'], ['😣', 'persevere struggle'],
      ['😥', 'sad relieved disappointed'], ['😮', 'open mouth surprised oh'],
      ['🤐', 'zipper mouth quiet secret'], ['😯', 'hushed surprised'],
      ['😪', 'sleepy tired'], ['😫', 'tired weary exhausted'], ['🥱', 'yawn bored tired'],
      ['😴', 'sleeping asleep zzz'], ['😌', 'relieved calm content'],
      ['😛', 'tongue playful'], ['😜', 'wink tongue cheeky'], ['🤪', 'zany silly wild'],
      ['🤤', 'drooling'], ['😒', 'unamused unimpressed'], ['😓', 'downcast sweat'],
      ['😔', 'pensive sad down'], ['😕', 'confused unsure'], ['🙁', 'frown slight sad'],
      ['☹️', 'frowning sad'], ['😖', 'confounded frustrated'], ['😞', 'disappointed sad'],
      ['😟', 'worried concerned'], ['😤', 'triumph steam determined'],
      ['😢', 'cry sad tear'], ['😭', 'sob crying loudly'], ['😦', 'frowning open mouth'],
      ['😧', 'anguished'], ['😨', 'fearful scared'], ['😩', 'weary tired'],
      ['🤯', 'mind blown exploding head shocked'], ['😬', 'grimace awkward yikes'],
      ['😰', 'anxious sweat nervous'], ['😱', 'scream shocked fear'],
      ['🥵', 'hot heat overheated'], ['🥶', 'cold freezing'], ['😳', 'flushed embarrassed'],
      ['😵', 'dizzy knocked out'], ['🥴', 'woozy'],
      ['😠', 'angry annoyed'], ['😡', 'rage furious very angry'],
      ['🤬', 'swearing cursing symbols'], ['😷', 'mask ill sick'],
      ['🤒', 'thermometer ill sick'], ['🤕', 'bandage hurt injured'],
      ['🤢', 'nauseated sick'], ['🤮', 'vomiting sick'], ['🤧', 'sneezing tissue'],
      ['🥳', 'party celebrate hat'], ['🥺', 'pleading please puppy eyes'],
      ['😎', 'cool sunglasses'], ['🤓', 'nerd glasses'], ['🧐', 'monocle inspect'],
      ['🤠', 'cowboy'], ['👋', 'wave hello hi bye'], ['🤝', 'handshake deal agree'],
      ['👍', 'thumbs up yes good approve like'], ['👎', 'thumbs down no bad'],
      ['👏', 'clap applause well done'], ['🙌', 'raised hands celebrate praise'],
      ['🙏', 'pray thanks please thank you'], ['💪', 'muscle strong flex'],
      ['✌️', 'peace victory'], ['🤞', 'fingers crossed hope luck'],
      ['👌', 'ok perfect'], ['🤙', 'call me shaka'], ['👀', 'eyes look looking'],
      ['🫡', 'salute yes sir'], ['🤷', 'shrug dunno no idea'], ['🤦', 'facepalm'],
    ],
  },
  {
    id: 'nature',
    name: 'Animals and nature',
    icon: '🌿',
    emoji: [
      ['🐶', 'dog puppy'], ['🐱', 'cat kitten'], ['🐭', 'mouse'], ['🐹', 'hamster'],
      ['🐰', 'rabbit bunny'], ['🦊', 'fox'], ['🐻', 'bear'], ['🐼', 'panda'],
      ['🐨', 'koala'], ['🐯', 'tiger'], ['🦁', 'lion'], ['🐮', 'cow'], ['🐷', 'pig'],
      ['🐸', 'frog'], ['🐵', 'monkey'], ['🐔', 'chicken'], ['🐧', 'penguin'],
      ['🐦', 'bird'], ['🦆', 'duck'], ['🦉', 'owl'], ['🐴', 'horse'], ['🦄', 'unicorn'],
      ['🐝', 'bee'], ['🐛', 'bug caterpillar'], ['🦋', 'butterfly'], ['🐌', 'snail slow'],
      ['🐞', 'ladybird beetle'], ['🕷️', 'spider'], ['🐢', 'turtle tortoise slow'],
      ['🐍', 'snake'], ['🐙', 'octopus'], ['🦑', 'squid'], ['🦐', 'shrimp'],
      ['🐠', 'fish tropical'], ['🐬', 'dolphin'], ['🐳', 'whale'], ['🦈', 'shark'],
      ['🐊', 'crocodile'], ['🦓', 'zebra'], ['🦍', 'gorilla'], ['🐘', 'elephant'],
      ['🌵', 'cactus'], ['🌲', 'tree evergreen'], ['🌳', 'tree'], ['🌴', 'palm tree'],
      ['🌱', 'seedling sprout growth'], ['🌿', 'herb leaves plant'], ['☘️', 'shamrock'],
      ['🍀', 'four leaf clover luck'], ['🍁', 'maple leaf autumn'], ['🍂', 'fallen leaves'],
      ['🌷', 'tulip'], ['🌹', 'rose'], ['🌺', 'hibiscus'], ['🌻', 'sunflower'],
      ['🌼', 'blossom flower'], ['🌸', 'cherry blossom'], ['💐', 'bouquet flowers'],
      ['🌞', 'sun sunny'], ['🌝', 'moon face'], ['🌚', 'new moon face'],
      ['⭐', 'star'], ['🌟', 'glowing star sparkle'], ['✨', 'sparkles magic'],
      ['⚡', 'lightning zap fast'], ['🔥', 'fire hot lit'], ['🌈', 'rainbow'],
      ['☀️', 'sun clear'], ['⛅', 'partly cloudy'], ['☁️', 'cloud cloudy'],
      ['🌧️', 'rain raining'], ['⛈️', 'storm thunder'], ['❄️', 'snowflake cold snow'],
      ['💧', 'droplet water'], ['🌊', 'wave ocean sea'],
    ],
  },
  {
    id: 'food',
    name: 'Food and drink',
    icon: '🍕',
    emoji: [
      ['🍏', 'apple green'], ['🍎', 'apple red'], ['🍐', 'pear'], ['🍊', 'orange'],
      ['🍋', 'lemon'], ['🍌', 'banana'], ['🍉', 'watermelon'], ['🍇', 'grapes'],
      ['🍓', 'strawberry'], ['🫐', 'blueberries'], ['🍒', 'cherries'], ['🍑', 'peach'],
      ['🥭', 'mango'], ['🍍', 'pineapple'], ['🥥', 'coconut'], ['🥝', 'kiwi'],
      ['🍅', 'tomato'], ['🥑', 'avocado'], ['🥦', 'broccoli'], ['🥕', 'carrot'],
      ['🌽', 'corn'], ['🥔', 'potato'], ['🍞', 'bread'], ['🥐', 'croissant'],
      ['🥨', 'pretzel'], ['🧇', 'waffle'], ['🥞', 'pancakes'], ['🧀', 'cheese'],
      ['🍗', 'chicken leg'], ['🥓', 'bacon'], ['🍔', 'burger hamburger'],
      ['🍟', 'chips fries'], ['🍕', 'pizza'], ['🌭', 'hot dog'], ['🥪', 'sandwich'],
      ['🌮', 'taco'], ['🌯', 'burrito wrap'], ['🥗', 'salad'], ['🍝', 'pasta spaghetti'],
      ['🍜', 'noodles ramen'], ['🍣', 'sushi'], ['🍤', 'prawn tempura'],
      ['🍚', 'rice'], ['🍛', 'curry'], ['🥘', 'paella pan'], ['🍲', 'stew'],
      ['🍦', 'ice cream'], ['🍩', 'doughnut'], ['🍪', 'biscuit cookie'],
      ['🎂', 'birthday cake'], ['🍰', 'cake slice'], ['🧁', 'cupcake'],
      ['🍫', 'chocolate'], ['🍬', 'sweet candy'], ['🍿', 'popcorn'],
      ['☕', 'coffee tea hot drink'], ['🍵', 'green tea'], ['🧃', 'juice box'],
      ['🥤', 'soft drink cup'], ['🍺', 'beer pint'], ['🍻', 'beers cheers'],
      ['🥂', 'clink glasses celebrate'], ['🍷', 'wine'], ['🥃', 'whisky'],
      ['🍾', 'champagne celebrate'], ['🧊', 'ice cube'],
    ],
  },
  {
    id: 'activity',
    name: 'Activity and travel',
    icon: '⚽',
    emoji: [
      ['⚽', 'football soccer'], ['🏀', 'basketball'], ['🏈', 'american football'],
      ['⚾', 'baseball'], ['🎾', 'tennis'], ['🏐', 'volleyball'], ['🏉', 'rugby'],
      ['🎱', 'pool billiards eight ball'], ['🏓', 'table tennis ping pong'],
      ['🏸', 'badminton'], ['🥊', 'boxing glove'], ['⛳', 'golf'], ['🎣', 'fishing'],
      ['🎯', 'target bullseye darts'], ['🎲', 'dice game'], ['🎮', 'gaming controller'],
      ['🕹️', 'joystick'], ['🎸', 'guitar'], ['🎹', 'piano keyboard'],
      ['🎺', 'trumpet'], ['🎻', 'violin'], ['🥁', 'drum'], ['🎤', 'microphone sing'],
      ['🎧', 'headphones music'], ['🎬', 'clapper film movie'], ['🎨', 'art palette'],
      ['🏆', 'trophy win'], ['🥇', 'gold medal first'], ['🥈', 'silver medal second'],
      ['🥉', 'bronze medal third'], ['🎖️', 'medal'], ['🎪', 'circus tent'],
      ['🚗', 'car'], ['🚕', 'taxi'], ['🚌', 'bus'], ['🚑', 'ambulance'],
      ['🚓', 'police car'], ['🚒', 'fire engine'], ['🚲', 'bicycle bike'],
      ['🛴', 'scooter'], ['🏍️', 'motorbike'], ['✈️', 'plane flight travel'],
      ['🚀', 'rocket launch ship'], ['🛰️', 'satellite'], ['🚁', 'helicopter'],
      ['⛵', 'sailing boat'], ['🚢', 'ship'], ['🚂', 'train steam'],
      ['🚇', 'metro underground'], ['🗺️', 'map'], ['🧭', 'compass'],
      ['🏝️', 'desert island holiday'], ['🏔️', 'mountain snow'], ['🗻', 'mount fuji'],
      ['🏕️', 'camping tent'], ['🎡', 'ferris wheel'], ['🎢', 'roller coaster'],
      ['🏰', 'castle'], ['🗽', 'statue of liberty'], ['🌍', 'earth globe world'],
    ],
  },
  {
    id: 'objects',
    name: 'Objects',
    icon: '💡',
    emoji: [
      ['💻', 'laptop computer'], ['🖥️', 'desktop computer monitor'],
      ['⌨️', 'keyboard'], ['🖱️', 'mouse computer'], ['🖨️', 'printer'],
      ['📱', 'phone mobile'], ['☎️', 'telephone'], ['📞', 'phone receiver call'],
      ['📷', 'camera photo'], ['📹', 'video camera'], ['🔋', 'battery'],
      ['🔌', 'plug power'], ['💡', 'idea light bulb'], ['🔍', 'search magnify'],
      ['🔒', 'lock secure locked'], ['🔓', 'unlocked'], ['🔑', 'key'],
      ['🔨', 'hammer'], ['🔧', 'spanner wrench fix'], ['⚙️', 'gear settings cog'],
      ['🧰', 'toolbox tools'], ['🧲', 'magnet'], ['🧪', 'test tube experiment'],
      ['🔬', 'microscope'], ['🔭', 'telescope'], ['💊', 'pill medicine'],
      ['🩹', 'plaster bandage'], ['🚪', 'door'], ['🛏️', 'bed'], ['🚿', 'shower'],
      ['🧹', 'broom clean'], ['🧺', 'basket laundry'], ['🎁', 'gift present'],
      ['🎈', 'balloon'], ['🎉', 'party popper celebrate hooray'],
      ['🎊', 'confetti celebrate'], ['🪄', 'magic wand'], ['📚', 'books reading'],
      ['📖', 'open book'], ['📝', 'memo note writing'], ['✏️', 'pencil write'],
      ['📌', 'pin'], ['📎', 'paperclip attachment'], ['📋', 'clipboard'],
      ['📅', 'calendar date'], ['📆', 'calendar'], ['⏰', 'alarm clock'],
      ['⏳', 'hourglass waiting'], ['📈', 'chart up growth increase'],
      ['📉', 'chart down decrease'], ['📊', 'bar chart stats'], ['💰', 'money bag'],
      ['💳', 'card payment'], ['🧾', 'receipt invoice'], ['✉️', 'envelope email'],
      ['📨', 'incoming mail'], ['📦', 'package parcel box'], ['🗑️', 'bin trash delete'],
      ['🔔', 'bell notification'], ['🔇', 'muted silent'], ['🏳️', 'white flag'],
    ],
  },
  {
    id: 'symbols',
    name: 'Symbols',
    icon: '✅',
    emoji: [
      ['❤️', 'red heart love'], ['🧡', 'orange heart'], ['💛', 'yellow heart'],
      ['💚', 'green heart'], ['💙', 'blue heart'], ['💜', 'purple heart'],
      ['🖤', 'black heart'], ['🤍', 'white heart'], ['💔', 'broken heart'],
      ['💕', 'two hearts'], ['💯', 'hundred perfect score'], ['💢', 'anger'],
      ['💥', 'collision boom'], ['💨', 'dash fast'], ['💫', 'dizzy star'],
      ['✅', 'tick check done yes complete'], ['☑️', 'ballot tick checkbox'],
      ['✔️', 'tick check'], ['❌', 'cross no wrong'], ['❎', 'cross mark'],
      ['⭕', 'circle'], ['❗', 'exclamation important'], ['❓', 'question'],
      ['⚠️', 'warning caution'], ['🚫', 'prohibited forbidden no'],
      ['♻️', 'recycle'], ['🔄', 'refresh repeat sync'], ['🔁', 'repeat loop'],
      ['▶️', 'play'], ['⏸️', 'pause'], ['⏹️', 'stop'], ['⏭️', 'next skip'],
      ['🔺', 'up triangle'], ['🔻', 'down triangle'], ['🔴', 'red circle'],
      ['🟠', 'orange circle'], ['🟡', 'yellow circle'], ['🟢', 'green circle'],
      ['🔵', 'blue circle'], ['🟣', 'purple circle'], ['⚫', 'black circle'],
      ['⚪', 'white circle'], ['🔶', 'orange diamond'], ['🔷', 'blue diamond'],
      ['➕', 'plus add'], ['➖', 'minus subtract'], ['✖️', 'multiply times'],
      ['➗', 'divide'], ['🟰', 'equals'], ['💲', 'dollar'], ['™️', 'trademark'],
      ['©️', 'copyright'], ['®️', 'registered'], ['#️⃣', 'hash'], ['*️⃣', 'asterisk'],
      ['🆗', 'ok'], ['🆕', 'new'], ['🆙', 'up'], ['🔝', 'top'], ['🔜', 'soon'],
      ['💬', 'speech bubble message chat'], ['💭', 'thought bubble'],
      ['🗯️', 'anger bubble'], ['👁️‍🗨️', 'eye in speech'],
    ],
  },
];

/** The quick row that appears before the full picker is opened. */
export const QUICK_REACTIONS = ['👍', '❤️', '😂', '🎉', '😮', '😢', '🙏', '👎'];

const RECENT_KEY = 'relay.emoji.recent';
const RECENT_MAX = 24;

export function recentEmoji() {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    return Array.isArray(list) ? list.filter((e) => typeof e === 'string').slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

/** Most recent first, no duplicates. */
export function rememberEmoji(emoji) {
  try {
    const next = [emoji, ...recentEmoji().filter((e) => e !== emoji)].slice(0, RECENT_MAX);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch { /* private mode */ }
}

/**
 * Search across every category.
 *
 * Matches the start of any keyword rather than anywhere inside one, so "an"
 * finds "angry" and "animal" but not "banana" — a substring match on short
 * queries returns almost everything, which is the same as returning nothing.
 */
export function searchEmoji(query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  const seen = new Set();
  const out = [];
  for (const cat of CATEGORIES) {
    for (const [emoji, keywords] of cat.emoji) {
      if (seen.has(emoji)) continue;
      const words = keywords.split(/\s+/);
      if (words.some((w) => w.startsWith(q))) {
        seen.add(emoji);
        out.push(emoji);
      }
    }
  }
  return out;
}

/** Every emoji in one flat list, for the "all" view. */
export const allEmoji = () => CATEGORIES.flatMap((c) => c.emoji.map(([e]) => e));
