import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createMessageHandler } from '../src/discord/messageHandler.js';

const BOT = 'BOT';
const flush = () => new Promise((r) => setImmediate(r));
const flushAll = async () => {
  for (let i = 0; i < 10; i++) await flush();
};

function makeMessage({ id, authorId, bot = false, content = '', mentionsBot = false, channelId = 'chan1' }) {
  const sent = [];
  const reacts = [];
  const msg = {
    id,
    channelId,
    author: { id: authorId, username: `u${authorId}`, displayName: `U${authorId}`, bot },
    member: { displayName: `U${authorId}` },
    guild: { id: 'guild1', name: 'G' },
    content,
    reference: null,
    mentions: { users: new Map(mentionsBot ? [[BOT, { id: BOT, username: 'panda' }]] : []) },
    attachments: new Map(),
    channel: { sendTyping: async () => {}, send: async (p) => sent.push(p) },
    reply: async (p) => sent.push(p),
    react: async (e) => reacts.push(e),
    fetchReference: async () => null,
  };
  msg._sent = sent;
  msg._reacts = reacts;
  return msg;
}

function harness({ reply = 'REPLY', privateOn = false } = {}) {
  const calls = [];
  const runAgentImpl = async (invocation, input) => {
    calls.push({ input, batchedCount: invocation.batchedCount, anchorAuthor: invocation.message.author.id });
    if (typeof reply === 'function') return reply(invocation);
    return reply;
  };
  const handler = createMessageHandler({
    client: { user: { id: BOT } },
    config: { ownerId: 'OWNER', allowBots: true, dmEnabled: true },
    contextStore: { get: () => [], append: () => {}, clear: () => {} },
    player: null,
    privateMode: { isOn: () => privateOn },
    runAgentImpl,
  });
  return { handler, calls };
}

test('two rapid messages from same sender are batched into one turn', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { handler, calls } = harness();
    const m1 = makeMessage({ id: '1', authorId: 'A', content: 'hello', mentionsBot: true });
    const m2 = makeMessage({ id: '2', authorId: 'A', content: 'and another thing' });
    await handler(m1);
    await handler(m2); // folds into the open batch, no mention needed
    await flushAll();
    assert.equal(calls.length, 0, 'nothing processed before the 3s window elapses');
    mock.timers.tick(3000);
    await flushAll();
    assert.equal(calls.length, 1, 'exactly one turn for the batch');
    assert.equal(calls[0].batchedCount, 2);
    assert.match(calls[0].input, /hello/);
    assert.match(calls[0].input, /and another thing/);
    assert.equal(m2._sent.length, 1, 'reply goes to the most recent message');
  } finally {
    mock.timers.reset();
  }
});

test('the 3s timer does not reset when follow-ups arrive late in the window', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { handler, calls } = harness();
    const m1 = makeMessage({ id: '1', authorId: 'A', content: 'first', mentionsBot: true });
    await handler(m1);
    mock.timers.tick(2500);
    const m2 = makeMessage({ id: '2', authorId: 'A', content: 'late addition' });
    await handler(m2);
    mock.timers.tick(500); // 3000ms after the FIRST message — flushes now
    await flushAll();
    assert.equal(calls.length, 1, 'flushed exactly 3s after the first message, not the last');
    assert.equal(calls[0].batchedCount, 2);
    assert.match(calls[0].input, /late addition/);
  } finally {
    mock.timers.reset();
  }
});

test('another sender during an open window is QUEUED and processed next, not dropped', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { handler, calls } = harness();
    const a = makeMessage({ id: '1', authorId: 'A', content: 'first claim', mentionsBot: true });
    const b = makeMessage({ id: '2', authorId: 'B', content: 'me too please', mentionsBot: true });
    await handler(a);
    await handler(b); // B's own batch, queued behind A's
    mock.timers.tick(3000); // both collection windows elapse
    await flushAll();
    assert.equal(calls.length, 2, 'both senders got a turn');
    assert.match(calls[0].input, /first claim/);
    assert.equal(calls[0].anchorAuthor, 'A', 'A processed first (arrival order)');
    assert.match(calls[1].input, /me too please/);
    assert.equal(calls[1].anchorAuthor, 'B', 'B processed second');
    assert.equal(a._sent.length, 1, 'A got a reply');
    assert.equal(b._sent.length, 1, 'B got a reply too');
  } finally {
    mock.timers.reset();
  }
});

test('a queued sender’s follow-ups fold into their own queued batch', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { handler, calls } = harness();
    await handler(makeMessage({ id: '1', authorId: 'A', content: 'A speaks', mentionsBot: true }));
    const b1 = makeMessage({ id: '2', authorId: 'B', content: 'B part one', mentionsBot: true });
    const b2 = makeMessage({ id: '3', authorId: 'B', content: 'B part two' });
    await handler(b1);
    await handler(b2); // no mention — folds into B's collecting batch
    mock.timers.tick(3000);
    await flushAll();
    assert.equal(calls.length, 2);
    assert.equal(calls[1].batchedCount, 2, 'B’s two messages became one input');
    assert.match(calls[1].input, /B part one/);
    assert.match(calls[1].input, /B part two/);
  } finally {
    mock.timers.reset();
  }
});

