import test from 'node:test';
import assert from 'node:assert/strict';
import { attachmentParts, gifPreviews } from '../src/discord/attachments.js';
import { modelInputs } from '../src/discord/model.js';

const att = (name, contentType, size = 1000, extra = {}) => ({ name, contentType, size, url: `https://cdn.example/${name}`, sender: 'Rice (@rice)', ...extra });
const fetchText = async () => new Response('hello file');
const labels = (parts) => parts.filter((p) => p.type === 'text' && p.text.startsWith('[attachment')).map((p) => p.text);

test('every attachment is labeled with its number, name, type, sender and status, and images go to vision models only', async () => {
  const photo = att('cat.png', 'image/png');
  assert.deepEqual(await attachmentParts([photo], ['text', 'image']), [
    { type: 'text', text: '[attachment 1: cat.png · image/png · from Rice (@rice) · shown below]' },
    { type: 'image_url', image_url: { url: photo.url } },
  ]);
  assert.deepEqual(await attachmentParts([photo], ['text']), [
    { type: 'text', text: '[attachment 1: cat.png · image/png · from Rice (@rice) · not shown: the current model does not take images]' },
  ]);
  const replied = await attachmentParts([att('receipt.jpg', 'image/jpeg', 1000, { inReply: true })], ['image']);
  assert.match(replied[0].text, /from Rice \(@rice\) \(on the message replied to\) · shown below/);
});

test('an image over the size cap is downscaled through Discord\'s media proxy, or marked when it cannot be', async () => {
  const big = att('skyline.jpg', 'image/jpeg', 9 * 1024 * 1024, { width: 8000, height: 4000, proxyURL: 'https://media.discordapp.net/attachments/1/2/skyline.jpg?ex=a&hm=b' });
  const [label, image] = await attachmentParts([big], ['image']);
  assert.match(label.text, /shown below, downscaled to 2048×1024 from 8000×4000/);
  const url = new URL(image.image_url.url);
  assert.equal(url.searchParams.get('ex'), 'a', 'the signed query is kept');
  assert.deepEqual([url.searchParams.get('width'), url.searchParams.get('height')], ['2048', '1024']);
  const unknown = await attachmentParts([att('huge.jpg', 'image/jpeg', 6 * 1024 * 1024)], ['image']);
  assert.deepEqual(labels(unknown), ['[attachment 1: huge.jpg · image/jpeg · from Rice (@rice) · not shown: 6.0 MB is over the 5.0 MB image limit]']);
  assert.equal(unknown.length, 1);
});

test('PDFs go as files, text files are inlined, and everything else is marked as not readable', async () => {
  const parts = await attachmentParts(
    [att('a.pdf', 'application/pdf'), att('notes.md', 'text/markdown; charset=utf-8'), att('song.mp3', 'audio/mpeg'), att('x.bin', null)],
    ['text'],
    fetchText,
  );
  assert.deepEqual(parts, [
    { type: 'text', text: '[attachment 1: a.pdf · application/pdf · from Rice (@rice) · shown below]' },
    { type: 'file', file: { filename: 'a.pdf', file_data: 'https://cdn.example/a.pdf' } },
    { type: 'text', text: '[attachment 2: notes.md · text/markdown · from Rice (@rice) · shown below]' },
    { type: 'text', text: '[contents of notes.md]\nhello file' },
    { type: 'text', text: "[attachment 3: song.mp3 · audio/mpeg · from Rice (@rice) · not shown: audio/mpeg can't be read here, only its link is in the message]" },
    { type: 'text', text: "[attachment 4: x.bin · unknown type · from Rice (@rice) · not shown: this kind of file can't be read here, only its link is in the message]" },
  ]);
  const huge = await attachmentParts([att('big.pdf', 'application/pdf', 30 * 1024 * 1024)], ['text']);
  assert.match(huge[0].text, /not shown: 30\.0 MB is over the 20\.0 MB PDF limit/);
});

test('a missing content type is read from the file extension', async () => {
  const parts = await attachmentParts([att('screenshot.PNG', null), att('main.py', 'application/octet-stream'), att('doc.pdf', '')], ['image'], fetchText);
  assert.deepEqual(parts.map((p) => p.type), ['text', 'image_url', 'text', 'text', 'text', 'file']);
  assert.match(parts[2].text, /main\.py · text\/plain/);
});

test('a text file that cannot be fetched is marked, not fatal', async () => {
  const offline = await attachmentParts([att('log.txt', 'text/plain')], ['text'], async () => {
    throw new Error('offline');
  });
  assert.deepEqual(labels(offline), ['[attachment 1: log.txt · text/plain · from Rice (@rice) · not shown: the download failed (unreachable)]']);
  const gone = await attachmentParts([att('log.txt', 'text/plain')], ['text'], async () => new Response('', { status: 404 }));
  assert.match(gone[0].text, /not shown: the download failed \(HTTP 404\)/);
  assert.equal(gone.length, 1);
});

test('text downloads are bounded and a long file is marked truncated, whatever size Discord reports', async () => {
  let pulled = 0;
  // An endless body: only the cap is ever read.
  const endless = new ReadableStream({ pull: (c) => { pulled++; c.enqueue(new TextEncoder().encode('a'.repeat(16384))); } });
  const parts = await attachmentParts([att('dump.log', 'text/plain', 10)], ['text'], async () => new Response(endless));
  assert.match(parts[0].text, /shown below, truncated to its first 20000 characters/);
  assert.equal(parts[1].text.length, '[contents of dump.log]\n'.length + 20000);
  assert.ok(pulled <= 8, `read ${pulled} chunks`);
  const exact = await attachmentParts([att('ok.txt', 'text/plain', 10)], ['text'], async () => new Response('0123456789'));
  assert.match(exact[0].text, /· shown below\]$/);
});

test('past ten attachments the rest are listed but not read', async () => {
  const many = Array.from({ length: 12 }, (_, i) => att(`p${i}.png`, 'image/png'));
  const parts = await attachmentParts(many, ['image']);
  assert.equal(parts.filter((p) => p.type === 'image_url').length, 10);
  assert.match(labels(parts).at(-1), /attachment 12: p11\.png .* not shown: only the first 10 attachments are read/);
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
  assert.deepEqual((await attachmentParts(previews, ['image'])).at(-1), { type: 'image_url', image_url: { url: 'https://media.tenor.com/still.png' } });
  // A pasted image link's embed goes in the same way.
  assert.equal(gifPreviews({ embeds: [{ data: { type: 'image' }, thumbnail: { url: 'https://i.example/x.jpg' } }] })[0].name, 'linked image');
  assert.deepEqual(gifPreviews(null), []);
});
