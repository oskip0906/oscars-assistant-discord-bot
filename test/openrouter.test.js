import test from 'node:test';
import assert from 'node:assert/strict';
import { chatCompletion, providerFor, FALLBACK_MODEL } from '../src/agent/openrouter.js';

const answer = (content) => new Response(JSON.stringify({ choices: [{ message: { content } }] }));
// Never settles unless the caller gives up on it — a provider that went silent.
const silent = (signal) => new Promise((_, reject) => signal?.addEventListener('abort', () => reject(signal.reason)));
// What OpenRouter answers a model that cannot run with reasoning off.
const mandatory = () => new Response(JSON.stringify({ error: { message: 'Reasoning is mandatory for this endpoint and cannot be disabled.', code: 400 } }), { status: 400 });

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

// Every request body of a call that gets HTTP 503 each time.
async function failedBodies(args) {
  const bodies = [];
  await withFetch(
    (_url, init) => (bodies.push(JSON.parse(init.body)), Promise.resolve(new Response('busy', { status: 503 }))),
    () => assert.rejects(chatCompletion({ apiKey: 'k', model: 'a/m', messages: [], attemptMs: 50, backoffMs: 1, ...args }), /a\/m did not answer after 3 tries \(HTTP 503\)/),
  );
  return bodies;
}

test('a model that keeps failing gets three tries, and tries 2 and 3 go to the fallback model alone', async () => {
  for (const provider of [undefined, 'novita']) {
    const bodies = await failedBodies({ provider });
    assert.deepEqual(bodies.map((b) => b.model), ['a/m', FALLBACK_MODEL, FALLBACK_MODEL], `provider ${provider}`);
    assert.ok(bodies.slice(1).every((b) => !('models' in b) && !('provider' in b)), 'the retries carry no fallback list and no provider pin');
  }
});

test('with no fallback to go to, or images and files it may not read, the retries stay on the same model', async () => {
  const image = [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com/a.png' } }] }];
  for (const args of [{ fallback: null }, { fallback: 'a/m' }, { messages: image }]) {
    assert.deepEqual((await failedBodies(args)).map((b) => b.model), ['a/m', 'a/m', 'a/m'], JSON.stringify(args).slice(0, 40));
  }
});

test('every try gets the same timeout, not a longer one each time', async (t) => {
  const timeout = t.mock.method(AbortSignal, 'timeout');
  await withFetch(
    (_url, { signal }) => silent(signal),
    () => assert.rejects(chatCompletion({ apiKey: 'k', model: 'a/m', messages: [], attemptMs: 50, backoffMs: 1 }), /a\/m did not answer after 3 tries \(no answer in 0\.05s\)/),
  );
  assert.deepEqual(timeout.mock.calls.map((c) => c.arguments[0]), [50, 50, 50]);
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

test('reasoning is off by default, and OpenRouter is told to fall back when the model cannot answer', async () => {
  const body = await sentBody({ model: 'a/m' });
  assert.deepEqual(body.reasoning, { enabled: false });
  assert.equal(body.model, 'a/m');
  assert.deepEqual(body.models, ['a/m', FALLBACK_MODEL]);
  assert.deepEqual((await sentBody({ model: 'a/m', reasoning: { effort: 'low' } })).reasoning, { effort: 'low' }, "the caller's own setting");
});

test('there is no fallback list when a provider is pinned, the model is the fallback, there is none, or images are sent', async () => {
  const image = [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com/a.png' } }] }];
  for (const args of [{ model: 'a/m', provider: 'novita' }, { model: FALLBACK_MODEL }, { model: 'a/m', fallback: null }, { model: 'a/m', fallback: 'a/m' }, { model: 'a/m', messages: image }]) {
    const body = await sentBody(args);
    assert.equal('models' in body, false, JSON.stringify(args).slice(0, 40));
    assert.equal(body.model, args.model);
  }
});

test('a model that requires reasoning is resent at once with low effort on the same model, and remembered', async () => {
  const bodies = [];
  const fake = (_url, { body }) => (bodies.push(JSON.parse(body)), Promise.resolve(bodies.at(-1).reasoning.enabled === false ? mandatory() : answer('ok')));
  const started = Date.now();
  const message = await withFetch(fake, () => chatCompletion({ apiKey: 'k', model: 'a/think', messages: [], backoffMs: 5000 }));
  assert.equal(message.content, 'ok');
  assert.ok(Date.now() - started < 2000, 'no wait before the resend');
  assert.deepEqual(bodies.map((b) => b.reasoning), [{ enabled: false }, { effort: 'low' }]);
  assert.deepEqual(bodies.map((b) => b.model), ['a/think', 'a/think'], 'this is no reason to switch to the fallback');
  assert.deepEqual(bodies[1].models, bodies[0].models);

  bodies.length = 0;
  await withFetch(fake, () => chatCompletion({ apiKey: 'k', model: 'a/think', messages: [] }));
  assert.deepEqual(bodies.map((b) => b.reasoning), [{ effort: 'low' }], 'the next call starts with low effort');

  // A caller's own reasoning is left as is, so for it the 400 is an API error like any other.
  assert.deepEqual((await sentBody({ model: 'a/think', reasoning: { effort: 'high' } })).reasoning, { effort: 'high' });
  bodies.length = 0;
  await withFetch(
    (_url, { body }) => (bodies.push(JSON.parse(body)), Promise.resolve(mandatory())),
    () => assert.rejects(chatCompletion({ apiKey: 'k', model: 'a/other', messages: [], reasoning: { effort: 'none' } }), /Reasoning is mandatory/),
  );
  assert.equal(bodies.length, 1);
});

test('the resend for required reasoning is not one of the three tries', async () => {
  const replies = [mandatory(), new Response('busy', { status: 503 }), new Response('busy', { status: 503 }), answer('ok')];
  const models = [];
  const message = await withFetch(
    (_url, { body }) => (models.push(JSON.parse(body).model), Promise.resolve(replies.shift())),
    () => chatCompletion({ apiKey: 'k', model: 'a/think2', messages: [], attemptMs: 50, backoffMs: 1 }),
  );
  assert.equal(message.content, 'ok');
  assert.deepEqual(models, ['a/think2', 'a/think2', FALLBACK_MODEL, FALLBACK_MODEL]);
});

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

test('a stopped turn ends its model call at once and is never retried', async () => {
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
});
