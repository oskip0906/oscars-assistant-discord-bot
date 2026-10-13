// Discord attachments as OpenRouter content parts, so the model sees the
// picture, PDF or file itself rather than just the URL formatEnvelope writes.
// A numbered manifest lists every file, sent or not, so none is lost silently.
// Only done for a turn Panda answers: deciding whether to answer reads text alone.

const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // the strictest provider limit
const MAX_PDF_BYTES = 10 * 1024 * 1024;
const MAX_TEXT_BYTES = 200 * 1024;
const TEXT_CHARS = 20000;
const TEXT_TYPE = /^(text\/|application\/(json|xml|javascript|x-yaml|x-sh))/;
// Files sent per turn, the turn's own first, so a busy channel can't flood the
// request. Anything past it is still listed in the manifest as omitted.
export const MAX_ATTACHMENTS = 30;
// Downloaded bytes inlined per turn; files past it go as their link instead.
const MAX_INLINE_BYTES = 40 * 1024 * 1024;
// Longest side an oversized image is shrunk to by Discord's media proxy.
const RESIZE_SIDES = [2048, 1280];
// A download that hangs gives up after this, and the file is marked as not read.
const DOWNLOAD_MS = 10_000;

// Picker GIFs (Tenor, Giphy) arrive as a link with a `gifv` embed, not an
// attachment. Its thumbnail is a still frame, so it goes in as an image.
export const gifPreviews = (message) =>
  (message?.embeds ?? [])
    .filter((e) => e.data?.type === 'gifv' && e.thumbnail?.url)
    .map((e) => ({ name: 'gif preview', contentType: 'image/preview', size: 0, url: e.thumbnail.url }));

// Everything one message carries, each labelled with whose message it is and
// where it sits ("in the turn", "in the recent messages"), so the model can
// tell which picture someone means.
export function mediaOf(message, where) {
  if (!message) return [];
  const from = `@${message.author?.username ?? '?'}${where ? ` ${where}` : ''}`;
  return [...(message.attachments?.values() ?? []), ...gifPreviews(message)].map((a) => ({
    name: a.name,
    contentType: a.contentType,
    size: a.size,
    url: a.url,
    proxyURL: a.proxyURL,
    width: a.width,
    height: a.height,
    from,
  }));
}


// The file itself as a data URL, so the model gets it even when the provider
// can't fetch Discord's link. Null when it can't be downloaded or is too big;
// the caller then falls back to the link or marks the file unreadable.
async function download(url, maxBytes, fetchImpl, fallbackType = '') {
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(DOWNLOAD_MS) });
    if (!res.ok) return null;
    const bytes = Buffer.from(await res.arrayBuffer());
    if (!bytes.length || bytes.length > maxBytes) return null;
    const type = (res.headers?.get?.('content-type') || fallbackType || '').split(';')[0].trim();
    if (!type || type === 'image/preview') return null;
    return { data: `data:${type};base64,${bytes.toString('base64')}`, bytes: bytes.length };
  } catch (err) {
    console.error('[panda] attachment download failed:', url.slice(0, 120), String(err.message || err).slice(0, 200));
    return null;
  }
}

// An image over the cap, shrunk and re-encoded by Discord's media proxy. Needs
// the image's dimensions to keep its shape; null when it still doesn't fit.
async function shrink(a, fetchImpl) {
  const base = a.proxyURL || a.url.replace('://cdn.discordapp.com/', '://media.discordapp.net/');
  if (!a.width || !a.height || !base.includes('media.discordapp.net')) return null;
  for (const side of RESIZE_SIDES) {
    const scale = Math.min(1, side / Math.max(a.width, a.height));
    const link = `${base}${base.includes('?') ? '&' : '?'}width=${Math.round(a.width * scale)}&height=${Math.round(a.height * scale)}&format=webp`;
    const got = await download(link, MAX_IMAGE_BYTES, fetchImpl, 'image/webp');
    if (got) return { ...got, link };
  }
  return null;
}

// Why the model can't be given this file at all, or null when it can.
function unreadableReason(a, inputs) {
  const type = (a.contentType || '').split(';')[0].trim();
  if (type.startsWith('image/')) return inputs.includes('image') ? null : 'the current model cannot see images';
  if (type === 'application/pdf') return null;
  if (TEXT_TYPE.test(type)) return a.size > MAX_TEXT_BYTES ? 'text file over 200 KB' : null;
  return `not a readable file type (${type || 'unknown type'})`;
}

