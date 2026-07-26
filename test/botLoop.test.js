import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createMessageHandler, isSignOff } from '../src/discord/messageHandler.js';

const BOT = 'BOT';
const flushAll = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
};

function makeMessage({ id, authorId, bot = false, content = '', mentionsBot = false, channelId = 'chan1', history = [] }) {
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
    channel: {
      sendTyping: async () => {},
      send: async (p) => sent.push(p),
      messages: {
        fetch: async (options) => {
          msg._fetchOptions = options;
          return new Map(history.map((h) => [h.id, h]));
        },
      },
    },
    reply: async (p) => sent.push(p),
    react: async (e) => reacts.push(e),
    fetchReference: async () => null,
  };
  msg._sent = sent;
  msg._reacts = reacts;
  return msg;
}

function harness({ remembered = [] } = {}) {
  const calls = [];
  const handler = createMessageHandler({
    client: { user: { id: BOT } },
    config: { ownerId: 'OWNER', allowBots: true, dmEnabled: true },
    contextStore: { get: () => [], append: () => {}, clear: () => {} },
    player: null,
    privateMode: { isOn: () => false },
    runAgentImpl: async (invocation, input, rememberContent) => {
      calls.push({ input, remembered: rememberContent, author: invocation.message.author.id });
      remembered.push(rememberContent);
      return 'REPLY';
    },
  });
  return { handler, calls, remembered };
}

// Drives one full trigger through the 3s collection window.
async function turn(handler, message) {
  await handler(message);
  mock.timers.tick(3000);
  await flushAll();
}

test('a bot exchange stops after a few rounds instead of running forever', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { handler, calls } = harness();

    // This is the slopbot transcript: every message pings back, so without a
    // budget the two bots trade pleasantries until one is rate-limited.
    for (let i = 1; i <= 8; i++) {
      await turn(handler, makeMessage({ id: `${i}`, authorId: 'SLOPBOT', bot: true, content: `round ${i}, anything else you need?`, mentionsBot: true }));
    }

    assert.equal(calls.length, 3, 'answers a few rounds, then holds off');
  } finally {
    mock.timers.reset();
  }
});

test('a human speaking in the channel gives the bot exchange a fresh budget', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { handler, calls } = harness();
    for (let i = 1; i <= 5; i++) {
      await turn(handler, makeMessage({ id: `b${i}`, authorId: 'SLOPBOT', bot: true, content: `round ${i}, anything else?`, mentionsBot: true }));
    }
    assert.equal(calls.length, 3);

    // Not even addressed to the bot — a human being present is the point.
    await handler(makeMessage({ id: 'h1', authorId: 'HUMAN', content: 'the context is fucked' }));
    await turn(handler, makeMessage({ id: 'b6', authorId: 'SLOPBOT', bot: true, content: 'can you look up Klaus?', mentionsBot: true }));

    assert.equal(calls.length, 4, 'the bot is answerable again once a human is in the room');
  } finally {
    mock.timers.reset();
  }
});

test('a sign-off from another bot gets a wave, not a reply', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { handler, calls } = harness();
    const bye = makeMessage({ id: '1', authorId: 'SLOPBOT', bot: true, content: 'See you later! Have a great day!', mentionsBot: true });

    await turn(handler, bye);

    assert.equal(calls.length, 0, 'nothing to answer — a reply here restarts the loop');
    assert.deepEqual(bye._reacts, ['👋']);
    assert.deepEqual(bye._sent, []);
  } finally {
    mock.timers.reset();
  }
});

test('a goodbye that still asks something is not treated as a sign-off', () => {
  assert.equal(isSignOff('bye!'), true);
  assert.equal(isSignOff('see you later'), true);
  assert.equal(isSignOff('bye, but can you check the queue first?'), false);
  assert.equal(isSignOff('what is the weather'), false);
});

test('the ping and the history around it are labelled separately', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { handler, calls } = harness();
    const history = [
      makeMessage({ id: 'h1', authorId: 'A', content: 'anyone seen Klaus?' }),
      makeMessage({ id: 'h2', authorId: 'B', content: 'its on jellyfin' }),
    ];
    const ping = makeMessage({ id: 'p1', authorId: 'A', content: 'panda whats it about', mentionsBot: true, history });

    await turn(handler, ping);

    const { input } = calls[0];
    assert.match(input, /\[HISTORY CONTEXT — the 2 message\(s\) before you were pinged/);
    assert.match(input, /\[END HISTORY CONTEXT\]/);
    assert.match(input, /\[RESPOND TO THIS — UA pinged you\./);
    // History is always included now: a self-contained question still needs to
    // know what the channel was talking about.
    assert.ok(input.indexOf('anyone seen Klaus?') < input.indexOf('[RESPOND TO THIS'));
    assert.ok(input.indexOf('whats it about') > input.indexOf('[RESPOND TO THIS'));
    // Anchored on the trigger, not "the last ten messages in the channel".
    assert.deepEqual(ping._fetchOptions, { limit: 10, before: 'p1' });
  } finally {
    mock.timers.reset();
  }
});

test('the history block is scaffolding for one reply, never written to memory', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { handler, calls } = harness();
    const history = [makeMessage({ id: 'h1', authorId: 'A', content: 'anyone seen Klaus?' })];
    const ping = makeMessage({ id: 'p1', authorId: 'A', content: 'panda whats it about', mentionsBot: true, history });

    await turn(handler, ping);

    // Storing it wrote ten already-stored messages back into memory every turn,
    // until the transcript was mostly duplicates and the model was reading its
    // own "do NOT reply to these" blocks as prior turns.
    assert.match(calls[0].input, /HISTORY CONTEXT/, 'the model still gets it for this reply');
    assert.doesNotMatch(calls[0].remembered, /HISTORY CONTEXT/, 'memory keeps only the turn');
    assert.doesNotMatch(calls[0].remembered, /anyone seen Klaus/);
    assert.match(calls[0].remembered, /whats it about/);
  } finally {
    mock.timers.reset();
  }
});

test('follow-ups inside the window are named in the label', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { handler, calls } = harness();
    const ping = makeMessage({ id: 'p1', authorId: 'A', content: 'panda look this up', mentionsBot: true });
    const followUp = makeMessage({ id: 'p2', authorId: 'A', content: 'i mean the 2019 one' });

    await handler(ping);
    await handler(followUp); // no ping needed — same sender, same window
    mock.timers.tick(3000);
    await flushAll();

    assert.equal(calls.length, 1);
    assert.match(calls[0].input, /then sent 1 more message\(s\) within 3 seconds/);
    assert.match(calls[0].input, /i mean the 2019 one/);
  } finally {
    mock.timers.reset();
  }
});
