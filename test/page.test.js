import test from 'node:test';
import assert from 'node:assert/strict';
import { getPublic, htmlToText } from '../src/agent/tools/page.js';

const NOT_PUBLIC = /not on the public internet/;

test('never reads the machine itself or its network, by name or by address', async () => {
  for (const url of [
    'http://127.0.0.1:8888/',
    'http://localhost/',
    'http://[::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://10.0.0.1/',
    'http://192.168.1.1/',
    'http://169.254.169.254/latest/meta-data/',
  ]) await assert.rejects(getPublic(url), NOT_PUBLIC, url);
  await assert.rejects(getPublic('file:///etc/passwd'), /not an http\(s\) URL/);
});

test('turns a page into its readable text', () => {
  const html = `<html><head><title>Cats &amp; Dogs</title><style>p{}</style></head><body>
    <nav><a href="/">Home</a> <a href="/about">About</a></nav>
    <main><h1>Cats</h1><p>Cats are &lt;great&gt;&#33; &#x1F431;</p><ul><li>purr</li><li>nap</li></ul>
    <script>alert(1)</script></main>
    <footer>© 2026</footer></body></html>`;
  const { title, text } = htmlToText(html);
  assert.equal(title, 'Cats & Dogs');
  assert.equal(text, 'Cats\nCats are <great>! 🐱\n\n- purr\n- nap');
});

test('a page with no main or article keeps its whole body, minus the noise', () => {
  const { text } = htmlToText('<body><nav>menu</nav><!-- a <b>hidden</b> note --><div title="a > b">Hello</div><div>World &bogus; &#99999999;</div></body>');
  assert.equal(text, 'Hello\nWorld &bogus; &#99999999;');
});
