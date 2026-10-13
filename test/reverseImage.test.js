import test from 'node:test';
import assert from 'node:assert/strict';
import { reverseImageSearch } from '../src/agent/tools/search.js';

const invocation = { config: { searxngUrl: 'http://searx.test' }, attachmentUrls: ['https://cdn.discordapp.com/a/1/IMG_7482.jpg?ex=1'] };

async function withFetch(fake, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = fake;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

test('search by image: an attachment number becomes its link, sent to the yandex reverse engine, and matches come back with best guesses', async () => {
  let asked;
  const data = {
    suggestions: ['austin texas', 'downtown skyline'],
    results: [
      { url: 'https://www.pexels.com/photo/austin', title: 'Bridges by the river in <b>Austin</b>', content: 'Lady Bird Lake', img_src: 'https://images.pexels.com/1.jpg' },
      { url: 'https://example.com/no-image', title: 'no picture' },
    ],
  };
  const text = await withFetch(
    async (url) => ((asked = new URL(url)), new Response(JSON.stringify(data))),
    () => reverseImageSearch({ image: '#1' }, invocation),
  );
  assert.equal(asked.searchParams.get('engines'), 'yandex reverse');
  assert.equal(asked.searchParams.get('q'), invocation.attachmentUrls[0]);
  assert.match(text, /^\[SEARCH BY IMAGE — 1 page\(s\) with matching pictures\. Matches can be lookalikes/);
  assert.match(text, /Best guesses: austin texas, downtown skyline/);
  assert.match(text, /1\. \*\*Bridges by the river in Austin\*\* — Lady Bird Lake\n {3}Image: https:\/\/images\.pexels\.com\/1\.jpg\n {3}Page: <https:\/\/www\.pexels\.com\/photo\/austin>/);
  assert.doesNotMatch(text, /no picture/, 'a match without its image is left out');
});

test('search by image refuses what it cannot search and says plainly when nothing came back', async () => {
  assert.match(await reverseImageSearch({ image: '3' }, invocation), /There is no attachment 3/);
  assert.match(await reverseImageSearch({ image: 'file:///etc/passwd' }, invocation), /needs an http\(s\) image URL/);
  const empty = await withFetch(
    async () => new Response(JSON.stringify({ results: [], suggestions: [], unresponsive_engines: [['yandex reverse', 'timeout']] })),
    () => reverseImageSearch({ image: 'https://i.example/x.jpg' }, invocation),
  );
  assert.match(empty, /found nothing for that picture \(yandex reverse: timeout\)\. Say so; answer from what you can see/);
});
