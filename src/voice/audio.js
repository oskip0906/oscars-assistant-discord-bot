// Voice mode's audio and text helpers. Pure functions, no I/O.

const HAS_WORDS = /[\p{L}\p{N}]/u;

// Raw 16-bit PCM wrapped as a WAV file: the 44-byte header, then the samples.
export function wav(pcm, { sampleRate, channels }) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); // size of the fmt chunk
  header.writeUInt16LE(1, 20); // plain PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

// Interleaved 16-bit stereo to mono: the average of the two channels.
export function toMono(pcm) {
  const frames = pcm.length >> 2;
  const mono = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) mono.writeInt16LE((pcm.readInt16LE(i * 4) + pcm.readInt16LE(i * 4 + 2)) >> 1, i * 2);
  return mono;
}

// A 16-bit PCM WAV as what Discord plays raw: 48 kHz stereo, s16le. The header
// is read chunk by chunk, not assumed to be 44 bytes; resampling is linear.
export function wavToDiscordPcm(file) {
  if (file.length < 12 || file.toString('latin1', 0, 4) !== 'RIFF' || file.toString('latin1', 8, 12) !== 'WAVE') throw new Error('not a WAV file');
  let fmt = null;
  let data = null;
  for (let at = 12; at + 8 <= file.length && !data; ) {
    const id = file.toString('latin1', at, at + 4);
    const size = file.readUInt32LE(at + 4);
    const body = at + 8;
    if (id === 'fmt ') fmt = { channels: file.readUInt16LE(body + 2), rate: file.readUInt32LE(body + 4), bits: file.readUInt16LE(body + 14) };
    // A size past the end of the file (a streamed WAV) just means "the rest".
    if (id === 'data') data = file.subarray(body, Math.min(file.length, body + size));
    at = body + size + (size & 1); // chunks are padded to an even length
  }
  if (!fmt || !data) throw new Error('WAV has no fmt or data chunk');
  if (fmt.bits !== 16) throw new Error(`expected 16-bit WAV, got ${fmt.bits}-bit`);

  const { channels, rate } = fmt;
  const frames = Math.floor(data.length / (2 * channels));
  const outFrames = Math.floor((frames * 48000) / rate);
  const out = Buffer.alloc(outFrames * 4);
  // A mono file plays the same in both ears.
  const sample = (frame, channel) => data.readInt16LE((frame * channels + Math.min(channel, channels - 1)) * 2);
  for (let j = 0; j < outFrames; j++) {
    const pos = (j * rate) / 48000;
    const i = Math.floor(pos);
    const next = Math.min(i + 1, frames - 1);
    for (let c = 0; c < 2; c++) {
      const a = sample(i, c);
      out.writeInt16LE(Math.round(a + (sample(next, c) - a) * (pos - i)), j * 4 + c * 2);
    }
  }
  return out;
}

// Sentence by sentence, punctuation kept: a split at . ! or ? followed by
// whitespace, so "version 3.5" stays whole.
export const sentences = (text) =>
  String(text ?? '')
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

const MAX_SENTENCES = 3;
const MAX_CHARS = 600;

// The start of a reply as it should sound: markdown, links, code and mentions
// removed, then at most 3 sentences and 600 characters. '' when nothing is
// left to say.
export function spokenPart(text) {
  const plain = String(text ?? '')
    .replace(/```[\s\S]*?(?:```|$)/g, ' ') // fenced code, even if never closed
    .split('\n')
    .filter((line) => !/^\s*-# /.test(line)) // Discord's small grey subtext
    .map((line) => line.replace(/^\s*(?:#{1,6}\s+|>+\s?|[-*+]\s+|\d{1,2}[.)]\s+)/, '')) // heading, quote, bullet
    .join(' ')
    .replace(/<(?:https?:\/\/[^>\s]*|@[!&]?\d+|#\d+|a?:\w+:\d+)>/g, ' ') // <link>, mentions, custom emoji
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // [label](url) is just its label
    .replace(/https?:\/\/\S*[^\s.,;:!?)\]"']/g, ' ') // a bare link, but not the punctuation that ends the sentence
    .replace(/`|\*|~~|__/g, '')
    .replace(/\s+/g, ' ')
    .replace(/ ([,.!?;:])/g, '$1') // what a removed link or mention leaves behind
    .trim();
  const parts = sentences(plain)
    .filter((s) => HAS_WORDS.test(s))
    .slice(0, MAX_SENTENCES);
  let out = '';
  for (const s of parts) {
    const joined = out ? `${out} ${s}` : s;
    if (joined.length > MAX_CHARS) break;
    out = joined;
  }
  // Even the first sentence is too long: cut it at a word boundary.
  if (!out && parts.length) {
    const cut = parts[0].lastIndexOf(' ', MAX_CHARS);
    out = parts[0].slice(0, cut > 0 ? cut : MAX_CHARS);
  }
  return out;
}
