// Discord attachments as OpenRouter content parts, so the model sees the
// picture, PDF or file itself rather than just the URL formatEnvelope writes.
// Anything not turned into a part is still visible to the model as that URL.
// Only done for a turn Panda answers: deciding whether to answer reads text alone.

// shortcut: larger images are skipped, not resized; resize via Discord's media proxy if photos get dropped.
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // the strictest provider limit
const MAX_PDF_BYTES = 10 * 1024 * 1024;
const MAX_TEXT_BYTES = 200 * 1024;
const TEXT_CHARS = 20000;
const TEXT_TYPE = /^(text\/|application\/(json|xml|javascript|x-yaml|x-sh))/;
// Attachments read per turn, the turn's own first, so a busy channel can't flood the request.
const MAX_ATTACHMENTS = 10;

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
    from,
  }));
}

// The file itself as a data URL, so the model gets it even when the provider
// can't fetch Discord's link. Null when it can't be downloaded or is too big;
// the caller then falls back to the link.
async function download(a, maxBytes, fetchImpl) {
  try {
    const res = await fetchImpl(a.url);
    if (!res.ok) return null;
    const bytes = Buffer.from(await res.arrayBuffer());
    if (!bytes.length || bytes.length > maxBytes) return null;
    const type = (res.headers?.get?.('content-type') || a.contentType || '').split(';')[0].trim();
    if (!type || type === 'image/preview') return null;
    return `data:${type};base64,${bytes.toString('base64')}`;
  } catch (err) {
    console.error('[panda] attachment download failed:', a.name, String(err.message || err).slice(0, 200));
    return null;
  }
}

// Whether the model can be given this file at all (anything else stays a link).
function readable(a, inputs) {
  const type = a.contentType || '';
  if (type.startsWith('image/')) return inputs.includes('image') && a.size <= MAX_IMAGE_BYTES;
  return type === 'application/pdf' || (TEXT_TYPE.test(type) && a.size <= MAX_TEXT_BYTES);
}

async function attachmentPart(a, fetchImpl) {
  const type = a.contentType || '';
  if (type.startsWith('image/')) {
    return { type: 'image_url', image_url: { url: (await download(a, MAX_IMAGE_BYTES, fetchImpl)) || a.url } };
  }
  if (type === 'application/pdf') {
    // OpenRouter reads PDFs for every model: natively, or through its own parser.
    const data = a.size <= MAX_PDF_BYTES ? await download(a, MAX_PDF_BYTES, fetchImpl) : null;
    return { type: 'file', file: { filename: a.name, file_data: data || a.url } };
  }
  try {
    const res = await fetchImpl(a.url);
    if (res.ok) return { type: 'text', text: `[contents of ${a.name}]\n${(await res.text()).slice(0, TEXT_CHARS)}` };
  } catch (err) {
    console.error('[panda] attachment fetch failed:', a.name, String(err.message || err).slice(0, 200));
  }
  return null;
}

export async function attachmentParts(attachments, inputs, fetchImpl = fetch) {
  // The same file can be both in the turn and in the recent messages (a reply to it).
  const seen = new Set();
  const unique = attachments
    .filter((a) => a?.url && readable(a, inputs) && !seen.has(a.url) && seen.add(a.url))
    .slice(0, MAX_ATTACHMENTS);
  const read = await Promise.all(unique.map((a) => attachmentPart(a, fetchImpl)));
  const parts = [];
  read.forEach((part, i) => {
    if (!part) return;
    const a = unique[i];
    if (a.from) parts.push({ type: 'text', text: `[attachment ${a.name} from ${a.from}]` });
    parts.push(part);
  });
  return parts;
}
