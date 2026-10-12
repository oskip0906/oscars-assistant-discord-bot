import test from 'node:test';
import assert from 'node:assert/strict';
import { attachmentParts, gifPreviews, mediaOf } from '../src/discord/attachments.js';
import { modelInputs } from '../src/discord/model.js';

const att = (name, contentType, size = 1000) => ({ name, contentType, size, url: `https://cdn.example/${name}` });
const fetchText = async () => ({ ok: true, text: async () => 'hello file' });
const offline = async () => {
  throw new Error('offline');
};
const fetchBytes = (type) => async () => ({
  ok: true,
  headers: new Headers({ 'content-type': type }),
  arrayBuffer: async () => new TextEncoder().encode('img').buffer,
});

test('images go to vision models only, and only under the size cap', async () => {
  const photo = att('cat.png', 'image/png');
  assert.deepEqual(await attachmentParts([photo], ['text', 'image'], fetchBytes('image/png')), [
    { type: 'image_url', image_url: { url: `data:image/png;base64,${Buffer.from('img').toString('base64')}` } },
  ]);
  assert.deepEqual(await attachmentParts([photo], ['text'], fetchBytes('image/png')), []);
  assert.deepEqual(await attachmentParts([att('huge.jpg', 'image/jpeg', 6 * 1024 * 1024)], ['image'], fetchBytes('image/jpeg')), []);
});

test('an image that cannot be downloaded falls back to its link', async () => {
  const photo = att('cat.png', 'image/png');
  assert.deepEqual(await attachmentParts([photo], ['image'], offline), [
    { type: 'image_url', image_url: { url: photo.url } },
  ]);
});

test('PDFs always go as files, text files are inlined, everything else is left to the URL', async () => {
  const parts = await attachmentParts(
    [att('a.pdf', 'application/pdf'), att('notes.md', 'text/markdown; charset=utf-8'), att('song.mp3', 'audio/mpeg'), att('x.bin', null)],
    ['text'],
    async (url) => (url.endsWith('.pdf') ? fetchBytes('application/pdf')() : fetchText()),
  );
  assert.deepEqual(parts, [
    { type: 'file', file: { filename: 'a.pdf', file_data: `data:application/pdf;base64,${Buffer.from('img').toString('base64')}` } },
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
  assert.deepEqual(await attachmentParts(previews, ['image'], offline), [
    { type: 'image_url', image_url: { url: 'https://media.tenor.com/still.png' } },
  ]);
  assert.deepEqual(gifPreviews(null), []);
});

test('attachments from surrounding messages are labelled, deduplicated and capped', async () => {
  const collection = (...items) => new Map(items.map((a) => [a.name, a]));
  const photo = att('cat.png', 'image/png');
  const turn = { author: { username: 'oscar' }, attachments: collection(), embeds: [] };
  // A message that is only a picture, and one that is only a picker GIF.
  const pictureOnly = { author: { username: 'sam' }, content: '', attachments: collection(photo), embeds: [] };
  const gifOnly = {
    author: { username: 'kim' },
    content: 'https://tenor.com/x',
    embeds: [{ data: { type: 'gifv' }, thumbnail: { url: 'https://media.tenor.com/still.png' } }],
  };
  const media = [
    ...mediaOf(turn, 'in the turn'),
    ...mediaOf(pictureOnly, 'in the message replied to'),
    ...mediaOf(gifOnly, 'in the recent messages'),
    ...mediaOf(pictureOnly, 'in the recent messages'),
    ...mediaOf(null, 'in the recent messages'),
  ];
  assert.deepEqual(await attachmentParts(media, ['text', 'image'], offline), [
    { type: 'text', text: '[attachment cat.png from @sam in the message replied to]' },
    { type: 'image_url', image_url: { url: photo.url } },
    { type: 'text', text: '[attachment gif preview from @kim in the recent messages]' },
    { type: 'image_url', image_url: { url: 'https://media.tenor.com/still.png' } },
  ]);

  const many = Array.from({ length: 15 }, (_, i) => att(`p${i}.png`, 'image/png'));
  const parts = await attachmentParts([att('song.mp3', 'audio/mpeg'), ...many], ['image'], offline);
  assert.equal(parts.length, 10);
  assert.equal(parts[0].image_url.url, many[0].url);
});
