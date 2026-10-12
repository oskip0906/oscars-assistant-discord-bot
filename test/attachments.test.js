import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_ATTACHMENTS, attachmentParts, gifPreviews, mediaOf } from '../src/discord/attachments.js';
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

// The files themselves, without the manifest and the per-file labels.
const files = (parts) => parts.filter((p) => !(p.type === 'text' && /^\[(ATTACHMENTS|attachment #)/.test(p.text)));
const manifestOf = (parts) => parts[0].text;

test('images go to vision models only; a model that cannot see them is told so', async () => {
  const photo = att('cat.png', 'image/png');
  const parts = await attachmentParts([photo], ['text', 'image'], fetchBytes('image/png'));
  assert.deepEqual(files(parts), [
    { type: 'image_url', image_url: { url: `data:image/png;base64,${Buffer.from('img').toString('base64')}` } },
  ]);
  assert.equal(parts[1].text, '[attachment #1 cat.png]');
  const blind = await attachmentParts([photo], ['text'], fetchBytes('image/png'));
  assert.deepEqual(files(blind), []);
  assert.match(manifestOf(blind), /#1 cat\.png .*NOT READ: the current model cannot see images/);
  assert.match(manifestOf(blind), /never present it as complete/);
});

test('an oversized image is shrunk through the media proxy, or marked unreadable', async () => {
  const huge = { ...att('huge.jpg', 'image/jpeg', 6 * 1024 * 1024), width: 4000, height: 3000, proxyURL: 'https://media.discordapp.net/huge.jpg?ex=1' };
  const asked = [];
  const parts = await attachmentParts([huge], ['image'], async (url) => {
    asked.push(url);
    return fetchBytes('image/webp')();
  });
  assert.deepEqual(asked, ['https://media.discordapp.net/huge.jpg?ex=1&width=2048&height=1536&format=webp']);
  assert.match(files(parts)[0].image_url.url, /^data:image\/webp;base64,/);
  assert.match(manifestOf(parts), /#1 huge\.jpg \(image\/jpeg, 6\.0 MB\): sent \(shrunk to fit\)/);

  // No dimensions to shrink by: never sent, never silently dropped.
  const noDims = await attachmentParts([att('huge.jpg', 'image/jpeg', 6 * 1024 * 1024)], ['image'], fetchBytes('image/jpeg'));
  assert.deepEqual(files(noDims), []);
  assert.match(manifestOf(noDims), /#1 huge\.jpg .*NOT READ: image over 5 MB that could not be shrunk to fit/);
});

test('an image that cannot be downloaded falls back to its link, and says so', async () => {
  const photo = att('cat.png', 'image/png');
  const parts = await attachmentParts([photo], ['image'], offline);
  assert.deepEqual(files(parts), [{ type: 'image_url', image_url: { url: photo.url } }]);
  assert.match(manifestOf(parts), /sent \(sent as a link \(download failed\), so it may not load\)/);
});

test('PDFs always go as files, text files are inlined, everything else is listed as unreadable', async () => {
  const parts = await attachmentParts(
    [att('a.pdf', 'application/pdf'), att('notes.md', 'text/markdown; charset=utf-8'), att('song.mp3', 'audio/mpeg'), att('x.bin', null)],
    ['text'],
    async (url) => (url.endsWith('.pdf') ? fetchBytes('application/pdf')() : fetchText()),
  );
  assert.deepEqual(files(parts), [
    { type: 'file', file: { filename: 'a.pdf', file_data: `data:application/pdf;base64,${Buffer.from('img').toString('base64')}` } },
    { type: 'text', text: '[contents of notes.md]\nhello file' },
  ]);
  assert.match(manifestOf(parts), /4 file\(s\).*2 sent.*2 NOT sent/);
  assert.match(manifestOf(parts), /#3 song\.mp3 .*NOT READ: not a readable file type \(audio\/mpeg\)/);
  assert.match(manifestOf(parts), /#4 x\.bin .*NOT READ: not a readable file type \(unknown type\)/);
});

test('a text file that cannot be fetched is not fatal, and is listed as not read', async () => {
  const parts = await attachmentParts([att('log.txt', 'text/plain')], ['text'], async () => {
    throw new Error('offline');
  });
  assert.deepEqual(files(parts), []);
  assert.match(manifestOf(parts), /#1 log\.txt .*NOT READ: could not be fetched/);
  assert.deepEqual(await attachmentParts([], ['text']), []);
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
  assert.deepEqual(files(await attachmentParts(previews, ['image'], offline)), [
    { type: 'image_url', image_url: { url: 'https://media.tenor.com/still.png' } },
  ]);
  assert.deepEqual(gifPreviews(null), []);
});

test('attachments from surrounding messages are labelled, and the same file reached twice is one entry', async () => {
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
  const parts = await attachmentParts(media, ['text', 'image'], offline);
  assert.deepEqual(parts.slice(1), [
    { type: 'text', text: '[attachment #1 cat.png from @sam in the message replied to, also @sam in the recent messages]' },
    { type: 'image_url', image_url: { url: photo.url } },
    { type: 'text', text: '[attachment #2 gif preview from @kim in the recent messages]' },
    { type: 'image_url', image_url: { url: 'https://media.tenor.com/still.png' } },
  ]);
  assert.match(manifestOf(parts), /^\[ATTACHMENTS — 2 file\(s\).*2 sent to you below/);
});

const receipts = (n, from = '@oscar in the turn') =>
  Array.from({ length: n }, (_, i) => ({ ...att(`receipt${i + 1}.jpg`, 'image/jpeg', 2 * 1024 * 1024), from }));

test('13 receipts: every one reaches the model, numbered in order, none silently lost', async () => {
  const all = receipts(13);
  const parts = await attachmentParts(all, ['text', 'image'], fetchBytes('image/jpeg'));
  assert.equal(files(parts).length, 13);
  const labels = parts.filter((p) => p.type === 'text' && p.text.startsWith('[attachment #')).map((p) => p.text);
  assert.deepEqual(labels, all.map((a, i) => `[attachment #${i + 1} ${a.name} from @oscar in the turn]`));
  const manifest = manifestOf(parts);
  assert.match(manifest, /13 file\(s\).*13 sent to you below/);
  for (let i = 1; i <= 13; i++) assert.match(manifest, new RegExp(`#${i} receipt${i}\\.jpg .*: sent`));
  assert.match(manifest, /All 13 file\(s\) are in front of you/);
  assert.doesNotMatch(manifest, /NOT sent|OMITTED|NOT READ/);
});

test('past the per-turn limit, the rest are listed as omitted by number and name, and the total is flagged incomplete', async () => {
  const all = [att('song.mp3', 'audio/mpeg'), ...receipts(MAX_ATTACHMENTS + 3)];
  const parts = await attachmentParts(all, ['image'], fetchBytes('image/jpeg'));
  assert.equal(files(parts).length, MAX_ATTACHMENTS);
  const manifest = manifestOf(parts);
  assert.match(manifest, new RegExp(`${MAX_ATTACHMENTS + 4} file\\(s\\).*${MAX_ATTACHMENTS} sent.*4 NOT sent`));
  assert.match(manifest, /#1 song\.mp3 .*NOT READ/);
  for (let i = MAX_ATTACHMENTS + 1; i <= MAX_ATTACHMENTS + 3; i++) {
    assert.match(manifest, new RegExp(`#${i + 1} receipt${i}\\.jpg .*OMITTED: over the limit of ${MAX_ATTACHMENTS} files per turn`));
  }
  assert.match(manifest, /4 of \d+ file\(s\) are not in front of you.*never present it as complete/);
  assert.doesNotMatch(manifest, /are in front of you\. When/);
});

test('look-alike receipts are not de-duplicated by code: each is sent, and spotting duplicates is the model\'s job', async () => {
  // The same receipt photographed twice and uploaded twice: same name and size, different files.
  const first = { ...att('IMG_0001.jpg', 'image/jpeg'), from: '@oscar in the turn' };
  const again = { ...first, url: 'https://cdn.example/other/IMG_0001.jpg' };
  const parts = await attachmentParts([...receipts(12), first, again], ['image'], fetchBytes('image/jpeg'));
  assert.equal(files(parts).length, 14);
  const manifest = manifestOf(parts);
  assert.match(manifest, /#13 IMG_0001\.jpg .*: sent/);
  assert.match(manifest, /#14 IMG_0001\.jpg .*: sent/);
});

test('the system prompt asks for itemised, double-checked totals that admit missing files', async () => {
  const { buildSystemPrompt } = await import('../src/agent/systemPrompt.js');
  const prompt = await buildSystemPrompt({ config: { botName: 'Panda', ownerId: '1', model: 'm' }, guild: null, message: { channel: {}, author: { id: '2', username: 'x' } } });
  assert.match(prompt, /\[ATTACHMENTS …\]/);
  assert.match(prompt, /OMITTED or NOT READ is not in front of you/);
  assert.match(prompt, /possible duplicate/);
  assert.match(prompt, /check it a second way/);
  assert.match(prompt, /how many files were supplied and how many you used/);
  assert.match(prompt, /never fill a gap with a made-up figure/);
});

test('past the inline size budget, receipts still go, as links the manifest flags', async () => {
  const big = async () => ({ ok: true, headers: new Headers({ 'content-type': 'image/jpeg' }), arrayBuffer: async () => new Uint8Array(4 * 1024 * 1024).buffer });
  const all = receipts(13).map((a) => ({ ...a, size: 4 * 1024 * 1024 }));
  const parts = await attachmentParts(all, ['image'], big);
  const sent = files(parts);
  assert.equal(sent.length, 13);
  assert.match(sent[0].image_url.url, /^data:image\/jpeg/);
  assert.equal(sent[12].image_url.url, all[12].url);
  assert.match(manifestOf(parts), /#13 receipt13\.jpg .*sent \(sent as a link \(the turn was too large to inline it\), so it may not load\)/);
});
