import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgent, saysNothing, isFiller, moodEmoji, MOOD_EMOJI, MAX_MODEL_CALLS } from '../src/agent/agent.js';

// One turn with Jev's `answers` and the model scripted to give `replies` in order.
async function turn(answers, replies, extra = {}) {
  const reactions = [];
  const invocation = {
    contextKey: 'g',
    config: { openrouterApiKey: 'k', botName: 'Panda', model: 'm', ownerId: '1' },
    message: { channel: { name: 'general' }, author: { id: '2', username: 'someone' }, react: async (e) => { reactions.push(e); } },
    isOwner: false,
    reacted: false,
    ...extra,
  };
  const calls = [];
  const chat = async ({ tools, toolChoice }) => {
    calls.push({ tools: (tools ?? []).map((t) => t.function.name), toolChoice });
    return replies.shift() ?? { content: 'done' };
  };
  const text = await runAgent(invocation, 'q', 'q', { chat, decideImpl: async () => answers, random: extra.random });
  return { text, calls, reactions, invocation };
}

const sure = (choice, p = 0.95) => ({ choice, probabilities: { [choice]: p } });
const yes = (...names) => Object.fromEntries(names.map((name) => [`use_${name}`, { noul: 0.9 }]));
const step = (...names) => ({ content: '', tool_calls: names.map((name, i) => ({ id: String(i), function: { name, arguments: '{}' } })) });
const reactCall = (...emojis) => ({
  content: '',
  tool_calls: emojis.map((emoji, i) => ({ id: String(i), function: { name: 'react', arguments: JSON.stringify({ emoji }) } })),
});

test('reaction only: one call that may only react, and the turn ends before it can add "Got it"', async () => {
  const { text, calls, reactions } = await turn({ respond_with: sure('reaction') }, [reactCall('🎲', '🔥'), { content: 'Got it' }]);
  assert.equal(text, '');
  assert.deepEqual(reactions, ['🎲'], 'at most one reaction per message: the first one asked for');
  assert.deepEqual(calls, [{ tools: ['react'], toolChoice: 'required' }]);
});

test("reaction only with a tool: Jev's tool and the reaction go in the same single call", async () => {
  const reactAndLook = { content: '', tool_calls: [...step('get_message_sender').tool_calls, { id: 'r', function: { name: 'react', arguments: '{"emoji":"👍"}' } }] };
  const { text, calls, reactions } = await turn({ ...yes('get_message_sender'), respond_with: sure('reaction') }, [reactAndLook, { content: 'Got it' }]);
  assert.equal(text, '');
  assert.deepEqual(reactions, ['👍']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].toolChoice, 'required');
  assert.deepEqual([...calls[0].tools].sort(), ['get_message_sender', 'react']);
});

test('no tools picked: every tool is still offered, and an answer without a call is sent from that one call', async () => {
  const { text, calls } = await turn({ respond_with: sure('message') }, [{ content: '391' }]);
  assert.equal(text, '391');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].toolChoice, 'auto');
  assert.ok(calls[0].tools.includes('web_fetch') && calls[0].tools.includes('web_search'), 'a link can always be read');
  assert.ok(!calls[0].tools.includes('react'), 'no reaction on a text-only turn');
  assert.ok(!calls[0].tools.includes('self_fix'), "Oscar's tools are not offered to a guest");
});

test('Jev picks several tools: they run in one round, then the model answers with nothing left to call', async () => {
  const { text, calls, invocation } = await turn({ ...yes('get_message_sender', 'get_user_id'), respond_with: sure('message') }, [
    step('get_message_sender', 'get_user_id', 'not_a_tool'),
    { content: 'you are someone' },
  ]);
  assert.equal(text, 'you are someone');
  assert.equal(calls.length, 2);
  assert.ok(['get_message_sender', 'get_user_id', 'web_fetch'].every((name) => calls[0].tools.includes(name)));
  assert.equal(calls[0].toolChoice, 'required', "Jev's picks must be acted on");
  assert.equal(calls[1].toolChoice, 'auto', 'a second round may call the tools again, or answer');
  assert.deepEqual(invocation.toolsUsed, ['get_message_sender', 'get_user_id'], 'a tool that was not offered never runs');
});

