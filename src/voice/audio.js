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

// A WAV file's header, read from its start: its format and where its samples
// begin. Null while more bytes are needed.
function wavHeader(head) {
  if (head.length < 12) return null;
  if (head.toString('latin1', 0, 4) !== 'RIFF' || head.toString('latin1', 8, 12) !== 'WAVE') throw new Error('not a WAV file');
  let fmt = null;
  for (let at = 12; at + 8 <= head.length; ) {
    const id = head.toString('latin1', at, at + 4);
    const size = head.readUInt32LE(at + 4);
    const body = at + 8;
    if (id === 'data') {
      if (!fmt) throw new Error('WAV has no fmt chunk');
      if (fmt.bits !== 16) throw new Error(`expected 16-bit WAV, got ${fmt.bits}-bit`);
      // A streamed WAV may not know its length yet (0 or 0xFFFFFFFF): then it is "the rest".
      return { ...fmt, start: body, size: size === 0 || size === 0xffffffff ? Infinity : size };
    }
    if (body + size > head.length) return null;
    if (id === 'fmt ') fmt = { channels: head.readUInt16LE(body + 2), rate: head.readUInt32LE(body + 4), bits: head.readUInt16LE(body + 14) };
    at = body + size + (size & 1);
  }
  return null;
}

// A 16-bit PCM WAV that arrives in pieces, as what Discord plays raw (48 kHz
// stereo, s16le): yields the PCM as soon as each piece can be converted. The
// header is read chunk by chunk, not assumed to be 44 bytes; resampling is linear.
export async function* wavStreamToDiscordPcm(pieces) {
  let head = Buffer.alloc(0);
  let fmt = null;
  let left = 0; // sample bytes still expected
  let buf = Buffer.alloc(0); // samples not converted yet
  let base = 0; // the input frame buf starts at
  let j = 0; // the next output frame
  const convert = (final) => {
    const { channels, rate } = fmt;
    const frameBytes = 2 * channels;
    const total = base + Math.floor(buf.length / frameBytes);
    const end = final ? Math.floor((total * 48000) / rate) : Infinity;
    const out = Buffer.alloc(Math.max(0, Math.ceil((total * 48000) / rate) - j + 1) * 4);
    const sample = (frame, channel) => buf.readInt16LE(((frame - base) * channels + Math.min(channel, channels - 1)) * 2);
    let written = 0;
    for (; j < end; j++) {
      const pos = (j * rate) / 48000;
      const i = Math.floor(pos);
      // Until the end, a frame waits for the one after it to arrive.
      const next = final ? Math.min(i + 1, total - 1) : i + 1;
      if (next >= total) break;
      for (let c = 0; c < 2; c++) {
        const a = sample(i, c);
        out.writeInt16LE(Math.round(a + (sample(next, c) - a) * (pos - i)), written * 4 + c * 2);
      }
      written++;
    }
    // Keep only from the first frame the next output still needs.
    const drop = Math.min(Math.floor((j * rate) / 48000), total) - base;
    if (drop > 0) {
      buf = buf.subarray(drop * frameBytes);
      base += drop;
    }
    return out.subarray(0, written * 4);
  };
  for await (const piece of pieces) {
    let data = piece;
    if (!fmt) {
      head = Buffer.concat([head, piece]);
      fmt = wavHeader(head);
      if (!fmt) continue;
      left = fmt.size;
      data = head.subarray(fmt.start);
      head = null;
    }
    if (left <= 0) continue;
    if (data.length > left) data = data.subarray(0, left);
    left -= data.length;
    buf = Buffer.concat([buf, data]);
    const pcm = convert(false);
    if (pcm.length) yield pcm;
  }
  if (!fmt) throw new Error('WAV has no fmt or data chunk');
  const pcm = convert(true);
  if (pcm.length) yield pcm;
}

// The first `bytes` of a stream handed on as one piece, so playback starts
// with a cushion and a slow first second from thunder doesn't stutter.
export async function* prebuffer(pieces, bytes) {
  const held = [];
  let size = 0;
  for await (const piece of pieces) {
    if (size >= bytes) {
      yield piece;
      continue;
    }
    held.push(piece);
    size += piece.length;
    if (size >= bytes) yield Buffer.concat(held);
  }
  if (size < bytes && held.length) yield Buffer.concat(held);
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
