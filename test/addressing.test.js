import test from 'node:test';
import assert from 'node:assert/strict';
import { addressee, createMessageHandler } from '../src/discord/messageHandler.js';

const OSCAR = '111111111111111111';
const config = { jevEnabled: true, openrouterApiKey: 'k', botName: 'Panda', ownerId: OSCAR };
const bot = { id: 'bot', username: 'Panda' };
const from = (author, content, extra = {}) => ({ content, author: { id: author, username: author }, mentions: { users: new Map() }, ...extra });

test('"my bot" and "my assistant" mean Panda only when Oscar says them', () => {
  for (const text of ['my bot is acting up lol', 'can my assistant look this up', 'hey my bot, play something']) {
    assert.equal(addressee(from(OSCAR, text), config, bot), 'panda', text);
    assert.equal(addressee(from('guest', text), config, bot), null, `from a guest: ${text}`);
  }
});

test('other people call Panda "panda bot", "Oscar\'s bot", "the bot" or Panda', () => {
  const texts = ['panda bot whats the weather', "Oscar's bot, what's 2+2", 'oscars bot can you help', 'hey the bot, you there?', 'yo panda play lofi', 'what does pandabot think', "is oscar's assistant awake"];
  for (const text of texts) assert.equal(addressee(from('guest', text), config, bot), 'panda', text);
  // Its Discord name counts too.
  assert.equal(addressee(from('guest', 'bamboo, you up?'), config, { id: 'bot', username: 'Bamboo' }), 'panda');
  // Unrelated words don't.
  for (const text of ['pandas are so cute', 'my bot is better', 'nice weather today']) assert.equal(addressee(from('guest', text), config, bot), null, text);
});

test('a message put to Oscar is his, not Panda\'s', () => {
  const texts = ['Oscar, can you send the doc?', 'hey oscar how was the trip', 'oscar do you have the file', 'can you help me oscar?', 'is the bot down, oscar?'];
  for (const text of texts) assert.equal(addressee(from('guest', text), config, bot), 'owner', text);
  assert.equal(addressee(from('guest', `<@${OSCAR}> u free later?`), config, bot), 'owner', 'his @mention');
  assert.equal(addressee(from('guest', 'same, what time?'), config, bot, { author: { id: OSCAR } }), 'owner', 'a reply to him');
  // Calling Panda first keeps it Panda's, and talk about Oscar is not to him.
  assert.equal(addressee(from('guest', 'Panda, ask oscar if he is free'), config, bot), 'panda');
  assert.equal(addressee(from('guest', 'oscar is cooking tonight'), config, bot), null);
  assert.equal(addressee(from(OSCAR, 'oscar here, my bot ok?'), config, bot), 'panda', 'Oscar is never kept from his own bot');
});

// The real handler with Jev scripted, answering whatever reaches the agent.
async function answered(messages, answers) {
  const seen = [];
  const channel = { sendTyping: async () => {}, send: async () => ({}), messages: { fetch: async () => new Map() } };
  const handler = createMessageHandler({
    client: { user: bot },
    config,
    player: null,
    privateMode: { isOn: () => false },
    runAgentImpl: async (invocation) => (seen.push(invocation.message.content), 'ok'),
    decideImpl: async () => answers,
  });
  let id = 0;
  for (const [author, content, extra] of messages) {
    id += 1;
    await handler({
      ...from(author, content, extra), id: `m${id}`, channelId: `c${id}`, channel, guild: { id: 'g' }, createdAt: new Date(id),
      attachments: new Map(), embeds: [], react: async () => {}, reply: async () => ({}),
    });
  }
  // Each batch collects for 3s before it runs.
  for (let i = 0; i < 60 && seen.length < messages.length; i++) await new Promise((r) => setTimeout(r, 100));
  return seen;
}

test('with Jev down, Panda still answers when called by name, and Oscar\'s "my bot" counts but a guest\'s does not', async () => {
  const seen = await answered(
    [[OSCAR, 'my bot what time is it'], ['guest', 'panda bot tell me a joke'], ['guest', "Oscar's bot, hi"], ['guest', 'my bot is way faster']],
    null,
  );
  assert.deepEqual(seen.sort(), ["Oscar's bot, hi", 'my bot what time is it', 'panda bot tell me a joke']);
});

test('a message directed at Oscar gets no reply from Panda, even when Jev would have joined in', async () => {
  const seen = await answered(
    [['guest', 'Oscar, can you send me the slides?'], ['guest', `<@${OSCAR}> are you coming tonight?`, { mentions: { users: new Map([[OSCAR, {}]]) } }]],
    { for_assistant: { noul: 1 }, addressed: { noul: 1 }, worth_reacting: { noul: 1 } },
  );
  assert.deepEqual(seen, []);
});

// One ping through the real handler, the agent stubbed to return `reply`.
async function replied(reply, { reacted = false } = {}) {
  const reactions = [];
  const sent = [];
  let done;
  const finished = new Promise((r) => (done = r));
  const channel = { sendTyping: async () => {}, send: async (p) => (sent.push(p.content), {}), messages: { fetch: async () => new Map() } };
  const handler = createMessageHandler({
    client: { user: bot },
    config,
    player: null,
    privateMode: { isOn: () => false },
    runAgentImpl: async (invocation) => {
      if (reacted) invocation.reacted = (await invocation.message.react('🔥'), true);
      setTimeout(done, 50);
      return reply;
    },
    decideImpl: async () => null,
  });
  const id = `s${Math.random()}`;
  await handler({
    ...from('guest', `<@${bot.id}> hey`, { mentions: { users: new Map([[bot.id, {}]]) } }), id, channelId: id, channel, guild: { id: 'g' }, createdAt: new Date(),
    attachments: new Map(), embeds: [], react: async (e) => { reactions.push(e); }, reply: async (p) => (sent.push(p.content), {}),
  });
  await finished;
  return { reactions, sent };
}

test('a reply with nothing in it ("🐼 …", empty, blank) is never sent: Panda signs off with a wave', async () => {
  const results = await Promise.all(['🐼 …', '', '  \n ', '🐼', '...'].map((reply) => replied(reply)));
  for (const { reactions, sent } of results) {
    assert.deepEqual(sent, []);
    assert.deepEqual(reactions, ['👋']);
  }
  const after = await replied('🐼 …', { reacted: true });
  assert.deepEqual(after, { reactions: ['🔥'], sent: [] }, 'one reaction, no message');
});

test('a real reply is sent once, with no sign-off', async () => {
  assert.deepEqual(await replied('sure, 7pm works'), { reactions: [], sent: ['sure, 7pm works'] });
});