test('both: the model reacts, then answers in text, and an echoed emoji is dropped', async () => {
  const { text, calls, reactions } = await turn({ respond_with: sure('both') }, [reactCall('🔥'), { content: '17 × 23 = 391' }]);
  assert.equal(text, '17 × 23 = 391');
  assert.deepEqual(reactions, ['🔥']);
  assert.deepEqual(calls.map((c) => c.toolChoice), ['required', 'auto'], 'once it has reacted it may use a tool or answer');
  assert.ok(!calls[1].tools.includes('react'), 'one reaction round only');
  assert.equal((await turn({ respond_with: sure('both') }, [reactCall('🎲'), { content: '🎲' }])).text, '');
});

test('"reaction only" on a turn that needs words reacts and answers', async () => {
  const { text, reactions } = await turn({ respond_with: sure('reaction'), needs_words: { noul: 0.8 } }, [reactCall('😂'), { content: 'it was the cat' }]);
  assert.equal(text, 'it was the cat');
  assert.deepEqual(reactions, ['😂']);
});

test('a turn owed words never gets only a reaction, whatever the odds', async () => {
  const odds = { respond_with: { choice: 'reaction', probabilities: { reaction: 0.9, message: 0.1 } }, needs_words: { noul: 0.7 } };
  for (const r of [0, 0.5, 0.999]) {
    const { calls } = await turn(odds, [reactCall('😂'), { content: 'it was the cat' }], { random: () => r });
    assert.notDeepEqual(calls.map((c) => c.toolChoice), ['required'], 'not a turn that ends at the reaction');
  }
});

test('a ping or reply always gets words: text or text + reactions, never only a reaction', async () => {
  const odds = { respond_with: { choice: 'reaction', probabilities: { reaction: 0.99, message: 0.01 } }, needs_words: { noul: 0 } };
  for (const r of [0, 0.5, 0.999]) {
    const invocation = { contextKey: 'g', config: { openrouterApiKey: 'k', botName: 'Panda', model: 'm' }, message: { channel: {}, author: { id: '2' }, react: async () => {} }, direct: true };
    // The model reacts when it may, then answers.
    const chat = async ({ tools }) => (tools?.some((t) => t.function.name === 'react') && !invocation.reacted ? reactCall('😂') : { content: 'lmao same' });
    assert.equal(await runAgent(invocation, 'q', 'q', { chat, decideImpl: async () => odds, random: () => r }), 'lmao same');
  }
  const echoed = await turn({ respond_with: sure('both') }, [reactCall('🔥'), { content: '🔥' }], { direct: true });
  assert.equal(echoed.text, '🔥', 'an emoji-only reply to a ping is still sent');
});

test('a turn Panda joined only to react is a reaction with no tools and no words', async () => {
  const { text, calls, reactions } = await turn({ ...yes('get_message_sender'), respond_with: sure('message') }, [reactCall('💀'), { content: 'lol' }], { reactOnly: true });
  assert.equal(text, '');
  assert.deepEqual(calls, [{ tools: ['react'], toolChoice: 'required' }]);
  assert.deepEqual(reactions, ['💀']);
});

test('the form is sampled from Jev\'s odds, so reactions happen even when text is likelier', async () => {
  const odds = { respond_with: { choice: 'message', probabilities: { message: 0.6, reaction: 0.25, both: 0.15 } } };
  // random 0 lands on the first option, random ~1 on the last.
  assert.ok(!(await turn(odds, [{ content: 'hi' }], { random: () => 0 })).calls[0].tools.includes('react'));
  assert.ok((await turn(odds, [reactCall('👀')], { random: () => 0.999 })).calls[0].tools.includes('react'));
});

test('the mood sets the tone and which reactions are suggested, varied each turn', async () => {
  const seen = [];
  const chat = async ({ messages }) => (seen.push(messages.map((m) => m.content).join('\n')), seen.length === 1 ? reactCall('🫂') : { content: 'that sucks, sorry' });
  const invocation = { contextKey: 'g', config: { openrouterApiKey: 'k', botName: 'Panda', model: 'm', ownerId: '1' }, message: { channel: {}, author: { id: '2', username: 'x' }, react: async () => {} } };
  await runAgent(invocation, 'q', 'my dog died', { chat, decideImpl: async () => ({ respond_with: sure('both'), mood: sure('sad') }) });
  assert.match(seen[0], /\[TONE\] Jev reads the turn as sad/);
  assert.ok(MOOD_EMOJI.sad.some((e) => seen[0].includes(e)), 'sad reactions are suggested');
  assert.notDeepEqual(moodEmoji('funny', () => 0), moodEmoji('funny', () => 0.99), 'suggestions vary');
});

