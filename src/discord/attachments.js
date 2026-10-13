// Discord attachments as OpenRouter content parts for the turn's first model
// request, so the model sees the picture, PDF or file itself rather than just
// the URL formatEnvelope writes. Every attachment gets a numbered label (name,
// type, sender, status) whether or not it is shown, so nothing is dropped
// silently and the model can say what it could not see.

const MAX_ATTACHMENTS = 10;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // the strictest provider limit
const MAX_IMAGE_SIDE = 2048; // an image over MAX_IMAGE_BYTES is shrunk to this by Discord's media proxy
const MAX_PDF_BYTES = 20 * 1024 * 1024;
const TEXT_CHARS = 20000;
const TEXT_BYTES = TEXT_CHARS * 4; // the most read of a text file: UTF-8 is at most 4 bytes a character
const DOWNLOAD_MS = 10_000;
const TEXT_TYPE = /^(text\/|application\/(json|xml|javascript|x-yaml|yaml|x-sh|toml|sql|csv))/;
// Discord leaves contentType empty (or octet-stream) for some uploads; the extension decides then.
const BY_EXTENSION = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', pdf: 'application/pdf',
  ...Object.fromEntries('txt md markdown csv tsv log json yaml yml toml xml html css js mjs cjs ts tsx jsx py rb go rs java c h cpp cs sh sql ini env'.split(' ').map((ext) => [ext, 'text/plain'])),
};

// Picker GIFs (Tenor, Giphy) arrive as a link with a `gifv` embed, and a pasted
// image link as an `image` embed, not an attachment. Their thumbnail goes in as an image.
export const gifPreviews = (message) =>
  (message?.embeds ?? [])
    .filter((e) => ['gifv', 'image'].includes(e.data?.type) && e.thumbnail?.url)
    .map((e) => ({ name: e.data.type === 'gifv' ? 'gif preview' : 'linked image', contentType: 'image/preview', size: 0, url: e.thumbnail.url }));

const typeOf = (a) => {
  const type = String(a.contentType || '').split(';')[0].trim().toLowerCase();
  if (type && type !== 'application/octet-stream') return type;
  return BY_EXTENSION[String(a.name || '').split('.').pop().toLowerCase()] || type;
};
const size = (bytes) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`);

// `attachments` are Discord attachments (or gifPreviews), optionally with
// `sender` (who posted it) and `inReply` (it is on the message being replied
// to). `inputs` is what the model takes (modelInputs).
export async function attachmentParts(attachments, inputs, fetchImpl = fetch) {
  const parts = [];
  for (const [i, a] of attachments.entries()) {
    const type = typeOf(a);
    const { status, part } =
      i < MAX_ATTACHMENTS ? await read(a, type, inputs, fetchImpl) : { status: `not shown: only the first ${MAX_ATTACHMENTS} attachments are read` };
    const from = `from ${a.sender || 'someone'}${a.inReply ? ' (on the message replied to)' : ''}`;
    parts.push({ type: 'text', text: `[attachment ${i + 1}: ${a.name || 'unnamed'} · ${type || 'unknown type'} · ${from} · ${status}]` });
    if (part) parts.push(part);
  }
  return parts;
}

async function read(a, type, inputs, fetchImpl) {
  if (type.startsWith('image/')) {
    if (!inputs.includes('image')) return { status: 'not shown: the current model does not take images' };
    if (!a.size || a.size <= MAX_IMAGE_BYTES) return { status: 'shown below', part: { type: 'image_url', image_url: { url: a.url } } };
    const small = downscaled(a);
    return small
      ? { status: `shown below, downscaled to ${small.width}×${small.height} from ${a.width}×${a.height}`, part: { type: 'image_url', image_url: { url: small.url } } }
      : { status: `not shown: ${size(a.size)} is over the ${size(MAX_IMAGE_BYTES)} image limit` };
  }
  if (type === 'application/pdf') {
    if (a.size > MAX_PDF_BYTES) return { status: `not shown: ${size(a.size)} is over the ${size(MAX_PDF_BYTES)} PDF limit` };
    // OpenRouter reads PDFs for every model: natively, or through its own parser.
    return { status: 'shown below', part: { type: 'file', file: { filename: a.name, file_data: a.url } } };
  }
  if (TEXT_TYPE.test(type)) return readText(a, fetchImpl);
  return { status: `not shown: ${type || 'this kind of file'} can't be read here, only its link is in the message` };
}

// shortcut: the proxy's output size isn't checked; if a provider rejects one, download and re-encode instead.
function downscaled(a) {
  const longest = Math.max(a.width || 0, a.height || 0);
  if (!a.proxyURL || !longest) return null;
  const scale = Math.min(1, MAX_IMAGE_SIDE / longest);
  const width = Math.round(a.width * scale);
  const height = Math.round(a.height * scale);
  const url = new URL(a.proxyURL);
  url.searchParams.set('format', 'webp');
  url.searchParams.set('width', width);
  url.searchParams.set('height', height);
  return { url: url.href, width, height };
}

// Downloads at most TEXT_BYTES, within DOWNLOAD_MS, whatever size Discord reported.
async function readText(a, fetchImpl) {
  let bytes;
  let capped = false;
  try {
    const res = await fetchImpl(a.url, { signal: AbortSignal.timeout(DOWNLOAD_MS) });
    if (!res.ok) return { status: `not shown: the download failed (HTTP ${res.status})` };
    const chunks = [];
    let read = 0;
    for await (const chunk of res.body ?? []) {
      chunks.push(chunk);
      read += chunk.length;
      if (read >= TEXT_BYTES) {
        capped = true;
        break;
      }
    }
    bytes = Buffer.concat(chunks).subarray(0, TEXT_BYTES);
  } catch (err) {
    console.error('[panda] attachment fetch failed:', a.name, String(err.message || err).slice(0, 200));
    return { status: `not shown: the download failed (${err.name === 'TimeoutError' ? 'timed out' : 'unreachable'})` };
  }
  const full = new TextDecoder().decode(bytes);
  const text = full.slice(0, TEXT_CHARS);
  // A body that ended on its own was read whole, whatever size Discord reported.
  const total = capped ? Math.max(a.size || 0, bytes.length) : bytes.length;
  const cut = capped || full.length > TEXT_CHARS;
  return {
    status: cut ? `shown below, truncated to its first ${text.length} characters (the file is ${size(total)})` : 'shown below',
    part: { type: 'text', text: `[contents of ${a.name}]\n${text}` },
  };
}
