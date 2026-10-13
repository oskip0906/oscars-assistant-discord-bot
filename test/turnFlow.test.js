import test from 'node:test';
import assert from 'node:assert/strict';
import { createMessageHandler, isStop } from '../src/discord/messageHandler.js';
import { turnSignal } from '../src/agent/openrouter.js';

// The real message handler end to end, with the agent stubbed: batching, what
// reaches the first model request, reply routing and stops.
const OSCAR = '111111111111111111';
const bot = { id: 'bot', username: 'Panda' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(check, ms = 3000) {
  for (let t = 0; t < ms && !check(); t += 10) await sleep(10);
  assert.ok(check(), 'timed out waiting');
}

function harness({ runAgentImpl, decideImpl = async () => null, config = {} }) {
  const sent = [];
  const channels = {};
  const handler = createMessageHandler({
    client: { user: bot },
    config: { botName: 'Panda', ownerId: OSCAR, openrouterApiKey: 'k', model: 'm', batchWindowMs: 100, ...config },
    player: null,
    privateMode: { isOn: () => false },
    runAgentImpl,
    decideImpl,
  });
  let n = 0;
  const msg = (author, content, { channelId = 'c1', ping = false, attachments = [], ref = null, replyToBot = false, before = [] } = {}) => {
    n += 1;
    const channel = (channels[channelId] ??= {
      id: channelId,
      fetches: 0,
      sendTyping: async () => {},
      send: async (p) => (sent.push({ channelId, content: p.content }), {}),
      // A page of Discord history: newest first, empty past the oldest.
      messages: {
        fetch: async (opts = {}) => {
          channel.fetches++;
          const page = before.some((m) => m.id === opts.before) ? [] : [...before].reverse();
          return Object.assign(new Map(page.map((m) => [m.id, m])), { last: () => page.at(-1) });
        },
      },
    });
    const m = {
      id: `m${n}`, content, channelId, channel, guild: { id: 'g' }, createdAt: new Date(Date.now() + n),
      author: { id: author, username: author },
      mentions: { users: new Map(ping ? [[bot.id, {}]] : []), repliedUser: replyToBot ? bot : (ref?.author ?? null) },
      attachments: new Map(attachments.map((a) => [a.id, a])), embeds: [],
      react: async () => {},
      reply: async (p) => (sent.push({ channelId, content: p.content }), {}),
      refFetches: 0,
    };
    if (ref) {
      m.reference = { messageId: ref.id };
      m.fetchReference = async () => (m.refFetches++, ref);
    }
    return m;
  };
  return { handler, msg, sent, channels };
}

const file = (id, name, contentType, size = 1000) => ({ id, name, contentType, size, url: `https://cdn.example/${name}` });
const other = (author, attachments = []) => ({ id: `r-${author}`, content: 'look', author: { id: author, username: author }, attachments: new Map(attachments.map((a) => [a.id, a])), embeds: [] });

test('the batch window defaults to 1.5s, and BATCH_WINDOW_MS changes it', async () => {
  const { config } = await import('../src/config.js');
  assert.equal(config.batchWindowMs, Number(process.env.BATCH_WINDOW_MS) || 1500);
});

test("boundary: a sender's follow-ups inside the window join their turn, another sender's ping is its own turn, and a ping after the window is a new turn", async () => {
  const turns = [];
  const { handler, msg } = harness({ runAgentImpl: async (_inv, _content, turn) => (turns.push(turn), 'ok') });
  await handler(msg('rice', '<@bot> hi', { ping: true }));
  await sleep(20);
  await handler(msg('rice', 'also this'));
  await handler(msg('derp', '<@bot> me too', { ping: true }));
  await waitFor(() => turns.length === 2);
  assert.match(turns[0], /hi[\s\S]*also this/);
  assert.doesNotMatch(turns[0], /me too/);
  assert.match(turns[1], /me too/);
  await handler(msg('rice', 'unpinged, after the window'));
  await handler(msg('rice', '<@bot> again', { ping: true }));
  await waitFor(() => turns.length === 3);
  assert.match(turns[2], /again/);
  assert.doesNotMatch(turns[2], /after the window/, 'Jev down: an unaddressed line after the window is not a turn');
});

test('attachments reach the first request: the current and replied-to ones, numbered, with sender and status, once each', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async (url) =>
    String(url).includes('openrouter.ai/api/v1/models')
      ? new Response(JSON.stringify({ data: [{ id: 'vision/m', architecture: { input_modalities: ['text', 'image'] } }] }))
      : new Response('TOTAL $12.40');
  try {
    const seen = [];
    const { handler, msg } = harness({ config: { model: 'vision/m' }, runAgentImpl: async (_inv, content) => (seen.push(content), 'ok') });
    const ref = other('derp', [file('a2', 'receipt.txt', 'text/plain')]);
    const old = { ...other('ana', [file('a9', 'old.png', 'image/png')]), id: 'm0', channel: {}, createdTimestamp: 0 };
    await handler(msg('rice', '<@bot> whats this', { ping: true, attachments: [file('a1', 'skyline.jpg', 'image/jpeg')], ref, before: [old] }));
    await handler(msg('rice', 'and the total?', { ref }));
    await waitFor(() => seen.length === 1);
    const [content] = seen;
    assert.ok(Array.isArray(content), 'media goes in the very first request');
    assert.match(content[0].text, /\[RESPOND TO THIS/);
    const text = content.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
    // Each file once, numbered, with its sender and whether it was sent; the
    // recent messages' files are listed too (#51), after the turn's own.
    assert.match(text, /#1 skyline\.jpg \(image\/jpeg, 1 KB\) from @rice in the turn: sent/);
    assert.match(text, /#2 receipt\.txt \(text\/plain, 1 KB\) from @derp in the message replied to: sent/);
    assert.match(text, /#3 old\.png .* in the recent messages/);
    assert.equal(text.match(/receipt\.txt \(/g).length, 1, 'replied to twice, listed once');
    assert.ok(content.some((p) => p.type === 'image_url'));
    assert.ok(content.some((p) => p.text === '[contents of receipt.txt]\nTOTAL $12.40'));
  } finally {
    globalThis.fetch = real;
  }
});

test('a reply whose message cannot be loaded says so', async () => {
  const seen = [];
  const { handler, msg } = harness({ runAgentImpl: async (_inv, _c, turn) => (seen.push(turn), 'ok') });
  const m = msg('rice', '<@bot> what about this', { ping: true });
  m.reference = { messageId: 'gone' };
  m.fetchReference = async () => {
    throw new Error('Unknown Message');
  };
  await handler(m);
  await waitFor(() => seen.length === 1);
  assert.match(seen[0], /replying to a message that could not be loaded/);
});

test('routing: a reply to Panda is known without fetching it twice, and an unpinged turn reuses the lines Jev already read', async () => {
  const { handler, msg, channels } = harness({
    runAgentImpl: async () => 'ok',
    decideImpl: async () => ({ addressed: { noul: 0.95 } }),
  });
  const toBot = msg('rice', 'yeah do that', { replyToBot: true, ref: { id: 'p1', content: 'want me to?', author: bot } });
  await handler(toBot);
  const named = msg('rice', 'panda whats in this pic', { channelId: 'c2', ref: other('derp') });
  await handler(named);
  const unpinged = msg('rice', 'can someone look this up', { channelId: 'c3' });
  await handler(unpinged);
  await sleep(400);
  assert.equal(toBot.refFetches, 1, 'only the turn reads the reply');
  assert.equal(named.refFetches, 1, 'the trigger check and the turn share one fetch');
  assert.equal(channels.c3.fetches, 1, 'Jev\'s 5 lines are the turn\'s background too');
});

test('isStop: only a whole-message stop meant for Panda', () => {
  const config = { botName: 'Panda', ownerId: OSCAR };
  const m = (content, author = 'rice') => ({ content, author: { id: author } });
  for (const text of ['<@bot> stop', 'stop', 'Cancel!', 'nvm', 'stop it', 'abort.']) assert.ok(isStop(m(text), config, bot, true), text);
  for (const text of ['panda stop', 'hey panda, cancel', 'stop panda', 'Panda: abort']) assert.ok(isStop(m(text), config, bot, false), text);
  for (const text of ['stop', 'cancel that', 'my bot stop']) assert.ok(!isStop(m(text), config, bot, false), `unaddressed: ${text}`);
  assert.ok(isStop(m('my bot stop', OSCAR), config, bot, false), "Oscar's \"my bot\"");
  for (const text of ['panda stop the music', 'can you stop by later', '<@bot> stop playing', 'dont stop']) assert.ok(!isStop(m(text), config, bot, true), text);
});

// An agent that runs a "slow" turn until it is stopped, then (too late)
// returns a reply; any other turn answers at once.
const untilStopped = (started) => async (inv, _content, turn) => {
  started.push({ inv, turn });
  if (!/slow/.test(turn)) return `quick reply to ${turn.split(': ').pop()}`;
  assert.equal(turnSignal.getStore(), inv.signal, 'model calls inside the turn see its stop');
  await new Promise((r) => inv.signal.addEventListener('abort', r));
  return 'late reply';
};

test('stop: a sender stops their own running and queued turns at once, not anyone else\'s; nothing stale is sent and the queue moves on', async () => {
  const started = [];
  const { handler, msg, sent } = harness({ runAgentImpl: untilStopped(started) });
  await handler(msg('rice', '<@bot> slow: research the whole internet', { ping: true }));
  await waitFor(() => started.length === 1);
  await handler(msg('rice', '<@bot> slow: and then this', { ping: true }));
  await handler(msg('derp', '<@bot> slow: my question', { ping: true }));
  // Derp's stop reaches only derp's queued turn.
  await handler(msg('derp', '<@bot> stop', { ping: true }));
  assert.equal(started[0].inv.signal.aborted, false);
  assert.equal(sent.filter((s) => s.content.startsWith('⏹️')).length, 1);
  // Rice, by name and unpinged, stops the running one and the queued one.
  await handler(msg('rice', 'panda stop'));
  assert.equal(started[0].inv.signal.aborted, true);
  assert.match(sent.at(-1).content, /^⏹️ Stopped 2 requests\. Anything already done stays done/);
  await sleep(300);
  assert.equal(started.length, 1, 'no stopped turn ever ran');
  assert.ok(!sent.some((s) => s.content.includes('late reply')));
  await handler(msg('rice', '<@bot> quick one', { ping: true }));
  await waitFor(() => sent.some((s) => s.content.startsWith('quick reply')));
});

test("stop: Oscar's stop reaches everyone's turns in that channel only; elsewhere it is an ordinary message", async () => {
  const started = [];
  const { handler, msg, sent } = harness({ runAgentImpl: untilStopped(started) });
  await handler(msg('rice', '<@bot> slow task', { ping: true }));
  await waitFor(() => started.length === 1);
  await handler(msg(OSCAR, '<@bot> stop', { ping: true, channelId: 'c2' }));
  await sleep(200);
  assert.equal(started[0].inv.signal.aborted, false, 'another channel is untouched');
  assert.ok(!sent.some((s) => s.content.startsWith('⏹️')));
  await handler(msg(OSCAR, '<@bot> stop', { ping: true }));
  assert.equal(started[0].inv.signal.aborted, true);
  assert.ok(sent.some((s) => s.channelId === 'c1' && s.content.startsWith('⏹️ Stopped.')));
  // c2's "stop" was an ordinary turn (e.g. stop the music), queued behind c1's on the server.
  await waitFor(() => started.length === 2);
  assert.match(started[1].turn, /stop/);
  await waitFor(() => sent.some((s) => s.channelId === 'c2' && s.content.startsWith('quick reply')));
});

test('stop racing the end of a turn: once stopped, the finished reply is never sent', async () => {
  let h;
  const { handler, msg, sent } = harness({
    runAgentImpl: async () => {
      await h.handler(h.msg('rice', '<@bot> stop', { ping: true }));
      return 'reply that is now stale';
    },
  });
  h = { handler, msg };
  await handler(msg('rice', '<@bot> go', { ping: true }));
  await waitFor(() => sent.some((s) => s.content.startsWith('⏹️')));
  await sleep(50);
  assert.ok(!sent.some((s) => s.content.includes('stale')));
});
