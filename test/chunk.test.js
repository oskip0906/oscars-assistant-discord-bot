import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkMessage } from '../src/discord/chunk.js';

test('short text is a single chunk', () => {
  assert.deepEqual(chunkMessage('hello'), ['hello']);
});

test('empty text yields a placeholder chunk', () => {
  const out = chunkMessage('');
  assert.equal(out.length, 1);
  assert.ok(out[0].length > 0);
});

test('long text splits into chunks under the limit', () => {
  const line = 'x'.repeat(90);
  const text = Array.from({ length: 50 }, () => line).join('\n'); // ~4550 chars
  const chunks = chunkMessage(text, 2000);
  assert.ok(chunks.length >= 3);
  for (const c of chunks) {
    assert.ok(c.length <= 2000, `chunk too long: ${c.length}`);
    assert.ok(c.length > 0);
  }
  assert.equal(chunks.join('\n').replace(/\n+/g, '\n'), text.replace(/\n+/g, '\n'));
});

test('prefers newline boundaries', () => {
  const text = `${'a'.repeat(1500)}\n${'b'.repeat(1500)}`;
  const chunks = chunkMessage(text, 2000);
  assert.equal(chunks.length, 2);
  assert.ok(chunks[0].endsWith('a'));
  assert.ok(chunks[1].startsWith('b'));
});

test('hard-splits text with no newlines', () => {
  const text = 'z'.repeat(5000);
  const chunks = chunkMessage(text, 2000);
  assert.ok(chunks.length >= 3);
  for (const c of chunks) assert.ok(c.length <= 2000);
  assert.equal(chunks.join(''), text);
});

test('prefers sentence boundaries over mid-word cuts', () => {
  const text = 'First sentence here. Second sentence is a little longer. Third one.';
  const chunks = chunkMessage(text, 40);
  for (const c of chunks) assert.ok(c.length <= 40);
  // No part should end mid-word: each ends at sentence punctuation.
  for (const c of chunks.slice(0, -1)) assert.match(c, /[.!?…]$/);
});

test('keeps code fences balanced across a split', () => {
  const text = `intro line\n\`\`\`js\n${'const x = 1;\n'.repeat(8)}\`\`\`\noutro`;
  const chunks = chunkMessage(text, 60);
  assert.ok(chunks.length >= 2);
  for (const c of chunks) {
    assert.ok(c.length <= 60, `chunk too long: ${c.length}`);
    const fences = (c.match(/```/g) || []).length;
    assert.equal(fences % 2, 0, `unbalanced fences in chunk: ${c}`);
  }
});

test('never exceeds the limit even when reopening fences', () => {
  const text = `\`\`\`\n${'x'.repeat(6000)}\n\`\`\``;
  const chunks = chunkMessage(text, 2000);
  for (const c of chunks) assert.ok(c.length <= 2000, `chunk too long: ${c.length}`);
});
