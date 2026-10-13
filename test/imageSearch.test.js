import test from 'node:test';
import assert from 'node:assert/strict';
import { imageSearch, defs } from '../src/agent/tools/search.js';
import { suppressLinkEmbeds } from '../src/discord/messageHandler.js';

async function withFetch(fake, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = fake;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

const results = Array.from({ length: 12 }, (_, i) => ({
  title: `Red <b>panda</b> ${i + 1}`,
  img_src: `https://img.example/p${i + 1}`,
  url: `https://page.example/${i + 1}`,
}));
// SearXNG answers the search; every HEAD check on an image passes.
const fake = async (url, opts) => (opts?.method === 'HEAD' ? new Response(null, { status: 200 }) : new Response(JSON.stringify({ results })));

test('image search returns text for the reply, not cards: 3 by default, the count asked for, at most 10', async () => {
  const invocation = { config: { searxngUrl: 'http://searx.test' }, imageUrls: new Set() };
  const text = await withFetch(fake, () => imageSearch({ query: 'red panda a' }, invocation));
  assert.equal(typeof text, 'string');
  assert.match(text, /^\[IMAGES — 3 result\(s\)\. To show one, put its image URL bare on its own line/);
  assert.match(text, /1\. \*\*Red panda 1\*\*\n {3}Image: https:\/\/img\.example\/p1\n {3}Source: <https:\/\/page\.example\/1>/);
  assert.doesNotMatch(text, /p4/);
  assert.deepEqual([...invocation.imageUrls], ['https://img.example/p1', 'https://img.example/p2', 'https://img.example/p3']);

  const five = await withFetch(fake, () => imageSearch({ query: 'red panda b', count: 5 }, { config: { searxngUrl: 'http://searx.test' } }));
  assert.match(five, /5\. \*\*Red panda 5/);
  assert.doesNotMatch(five, /p6/);
  const many = await withFetch(fake, () => imageSearch({ query: 'red panda c', count: 50 }, { config: { searxngUrl: 'http://searx.test' } }));
  assert.match(many, /^\[IMAGES — 10 result/);

  const count = defs.find((d) => d.function.name === 'image_search').function.parameters.properties.count;
  assert.match(count.description, /1-10, default 3/);
});

test('reply links image search found stay bare so Discord shows the picture; other links are wrapped', () => {
  const keep = new Set(['https://img.example/p1']);
  assert.equal(
    suppressLinkEmbeds('here\nhttps://img.example/p1\nmore at https://page.example/1', keep),
    'here\nhttps://img.example/p1\nmore at <https://page.example/1>',
  );
  assert.equal(suppressLinkEmbeds('https://img.example/p1'), '<https://img.example/p1>');
  assert.equal(suppressLinkEmbeds('https://x.example/a.png'), 'https://x.example/a.png');
});
