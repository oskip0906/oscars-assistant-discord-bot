import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMessageHandler } from '../src/discord/messageHandler.js';
import { SelfFixState, SELF_FIX_MESSAGE, selfFixState } from '../src/selfFixState.js';

const BOT = 'BOT';
const flushAll = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
};

function makeMessage({ id, authorId, content = '', mentionsBot = false, channelId = 'chan1' }) {
  const sent = [];
  const msg = {
    id,
    channelId,
    author: { id: authorId, username: `u${authorId}`, displayName: `U${authorId}`, bot: false },
    member: { displayName: `U${authorId}` },
    guild: { id: 'guild1', name: 'G' },
    content,
    reference: null,
    mentions: { users: new Map(mentionsBot ? [[BOT, { id: BOT, username: 'panda' }]] : []) },
    attachments: new Map(),
    channel: { sendTyping: async () => {}, send: async (p) => sent.push(p) },
    reply: async (p) => sent.push(p),
    react: async () => {},
    fetchReference: async () => null,
  };
  msg._sent = sent;
  return msg;
}

function harness(selfFix) {
  const calls = [];
  const handler = createMessageHandler({
    client: { user: { id: BOT } },
    config: { ownerId: 'OWNER', allowBots: true, dmEnabled: true },
    contextStore: { get: () => [], append: () => {}, clear: () => {} },
    player: null,
    privateMode: { isOn: () => false },
    selfFix,
    runAgentImpl: async (invocation, input) => {
      calls.push(input);
      return 'REPLY';
    },
  });
  return { handler, calls };
}

const textOf = (payload) => (typeof payload === 'string' ? payload : payload?.content ?? '');

test('while self_fix runs, a trigger gets the canned reply and never reaches the model', async () => {
  const state = new SelfFixState();
  state.begin();
  const { handler, calls } = harness(state);

  const m = makeMessage({ id: '1', authorId: 'A', content: 'hey panda', mentionsBot: true });
  await handler(m);
  await flushAll();

  assert.equal(calls.length, 0, 'the agent must not be invoked during a self-fix');
  assert.equal(m._sent.length, 1);
  assert.equal(textOf(m._sent[0]), SELF_FIX_MESSAGE);
});

test('the same user is told once, not on every follow-up', async () => {
  const state = new SelfFixState();
  state.begin();
  const { handler, calls } = harness(state);

  const m1 = makeMessage({ id: '1', authorId: 'A', content: 'hey', mentionsBot: true });
  const m2 = makeMessage({ id: '2', authorId: 'A', content: 'still there?', mentionsBot: true });
  await handler(m1);
  await handler(m2);
  await flushAll();

  assert.equal(textOf(m1._sent[0]), SELF_FIX_MESSAGE);
  assert.equal(m2._sent.length, 0, 'follow-up from the same sender stays silent');
  assert.equal(calls.length, 0);
});

test('a second user still gets their own notification', async () => {
  const state = new SelfFixState();
  state.begin();
  const { handler } = harness(state);

  const a = makeMessage({ id: '1', authorId: 'A', content: 'hey', mentionsBot: true });
  const b = makeMessage({ id: '2', authorId: 'B', content: 'hello', mentionsBot: true });
  await handler(a);
  await handler(b);
  await flushAll();

  assert.equal(textOf(a._sent[0]), SELF_FIX_MESSAGE);
  assert.equal(textOf(b._sent[0]), SELF_FIX_MESSAGE);
});

test('a non-triggering message during self_fix is ignored entirely', async () => {
  const state = new SelfFixState();
  state.begin();
  const { handler, calls } = harness(state);

  const m = makeMessage({ id: '1', authorId: 'A', content: 'just chatting', mentionsBot: false });
  await handler(m);
  await flushAll();

  assert.equal(m._sent.length, 0, 'no busy spam for people not talking to the bot');
  assert.equal(calls.length, 0);
});

// Wiring guard. source.js locks via the shared selfFixState singleton and never
// passes it to createMessageHandler, so the handler's default MUST bind to that
// same instance. If the default is dropped, self_fix would run with the bot
// still answering people — this is the test that catches it.
test('a handler built with no injected state still honours the shared singleton', async () => {
  const calls = [];
  const handler = createMessageHandler({
    client: { user: { id: BOT } },
    config: { ownerId: 'OWNER', allowBots: true, dmEnabled: true },
    contextStore: { get: () => [], append: () => {}, clear: () => {} },
    player: null,
    privateMode: { isOn: () => false },
    runAgentImpl: async (_i, input) => {
      calls.push(input);
      return 'REPLY';
    },
  });

  selfFixState.begin();
  try {
    const m = makeMessage({ id: '1', authorId: 'Z', content: 'hey panda', mentionsBot: true });
    await handler(m);
    await flushAll();
    assert.equal(calls.length, 0, 'the shared lock must gate the default handler');
    assert.equal(textOf(m._sent[0]), SELF_FIX_MESSAGE);
  } finally {
    selfFixState.end();
  }
});

test('once the fix ends, messages route to the model again', async () => {
  const state = new SelfFixState();
  state.begin();
  state.end();
  const { handler, calls } = harness(state);

  const m = makeMessage({ id: '1', authorId: 'A', content: 'hey panda', mentionsBot: true });
  await handler(m);
  await new Promise((r) => setTimeout(r, 3100));
  await flushAll();

  assert.equal(calls.length, 1, 'normal routing restored');
});
