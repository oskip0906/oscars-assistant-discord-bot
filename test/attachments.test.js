import test from 'node:test';
import assert from 'node:assert/strict';
import { attachmentParts, gifPreviews } from '../src/discord/attachments.js';
import { modelInputs } from '../src/discord/model.js';

const att = (name, contentType, size = 1000) => ({ name, contentType, size, url: `https://cdn.example/${name}` });
const fetchText = async () => ({ ok: true, text: async () => 'hello file' });

test('images go to vision models only, and only under the size cap', async () => {
  const photo = att('cat.png', 'image/png');
  assert.deepEqual(await attachmentParts([photo], ['text', 'image']), [
    { type: 'image_url', image_url: { url: photo.url } },
  ]);
  assert.deepEqual(await attachmentParts([photo], ['text']), []);
  assert.deepEqual(await attachmentParts([att('huge.jpg', 'image/jpeg', 6 * 1024 * 1024)], ['image']), []);
});

test('PDFs always go as files, text files are inlined, everything else is left to the URL', async () => {
  const parts = await attachmentParts(
    [att('a.pdf', 'application/pdf'), att('notes.md', 'text/markdown; charset=utf-8'), att('song.mp3', 'audio/mpeg'), att('x.bin', null)],
    ['text'],
    fetchText,
  );
  assert.deepEqual(parts, [
    { type: 'file', file: { filename: 'a.pdf', file_data: 'https://cdn.example/a.pdf' } },
    { type: 'text', text: '[contents of notes.md]\nhello file' },
  ]);
});

test('a text file that cannot be fetched is skipped, not fatal', async () => {
  const parts = await attachmentParts([att('log.txt', 'text/plain')], ['text'], async () => {
    throw new Error('offline');
  });
  assert.deepEqual(parts, []);
});

test('modelInputs reads the catalog once per model and falls back to text when it cannot', async () => {
  let calls = 0;
  const catalog = async () => {
    calls++;
    return [{ id: 'vision/model', architecture: { input_modalities: ['text', 'image'] } }];
  };
  assert.deepEqual(await modelInputs({ model: 'vision/model' }, catalog), ['text', 'image']);
  assert.deepEqual(await modelInputs({ model: 'vision/model' }, catalog), ['text', 'image']);
  assert.equal(calls, 1);
  assert.deepEqual(await modelInputs({ model: 'unknown/model' }, catalog), ['text']);
  assert.deepEqual(await modelInputs({ model: 'down/model' }, async () => { throw new Error('503'); }), ['text']);
});

test('picker GIFs become their still preview, which then goes in as an image', async () => {
  const message = {
    embeds: [
      { data: { type: 'gifv' }, thumbnail: { url: 'https://media.tenor.com/still.png' } },
      { data: { type: 'rich' }, thumbnail: { url: 'https://example.com/not-a-gif.png' } },
      { data: { type: 'gifv' }, thumbnail: null },
    ],
  };
  const previews = gifPreviews(message);
  assert.equal(previews.length, 1);
  assert.deepEqual(await attachmentParts(previews, ['image']), [
    { type: 'image_url', image_url: { url: 'https://media.tenor.com/still.png' } },
  ]);
  assert.deepEqual(gifPreviews(null), []);
});
