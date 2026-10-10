// Discord attachments as OpenRouter content parts, so the model sees the
// picture, PDF or file itself rather than just the URL formatEnvelope writes.
// Anything not turned into a part is still visible to the model as that URL.

// shortcut: larger images are skipped, not resized; resize via Discord's media proxy if photos get dropped.
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // the strictest provider limit
const MAX_TEXT_BYTES = 200 * 1024;
const TEXT_CHARS = 20000;
const TEXT_TYPE = /^(text\/|application\/(json|xml|javascript|x-yaml|x-sh))/;

// Picker GIFs (Tenor, Giphy) arrive as a link with a `gifv` embed, not an
// attachment. Its thumbnail is a still frame, so it goes in as an image.
export const gifPreviews = (message) =>
  (message?.embeds ?? [])
    .filter((e) => e.data?.type === 'gifv' && e.thumbnail?.url)
    .map((e) => ({ name: 'gif preview', contentType: 'image/preview', size: 0, url: e.thumbnail.url }));

export async function attachmentParts(attachments, inputs, fetchImpl = fetch) {
  const parts = [];
  for (const a of attachments) {
    const type = a.contentType || '';
    if (type.startsWith('image/')) {
      if (inputs.includes('image') && a.size <= MAX_IMAGE_BYTES) {
        parts.push({ type: 'image_url', image_url: { url: a.url } });
      }
    } else if (type === 'application/pdf') {
      // OpenRouter reads PDFs for every model: natively, or through its own parser.
      parts.push({ type: 'file', file: { filename: a.name, file_data: a.url } });
    } else if (TEXT_TYPE.test(type) && a.size <= MAX_TEXT_BYTES) {
      try {
        const res = await fetchImpl(a.url);
        if (res.ok) parts.push({ type: 'text', text: `[contents of ${a.name}]\n${(await res.text()).slice(0, TEXT_CHARS)}` });
      } catch (err) {
        console.error('[panda] attachment fetch failed:', a.name, String(err.message || err).slice(0, 200));
      }
    }
  }
  return parts;
}