test(`a turn never makes more than ${MAX_MODEL_CALLS} model calls, the last one the answer`, async () => {
  const replies = Array.from({ length: 10 }, () => step('get_message_sender'));
  const { calls } = await turn({ ...yes('get_message_sender'), respond_with: sure('message') }, replies);
  assert.equal(calls.length, MAX_MODEL_CALLS);
  assert.equal(calls.at(-1).toolChoice, 'none');
});

test('a sign-off gets a wave and no model call', async () => {
  const { text, calls, reactions } = await turn({ bye: { noul: 0.93 }, respond_with: sure('message') }, []);
  assert.equal(text, '');
  assert.deepEqual(reactions, ['👋']);
  assert.equal(calls.length, 0);
});

test('a request that needs an Oscar-only tool stops for anyone else', async () => {
  const answers = { ...yes('set_rule'), respond_with: sure('message') };
  const guest = await turn(answers, []);
  assert.equal(guest.text, 'Only Oscar can use `set_rule`.');
  assert.equal(guest.calls.length, 0);
  const owner = await turn(answers, [{ content: 'done' }], { isOwner: true });
  assert.ok(owner.calls[0].tools.includes('set_rule'));
  assert.equal(owner.calls[0].toolChoice, 'required');
});

test('with Jev down every tool is still offered, and one call can answer', async () => {
  const { text, calls } = await turn(null, [{ content: 'rolled a 4' }]);
  assert.equal(text, 'rolled a 4');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].toolChoice, 'auto');
  assert.ok(calls[0].tools.includes('web_fetch'));
});

test('Jev gets one yes/no per tool (react excepted) and the recent messages', async () => {
  let seen;
  const invocation = { contextKey: 'g', config: { openrouterApiKey: 'k', botName: 'Panda', model: 'm', ownerId: '1' }, message: { channel: { name: 'general' }, author: { id: '2', username: 'someone' } }, recent: 'Rice: the menu is broken' };
  await runAgent(invocation, 'q', 'fix that', { chat: async () => ({ content: 'ok' }), decideImpl: async (_config, state, questions) => ((seen = { state, questions }), null) });
  assert.equal(seen.state.message, 'fix that');
  assert.equal(seen.state.recent_messages, 'Rice: the menu is broken');
  assert.equal(seen.questions.use_play_music.type, 'noul');
  assert.ok(seen.questions.use_self_fix, 'owner-only tools are asked about too, so a guest gets told no');
  assert.ok(!seen.questions.use_react);
});

test('a reference nothing shown explains sends the model to search history, though Jev did not pick the tool', async () => {
  const seen = [];
  const replies = [step('fetch_history'), { content: 'the hackathon? yes!' }];
  const chat = async ({ messages, tools, toolChoice }) => (seen.push({ note: messages.at(-1).content, tools: tools.map((t) => t.function.name), toolChoice }), replies.shift());
  const invocation = { contextKey: 'g', config: { openrouterApiKey: 'k', botName: 'Panda', model: 'm', ownerId: '1' }, message: { channel: { name: 'general' }, author: { id: '2', username: 'someone' } } };
  const text = await runAgent(invocation, 'q', 'are you excited for the event', { chat, decideImpl: async () => ({ unexplained: { noul: 0.95 }, use_fetch_history: { noul: 0.1 }, respond_with: sure('message') }) });
  assert.equal(text, 'the hackathon? yes!');
  assert.ok(seen[0].tools.includes('fetch_history'));
  assert.equal(seen[0].toolChoice, 'required');
  assert.match(seen[0].note, /fetch_history with a `query`/);
  assert.deepEqual(invocation.toolsUsed, ['fetch_history']);
});

test('a reference the recent messages explain does not search history', async () => {
  const { calls } = await turn({ unexplained: { noul: 0.73 }, respond_with: sure('message') }, [{ content: 'on it' }]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].toolChoice, 'auto', 'not sent to search history');
});

