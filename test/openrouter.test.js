import test from 'node:test';
import assert from 'node:assert/strict';
import { chatCompletion } from '../src/agent/openrouter.js';

const answer = (content) => new Response(JSON.stringify({ choices: [{ message: { content } }] }));
// Never settles unless the caller gives up on it — a provider that went silent.
const silent = (signal) => new Promise((_, reject) => signal?.addEventListener('abort', () => reject(signal.reason)));

async function withFetch(fake, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = fake;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

test('a model call that never answers is sent again instead of hanging the turn', async () => {
  let calls = 0;
  const message = await withFetch(
    (_url, { signal }) => (++calls === 1 ? silent(signal) : Promise.resolve(answer('hi'))),
    () => chatCompletion({ apiKey: 'k', model: 'm', messages: [], attemptMs: 50 }),
  );
  assert.equal(message.content, 'hi');
  assert.equal(calls, 2);
});

test('transient failures keep being retried past the old three-attempt limit', async () => {
  let calls = 0;
  const message = await withFetch(
    () => Promise.resolve(++calls < 5 ? new Response('busy', { status: 503 }) : answer('done')),
    () => chatCompletion({ apiKey: 'k', model: 'm', messages: [], attemptMs: 50, backoffMs: 1 }),
  );
  assert.equal(message.content, 'done');
  assert.equal(calls, 5);
});

test('a real API error still fails at once, since retrying it can never work', async () => {
  let calls = 0;
  await withFetch(
    () => (calls++, Promise.resolve(new Response(JSON.stringify({ error: { message: 'No such model' } }), { status: 400 }))),
    () => assert.rejects(chatCompletion({ apiKey: 'k', model: 'm', messages: [] }), /No such model/),
  );
  assert.equal(calls, 1);
});