// One file as a content part: { part, bytes, link, note } when sent, { error } when not.
async function attachmentPart(a, fetchImpl) {
  const type = a.contentType || '';
  if (type.startsWith('image/')) {
    if (a.size > MAX_IMAGE_BYTES) {
      const small = await shrink(a, fetchImpl);
      if (!small) return { error: `image over ${MAX_IMAGE_BYTES / 1024 / 1024} MB that could not be shrunk to fit` };
      return { part: { type: 'image_url', image_url: { url: small.data } }, bytes: small.bytes, link: small.link, note: 'shrunk to fit' };
    }
    const got = await download(a.url, MAX_IMAGE_BYTES, fetchImpl, a.contentType);
    if (got) return { part: { type: 'image_url', image_url: { url: got.data } }, bytes: got.bytes, link: a.url };
    return { part: { type: 'image_url', image_url: { url: a.url } }, note: 'sent as a link (download failed), so it may not load' };
  }
  if (type === 'application/pdf') {
    // OpenRouter reads PDFs for every model: natively, or through its own parser.
    const got = a.size <= MAX_PDF_BYTES ? await download(a.url, MAX_PDF_BYTES, fetchImpl, a.contentType) : null;
    const file = (data) => ({ type: 'file', file: { filename: a.name, file_data: data } });
    if (got) return { part: file(got.data), bytes: got.bytes, link: a.url, linkPart: file(a.url) };
    return { part: file(a.url), note: 'sent as a link, so it may not load' };
  }
  try {
    const res = await fetchImpl(a.url, { signal: AbortSignal.timeout(DOWNLOAD_MS) });
    if (res.ok) return { part: { type: 'text', text: `[contents of ${a.name}]\n${(await res.text()).slice(0, TEXT_CHARS)}` } };
  } catch (err) {
    console.error('[panda] attachment fetch failed:', a.name, String(err.message || err).slice(0, 200));
  }
  return { error: 'could not be fetched' };
}

const sizeOf = (bytes) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

// Every file of the turn (and the recent messages) as content parts, opened by
// a manifest that numbers each one with its name, sender and whether it was
// read, so no file is ever dropped without the model knowing. The same file
// reached twice (a reply to it) is one entry; two uploads that merely look
// alike are two, and telling duplicates apart is left to the model.
export async function attachmentParts(attachments, inputs, fetchImpl = fetch) {
  const entries = [];
  const byUrl = new Map();
  for (const a of attachments) {
    if (!a?.url) continue;
    const known = byUrl.get(a.url);
    if (known) {
      if (a.from && !known.from.includes(a.from)) known.from.push(a.from);
      continue;
    }
    const entry = { ...a, index: entries.length + 1, from: a.from ? [a.from] : [] };
    byUrl.set(a.url, entry);
    entries.push(entry);
  }
  if (!entries.length) return [];

  let sending = 0;
  for (const e of entries) {
    e.error = unreadableReason(e, inputs);
    if (e.error) continue;
    if (sending >= MAX_ATTACHMENTS) e.omitted = `over the limit of ${MAX_ATTACHMENTS} files per turn`;
    else sending++;
  }
  const toRead = entries.filter((e) => !e.error && !e.omitted);
  const read = await Promise.all(toRead.map((e) => attachmentPart(e, fetchImpl)));
  let inlined = 0;
  toRead.forEach((e, i) => {
    const r = read[i];
    if (r.error) return void (e.error = r.error);
    e.part = r.part;
    e.note = r.note;
    // Past the budget a downloaded file goes as its link, keeping the request sane.
    if (r.bytes && (inlined += r.bytes) > MAX_INLINE_BYTES) {
      e.part = r.linkPart ?? { type: 'image_url', image_url: { url: r.link } };
      e.note = [r.note, 'sent as a link (the turn was too large to inline it), so it may not load'].filter(Boolean).join('; ');
    }
  });

  const sent = entries.filter((e) => e.part);
  const missing = entries.length - sent.length;
  const line = (e) => {
    const meta = [e.contentType || 'unknown type', e.size ? sizeOf(e.size) : null].filter(Boolean).join(', ');
    const status = e.part
      ? `sent${e.note ? ` (${e.note})` : ''}`
      : e.omitted
        ? `OMITTED: ${e.omitted}`
        : `NOT READ: ${e.error}`;
    return `#${e.index} ${e.name || '(unnamed)'} (${meta})${e.from.length ? ` from ${e.from.join(', also ')}` : ''}: ${status}`;
  };
  const manifest = [
    `[ATTACHMENTS — ${entries.length} file(s) came with the turn and the recent messages: ${sent.length} sent to you below, each labelled with its number${missing ? `; ${missing} NOT sent (omitted or unreadable)` : ''}. Every file is listed here:]`,
    ...entries.map(line),
    missing
      ? `[${missing} of ${entries.length} file(s) are not in front of you. If the task covers them (a total, a count, a list of receipts), name each missing one by number and name and say the result is incomplete; never present it as complete or guess their contents.]`
      : `[All ${entries.length} file(s) are in front of you. When a task covers several of them, account for each by number.]`,
  ].join('\n');

  const parts = [{ type: 'text', text: manifest }];
  for (const e of sent) {
    parts.push({ type: 'text', text: `[attachment #${e.index} ${e.name || '(unnamed)'}${e.from.length ? ` from ${e.from.join(', also ')}` : ''}]` });
    parts.push(e.part);
  }
  return parts;
}