test('saysNothing only matches text without letters or digits', () => {
  assert.ok(saysNothing('👍🔥'));
  assert.ok(saysNothing('<a:spin:42>'));
  assert.ok(!saysNothing('ok'));
  assert.ok(!saysNothing('4'));
});

test("the bot's secrets never reach the model or a message, however they leak", async () => {
  const { config, redactSecrets } = await import('../src/config.js');
  const saved = { ...config };
  Object.assign(config, { discordToken: 'MTIz.discord.token', openrouterApiKey: 'sk-or-v1-abcdef', githubPat: 'ghp_abcdefgh', databaseUrl: 'postgresql://app:pg_pass_1234@db:5432/app' });
  try {
    assert.equal(
      redactSecrets('key sk-or-v1-abcdef, pat ghp_abcdefgh, db postgresql://app:pg_pass_1234@db:5432/app, pw pg_pass_1234, bot MTIz.discord.token'),
      'key [redacted], pat [redacted], db [redacted], pw [redacted], bot [redacted]',
    );
    // A tool whose output contains a secret: the model only ever sees it redacted.
    const seen = [];
    const leaky = step('get_message_sender');
    const invocation = {
      contextKey: 'g',
      config: { openrouterApiKey: 'k', botName: 'Panda', model: 'm', ownerId: '1' },
      message: { channel: { name: 'general' }, author: { id: '2', username: 'sk-or-v1-abcdef' } },
      isOwner: false,
    };
    const replies = [leaky, { content: 'done' }];
    await runAgent(invocation, 'q', 'q', { chat: async ({ messages }) => (seen.push(...messages), replies.shift()), decideImpl: async () => yes('get_message_sender') });
    const toolResult = seen.find((m) => m.role === 'tool').content;
    assert.match(toolResult, /\[redacted\]/);
    assert.ok(!toolResult.includes('sk-or-v1-abcdef'));
  } finally {
    Object.assign(config, saved);
  }
});

test('every tool a turn calls is recorded, in order, for the line above the reply', async () => {
  const { toolsLine } = await import('../src/discord/messageHandler.js');
  const { invocation } = await turn(yes('get_message_sender', 'get_user_id'), [step('get_message_sender', 'get_user_id', 'get_message_sender'), { content: 'done' }]);
  assert.deepEqual(invocation.toolsUsed, ['get_message_sender', 'get_user_id', 'get_message_sender']);
  assert.equal(toolsLine(invocation.toolsUsed), '-# 🔧 get_message_sender ×2 · get_user_id');
  assert.equal(toolsLine([]), '');
  assert.equal(toolsLine(['react', 'react']), '', 'a reaction is never shown as a tool');
  assert.equal(toolsLine(['react', 'web_search']), '-# 🔧 web_search');
});

test('isFiller matches empty and "🐼 …" style output, never a real reply or a chosen emoji', () => {
  for (const text of ['', '   \n\t', '🐼 …', '🐼', '🐼 ...', '…', '...', ' 🐼  … ', null, undefined]) assert.ok(isFiller(text), JSON.stringify(text));
  for (const text of ['ok', '4', '🔥', '🐼 hi', 'no.', '<:panda:42>']) assert.ok(!isFiller(text), text);
});

test('a reply with nothing to say signs off: a wave and no message', async () => {
  for (const content of ['', '   ', '🐼 …', '🐼', '...', null]) {
    for (const direct of [false, true]) {
      const { text, reactions, invocation } = await turn({ respond_with: sure('message') }, [{ content }, { content }], { direct });
      assert.equal(text, '', `${JSON.stringify(content)} is not sent`);
      assert.deepEqual(reactions, ['👋'], `${JSON.stringify(content)} signs off once`);
      assert.equal(invocation.reacted, true);
    }
  }
});

test('signing off after a reaction adds no second reaction', async () => {
  const { text, reactions } = await turn({ respond_with: sure('both') }, [reactCall('🔥'), { content: '🐼 …' }], { direct: true });
  assert.equal(text, '');
  assert.deepEqual(reactions, ['🔥']);
});

test('a real reply is sent as is, with no sign-off', async () => {
  const { text, reactions } = await turn({ respond_with: sure('message') }, [{ content: '  sure, 7pm works  ' }], { direct: true });
  assert.equal(text, 'sure, 7pm works');
  assert.deepEqual(reactions, []);
});
