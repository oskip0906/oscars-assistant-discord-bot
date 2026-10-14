// Chat shorthand Panda knows and may drop into replies, so it reads like a
// friend in the server rather than a help desk. The persona itself lives in the
// database (soul.md); this is only the word list, shown in the system prompt.
//
// Kept friendly: no slurs or insults. No entry may start with a command or
// mention character (/ ! @ # < :) or be a sign-off, since Panda saying "ttyl"
// would end a conversation with another bot (FAREWELL_RE in messageHandler.js).
export const SLANG = {
  lol: 'laughing',
  lmao: 'laughing hard',
  ngl: 'not gonna lie',
  tbh: 'to be honest',
  fr: 'for real',
  istg: 'I swear to god',
  imo: 'in my opinion',
  idk: "I don't know",
  idc: "I don't care",
  iirc: 'if I remember correctly',
  afaik: 'as far as I know',
  rn: 'right now',
  btw: 'by the way',
  fyi: 'for your info',
  ofc: 'of course',
  nvm: 'never mind',
  smh: 'shaking my head',
  ikr: 'I know, right',
  icl: "I can't lie",
  lowkey: 'kind of, quietly',
  highkey: 'very much, openly',
  bet: 'okay, deal',
  'no cap': 'honestly, no lie',
  valid: 'fair, makes sense',
  mid: 'just okay, average',
  goated: 'the best at it',
  w: 'a win',
  l: 'a loss',
  ate: 'did it really well',
  'its giving': 'it feels like',
  vibe: 'the mood',
  'vibe check': 'how is everyone feeling',
  sus: 'suspicious',
  bussin: 'really good (food)',
  slaps: 'is really good (music, food)',
  'hits different': 'feels special',
  'main character': 'the one in the spotlight',
  'say less': 'got it, on it',
  real: 'relatable, true',
  ong: 'on god, for real',
  tysm: 'thank you so much',
  np: 'no problem',
  yw: "you're welcome",
  ez: 'easy',
  ggs: 'good games',
  wyd: 'what are you doing',
  hbu: 'how about you',
  wbu: 'what about you',
  imy: 'I miss you',
  omw: 'on my way',
  tmi: 'too much info',
  ftw: 'for the win',
  pog: 'awesome',
  based: 'confidently yourself',
  cooked: 'in trouble, done for',
  'locked in': 'fully focused',
};

// One line of entries for the system prompt.
export function vocabularyNote(slang = SLANG) {
  return Object.entries(slang)
    .map(([word, meaning]) => `${word} (${meaning})`)
    .join(', ');
}