test('three senders are processed strictly in arrival order, one at a time', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const order = [];
    const { handler } = harness({
      reply: (invocation) => {
        order.push(invocation.message.author.id);
        return 'ok';
      },
    });
    await handler(makeMessage({ id: '1', authorId: 'A', content: 'a', mentionsBot: true }));
    await handler(makeMessage({ id: '2', authorId: 'B', content: 'b', mentionsBot: true }));
    await handler(makeMessage({ id: '3', authorId: 'C', content: 'c', mentionsBot: true }));
    mock.timers.tick(3000);
    await flushAll();
    assert.deepEqual(order, ['A', 'B', 'C']);
  } finally {
    mock.timers.reset();
  }
});

test('no batch is processed before its own 3s collection has elapsed', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { handler, calls } = harness();
    await handler(makeMessage({ id: '1', authorId: 'A', content: 'a', mentionsBot: true }));
    mock.timers.tick(2000);
    // B arrives at t=2000; B's window runs until t=5000.
    await handler(makeMessage({ id: '2', authorId: 'B', content: 'b', mentionsBot: true }));
    mock.timers.tick(1000); // t=3000: A flushes, B still collecting
    await flushAll();
    assert.equal(calls.length, 1, 'only A processed at t=3000');
    mock.timers.tick(2000); // t=5000: B's window elapsed
    await flushAll();
    assert.equal(calls.length, 2, 'B processed only after its own 3s');
  } finally {
    mock.timers.reset();
  }
});

test('a response is always sent — empty model output falls back to a reaction', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { handler } = harness({ reply: '' });
    const m = makeMessage({ id: '1', authorId: 'A', content: 'bye', mentionsBot: true });
    await handler(m);
    mock.timers.tick(3000);
    await flushAll();
    assert.equal(m._reacts.length, 1, 'fell back to a reaction so it is never silent');
    assert.equal(m._sent.length, 0);
  } finally {
    mock.timers.reset();
  }
});

test('bot senders trigger a response (respond to bots too)', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { handler, calls } = harness();
    const b = makeMessage({ id: '1', authorId: 'OTHERBOT', bot: true, content: 'yo panda', mentionsBot: true });
    await handler(b);
    mock.timers.tick(3000);
    await flushAll();
    assert.equal(calls.length, 1);
    assert.equal(b._sent.length, 1);
  } finally {
    mock.timers.reset();
  }
});

test('private mode: non-owner gets the canned refusal, model never runs', async () => {
  const { handler, calls } = harness({ privateOn: true });
  const m = makeMessage({ id: '1', authorId: 'GUEST', content: 'hi', mentionsBot: true });
  await handler(m);
  await flushAll();
  assert.equal(calls.length, 0, 'model not called for a blocked sender');
  assert.equal(m._sent.length, 1);
  assert.match(m._sent[0].content, /private conversation with Oscar/i);
});

test('windows are per-channel: two channels process independently', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { handler, calls } = harness();
    await handler(makeMessage({ id: '1', authorId: 'A', content: 'chan one', mentionsBot: true, channelId: 'c1' }));
    await handler(makeMessage({ id: '2', authorId: 'A', content: 'chan two', mentionsBot: true, channelId: 'c2' }));
    mock.timers.tick(3000);
    await flushAll();
    assert.equal(calls.length, 2, 'one turn per channel');
  } finally {
    mock.timers.reset();
  }
});

// --- link embed suppression -------------------------------------------------
import { suppressLinkEmbeds } from '../src/discord/messageHandler.js';

test('bare non-image links get wrapped in <> to suppress embeds', () => {
  assert.equal(
    suppressLinkEmbeds('see https://example.com/page and https://foo.dev'),
    'see <https://example.com/page> and <https://foo.dev>',
  );
});

test('image links stay bare so they still embed', () => {
  const s = 'here https://cdn.site/cat.jpg and https://cdn.site/dog.png?w=200';
  assert.equal(suppressLinkEmbeds(s), s);
});

test('already-wrapped and markdown links are left alone', () => {
  const s = 'wrapped <https://example.com> and [text](https://example.com/x)';
  assert.equal(suppressLinkEmbeds(s), s);
});

test('replies with wrapped links go out wrapped end-to-end', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { handler } = harness2link();
    const m = makeMessage({ id: '1', authorId: 'A', content: 'search something', mentionsBot: true });
    await handler(m);
    mock.timers.tick(3000);
    await flushAll();
    assert.equal(m._sent.length, 1);
    assert.match(m._sent[0].content, /<https:\/\/example\.com\/result>/);
  } finally {
    mock.timers.reset();
  }
});

function harness2link() {
  return harness({ reply: 'Found it: https://example.com/result' });
}
