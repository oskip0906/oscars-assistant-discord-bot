import test from 'node:test';
import assert from 'node:assert/strict';
import { chatCompletion, providerFor } from '../src/agent/openrouter.js';

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

// The JSON body of one chatCompletion call.
async function sentBody(args) {
  let body;
  await withFetch(
    (_url, init) => ((body = JSON.parse(init.body)), Promise.resolve(answer('ok'))),
    () => chatCompletion({ apiKey: 'k', messages: [], ...args }),
  );
  return body;
}

test('a set provider is sent as a pinned provider preference, with the model id unchanged', async () => {
  const body = await sentBody({ model: 'a/m', provider: ' deepinfra ' });
  assert.equal(body.model, 'a/m');
  assert.deepEqual(body.provider, { order: ['deepinfra'], allow_fallbacks: false });
});

test('a missing, empty or whitespace provider sends no provider field at all', async () => {
  for (const provider of [undefined, null, '', '   ']) {
    const body = await sentBody({ model: 'a/m', provider });
    assert.equal(body.model, 'a/m');
    assert.equal('provider' in body, false, `provider ${JSON.stringify(provider)}`);
  }
});

test('providerFor resolves each model on its own, and legacy configs have none', async () => {
  const config = { model: 'a/one', modelProviders: { 'a/one': 'together', 'c/three': ' ' } };
  assert.equal(providerFor(config, 'a/one'), 'together');
  assert.equal(providerFor(config, 'b/two'), '');
  assert.equal(providerFor(config, 'c/three'), '');
  assert.equal(providerFor({ model: 'a/one' }, 'a/one'), '', 'legacy config without modelProviders');

  const pinned = await sentBody({ model: 'a/one', provider: providerFor(config, 'a/one') });
  const plain = await sentBody({ model: 'b/two', provider: providerFor(config, 'b/two') });
  assert.deepEqual(pinned.provider.order, ['together']);
  assert.equal('provider' in plain, false);
});

test('a stopped turn ends its model call at once and is never retried; usage comes back with the message', async () => {
  const ac = new AbortController();
  let calls = 0;
  const pending = withFetch(
    (_url, { signal }) => (calls++, silent(signal)),
    () => chatCompletion({ apiKey: 'k', model: 'm', messages: [], attemptMs: 10_000, signal: ac.signal }),
  );
  setTimeout(() => ac.abort(), 20);
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(calls, 1);
  // The turn's signal reaches calls made deep inside it (tools, research) with no plumbing.
  const { turnSignal } = await import('../src/agent/openrouter.js');
  calls = 0;
  await assert.rejects(turnSignal.run(ac.signal, () => withFetch(() => (calls++, Promise.resolve(answer('x'))), () => chatCompletion({ apiKey: 'k', model: 'm', messages: [] }))), { name: 'AbortError' });
  assert.equal(calls, 0, 'already stopped: nothing is sent');
  const withUsage = await withFetch(
    () => Promise.resolve(new Response(JSON.stringify({ choices: [{ message: { content: 'hi' } }], usage: { prompt_tokens: 12, completion_tokens: 3 } }))),
    () => chatCompletion({ apiKey: 'k', model: 'm', messages: [] }),
  );
  assert.deepEqual(withUsage.usage, { prompt_tokens: 12, completion_tokens: 3 });
});
