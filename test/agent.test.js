import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgent, saysNothing, isFiller, moodEmoji, MOOD_EMOJI, MAX_MODEL_CALLS, CORE_TOOLS } from '../src/agent/agent.js';

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
  const chat = async ({ tools, toolChoice, messages, reasoning }) => {
    calls.push({ tools: (tools ?? []).map((t) => t.function.name), toolChoice, messages, reasoning });
    return replies.shift() ?? { content: 'done' };
  };
  const text = await runAgent(invocation, 'q', 'q', { chat, decideImpl: async () => answers, random: extra.random });
  return { text, calls, reactions, invocation };
}

const sure = (choice, p = 0.95) => ({ choice, probabilities: { [choice]: p } });
const yes = (...names) => Object.fromEntries(names.map((name) => [`use_${name}`, { noul: 0.9 }]));
// The model saying it doesn't know enough, asking for these lookups.
const needMore = (...names) => ({ content: '', tool_calls: [{ id: 'n', function: { name: 'need_more_info', arguments: JSON.stringify({ missing: 'x', tools: names }) } }] });
const step = (...names) => ({ content: '', tool_calls: names.map((name, i) => ({ id: String(i), function: { name, arguments: '{}' } })) });
const reactCall = (...emojis) => ({
  content: '',
  tool_calls: emojis.map((emoji, i) => ({ id: String(i), function: { name: 'react', arguments: JSON.stringify({ emoji }) } })),
});

test('reaction only: one call that may only react, and the turn ends before it can add "Got it"', async () => {
  const { text, calls, reactions } = await turn({ respond_with: sure('reaction') }, [reactCall('🎲', '🔥'), { content: 'Got it' }]);
  assert.equal(text, '');
  assert.deepEqual(reactions, ['🎲'], 'at most one reaction per message: the first one asked for');
  assert.deepEqual(calls.map(({ tools, toolChoice }) => ({ tools, toolChoice })), [{ tools: ['react'], toolChoice: 'auto' }], 'a reaction is never forced');
});

test('reaction only, but the model wrote words instead: a suggested emoji stands in and nothing is said, with no extra call', async () => {
  const { text, calls, reactions } = await turn({ respond_with: sure('reaction'), mood: sure('happy') }, [{ content: 'nice one!' }], { random: () => 0 });
  assert.equal(text, '');
  assert.equal(calls.length, 1);
  assert.equal(reactions.length, 1);
  assert.ok(MOOD_EMOJI.happy.includes(reactions[0]));
});

test("reaction only with a tool: Jev's tool and the reaction go in the same single call", async () => {
  const reactAndLook = { content: '', tool_calls: [...step('get_message_sender').tool_calls, { id: 'r', function: { name: 'react', arguments: '{"emoji":"👍"}' } }] };
  const { text, calls, reactions } = await turn({ ...yes('get_message_sender'), respond_with: sure('reaction') }, [reactAndLook, { content: 'Got it' }]);
  assert.equal(text, '');
  assert.deepEqual(reactions, ['👍']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].toolChoice, 'auto');
  assert.deepEqual([...calls[0].tools].sort(), ['get_message_sender', 'react']);
});

test('no tools picked: no lookups either, just more_tools and need_more_info, and an answer without a call is sent from that one call', async () => {
  const { text, calls } = await turn({ respond_with: sure('message') }, [{ content: '391' }]);
  assert.equal(text, '391');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].toolChoice, 'auto');
  assert.deepEqual(calls[0].tools, ['more_tools', 'need_more_info'], 'answer first: lookups only once the model says it needs them');
  assert.ok(!calls[0].messages.some((m) => String(m.content).startsWith('[TOOLS]')), 'no tool note when there is nothing to say');
});

test('need_more_info opens the lookups it names (with web_search and web_fetch) for the next round, and the answer comes from them', async () => {
  const { text, calls, invocation } = await turn({ respond_with: sure('message') }, [needMore('wiki_search'), step('wiki_search'), { content: 'per wikipedia, 1889' }]);
  assert.equal(text, 'per wikipedia, 1889');
  assert.equal(calls.length, 3);
  assert.deepEqual([...calls[1].tools].sort(), ['more_tools', 'web_fetch', 'web_search', 'wiki_search']);
  assert.match(calls[1].messages.find((m) => m.role === 'tool').content, /^Opened: wiki_search, web_search, web_fetch|^Opened: web_search, web_fetch, wiki_search|^Opened: web_search, wiki_search, web_fetch/);
  assert.deepEqual(invocation.toolsUsed, ['wiki_search'], 'need_more_info is plumbing, not shown as a tool');
});

test('a lookup called without need_more_info never runs, and more_tools cannot open one', async () => {
  const more = { content: '', tool_calls: [{ id: 'm', function: { name: 'more_tools', arguments: '{"names":["web_search"]}' } }] };
  const { text, calls, invocation } = await turn({ respond_with: sure('message') }, [step('web_search'), { content: 'from memory' }]);
  assert.deepEqual(invocation.toolsUsed ?? [], [], 'the call is dropped, nothing runs');
  assert.equal(text, 'from memory');
  assert.deepEqual(calls.map((c) => c.toolChoice), ['auto', 'none'], 'it answers with nothing left to call');
  const viaMore = await turn({ respond_with: sure('message') }, [more, step('web_search'), { content: 'still no search' }]);
  assert.match(viaMore.calls[1].messages.find((m) => m.role === 'tool').content, /^Nothing added/);
  assert.ok(!viaMore.calls[1].tools.includes('web_search'));
});

test('more_tools adds an action tool the sender may use for the next round; Oscar-only tools stay out of reach for a guest', async () => {
  const more = (...names) => ({ content: '', tool_calls: [{ id: 'm', function: { name: 'more_tools', arguments: JSON.stringify({ names }) } }] });
  const { text, calls, invocation } = await turn({ respond_with: sure('message') }, [more('add_reminder', 'self_fix'), step('add_reminder'), { content: 'set' }]);
  assert.equal(text, 'set');
  const offer = calls.map((c) => c.tools);
  assert.ok(!offer[0].includes('add_reminder'));
  assert.ok(offer[1].includes('add_reminder'), 'added for the next round');
  assert.ok(offer.every((tools) => !tools.includes('self_fix')), 'never offered to a guest');
  assert.match(calls[1].messages.find((m) => m.role === 'tool').content, /Added: add_reminder\./);
  assert.deepEqual(invocation.toolsUsed, ['add_reminder'], 'more_tools is plumbing, not shown as a tool');
});

test('Jev picks several action tools: they run in one round, then the model answers with nothing left to call', async () => {
  const { text, calls, invocation } = await turn({ ...yes('create_poll', 'add_reminder'), respond_with: sure('message') }, [
    step('create_poll', 'add_reminder', 'not_a_tool'),
    { content: 'done both' },
  ]);
  assert.equal(text, 'done both');
  assert.equal(calls.length, 2);
  assert.ok(['create_poll', 'add_reminder', 'need_more_info'].every((name) => calls[0].tools.includes(name)));
  assert.ok(!calls[0].tools.includes('web_fetch'), 'no lookups before the model asks for them');
  assert.equal(calls[0].toolChoice, 'auto', "Jev's picks are advice, never forced");
  assert.match(calls[0].messages.at(-1).content, /Jev's guess at tools that may help: .*create_poll.* Advice, not a must/);
  assert.equal(calls[1].toolChoice, 'auto', 'a second round may call the tools again, or answer');
  assert.deepEqual(invocation.toolsUsed, ['create_poll', 'add_reminder'], 'a tool that was not offered never runs');
});

test('both: the model reacts, then answers in text, and an echoed emoji is dropped', async () => {
  const { text, calls, reactions } = await turn({ respond_with: sure('both') }, [reactCall('🔥'), { content: '17 × 23 = 391' }]);
  assert.equal(text, '17 × 23 = 391');
  assert.deepEqual(reactions, ['🔥']);
  assert.deepEqual(calls.map((c) => c.toolChoice), ['auto', 'auto'], 'reacting is never forced either');
  assert.ok(!calls[1].tools.includes('react'), 'one reaction round only');
  assert.equal((await turn({ respond_with: sure('both') }, [reactCall('🎲'), { content: '🎲' }])).text, '');
});

test('a reaction sent together with the reply\'s words is answered in that one call', async () => {
  const both = { content: '7pm at Ana\'s', tool_calls: reactCall('🕖').tool_calls };
  const { text, calls, reactions } = await turn({ respond_with: sure('both') }, [both, { content: 'never asked for' }]);
  assert.equal(text, "7pm at Ana's");
  assert.deepEqual(reactions, ['🕖']);
  assert.equal(calls.length, 1);
  assert.match(calls[0].messages.at(-1).content, /in the same message as the reaction/);
});

test('"reaction only" on a turn that needs words reacts and answers', async () => {
  const { text, reactions } = await turn({ respond_with: sure('reaction'), needs_words: { noul: 0.8 } }, [reactCall('😂'), { content: 'it was the cat' }]);
  assert.equal(text, 'it was the cat');
  assert.deepEqual(reactions, ['😂']);
});

test('a turn owed words never gets only a reaction, whatever the odds', async () => {
  const odds = { respond_with: { choice: 'reaction', probabilities: { reaction: 0.9, message: 0.1 } }, needs_words: { noul: 0.7 } };
  for (const r of [0, 0.5, 0.999]) {
    const { text } = await turn(odds, [reactCall('😂'), { content: 'it was the cat' }], { random: () => r });
    assert.equal(text, 'it was the cat', 'not a turn that ends at the reaction');
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
  assert.deepEqual(calls.map(({ tools, toolChoice }) => ({ tools, toolChoice })), [{ tools: ['react'], toolChoice: 'auto' }]);
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
  const replies = Array.from({ length: 10 }, () => step('create_poll'));
  const { calls } = await turn({ ...yes('create_poll'), respond_with: sure('message') }, replies);
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
  assert.equal(owner.calls[0].toolChoice, 'auto');
});

test('with Jev down every action tool the sender may use is offered, lookups still wait for need_more_info, and one call can answer', async () => {
  const { text, calls } = await turn(null, [{ content: 'rolled a 4' }]);
  assert.equal(text, 'rolled a 4');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].toolChoice, 'auto');
  assert.ok(['add_reminder', 'play_music', 'create_poll', 'need_more_info'].every((name) => calls[0].tools.includes(name)));
  assert.ok(!calls[0].tools.includes('web_fetch') && !calls[0].tools.includes('research'));
  assert.ok(!calls[0].tools.includes('self_fix') && !calls[0].tools.includes('more_tools'), "Oscar's tools stay his; no action left to add");
});

test('a guest starts with just the action tools Jev picked; Oscar with Jev down gets every action tool, his own included', async () => {
  const picked = await turn({ ...yes('create_poll', 'research'), respond_with: sure('message') }, [{ content: 'ok' }]);
  assert.deepEqual(picked.calls[0].tools, ['create_poll', 'more_tools', 'need_more_info'], 'research is a lookup: reachable through need_more_info');
  const full = await turn(null, [{ content: 'ok' }], { isOwner: true });
  assert.ok(full.calls[0].tools.includes('self_fix'));
  assert.ok(picked.calls[0].tools.length * 5 < full.calls[0].tools.length);
});

test('a real lookup keeps its multiple rounds: ask, search, read, then answer', async () => {
  const fetchCall = { content: '', tool_calls: [{ id: 'f', function: { name: 'web_fetch', arguments: '{"url":"https://example.com"}' } }] };
  const { calls, invocation } = await turn({ respond_with: sure('message') }, [needMore('web_search'), step('web_search'), fetchCall, { content: 'answer' }]);
  assert.equal(calls.length, 4);
  assert.ok(calls.every((c) => c.toolChoice === 'auto'));
  assert.deepEqual(invocation.toolsUsed, ['web_search', 'web_fetch']);
});

test('a stopped turn makes no more model calls and runs none of the tools the model asked for', async () => {
  const ac = new AbortController();
  let ran = 0;
  const invocation = {
    contextKey: 'g', config: { openrouterApiKey: 'k', botName: 'Panda', model: 'm', ownerId: '1' }, signal: ac.signal,
    message: { channel: {}, author: { id: '2', username: 'x' }, react: async () => { ran++; } },
  };
  const chat = async () => {
    ac.abort();
    return reactCall('🔥');
  };
  await assert.rejects(runAgent(invocation, 'q', 'q', { chat, decideImpl: async () => ({ respond_with: sure('both') }) }), { name: 'AbortError' });
  assert.equal(ran, 0, 'the stale reaction never lands');
  assert.equal(invocation.stats.modelCalls, 0);
  // Stopped before the turn even reached the model.
  ac.abort();
  let called = false;
  await assert.rejects(runAgent({ ...invocation, signal: ac.signal }, 'q', 'q', { chat: async () => ((called = true), { content: 'x' }), decideImpl: async () => null }), { name: 'AbortError' });
  assert.equal(called, false);
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
  assert.equal(seen.questions.think.type, 'noul');
  assert.match(seen.questions.think.instructions, /careful step-by-step thinking/);
});

test("Jev's think score turns on low reasoning for every call of a hard turn, and nothing else does", async () => {
  const think = (noul, extra = {}) => ({ respond_with: sure('message'), think: { noul }, ...extra });
  const hard = await turn(think(0.6, yes('create_poll')), [step('create_poll'), { content: 'x' }]);
  assert.deepEqual(hard.calls.map((c) => c.reasoning), [{ effort: 'low' }, { effort: 'low' }]);
  assert.deepEqual((await turn(think(0.4), [{ content: 'x' }])).calls[0].reasoning, { effort: 'low' }, 'the bar is 0.4');
  // No override: chatCompletion's default, reasoning off.
  assert.equal((await turn(think(0.1), [{ content: 'x' }])).calls[0].reasoning, undefined);
  assert.equal((await turn(think(0.39), [{ content: 'x' }])).calls[0].reasoning, undefined);
  assert.equal((await turn(null, [{ content: 'x' }])).calls[0].reasoning, undefined, 'Jev down');
  // A reaction has nothing to think over, however hard the question.
  assert.equal((await turn({ ...think(0.9), respond_with: sure('reaction') }, [reactCall('🔥')])).calls[0].reasoning, undefined);
  assert.equal((await turn(think(0.9), [reactCall('💀')], { reactOnly: true })).calls[0].reasoning, undefined);
});

test('a reference nothing shown explains points the model at fetch_history, which it opens only if it needs to', async () => {
  const seen = [];
  const replies = [needMore('fetch_history'), step('fetch_history'), { content: 'the hackathon? yes!' }];
  const chat = async ({ messages, tools, toolChoice }) => (seen.push({ note: messages.at(-1).content, tools: tools.map((t) => t.function.name), toolChoice }), replies.shift());
  const invocation = { contextKey: 'g', config: { openrouterApiKey: 'k', botName: 'Panda', model: 'm', ownerId: '1' }, message: { channel: { name: 'general' }, author: { id: '2', username: 'someone' } } };
  const text = await runAgent(invocation, 'q', 'are you excited for the event', { chat, decideImpl: async () => ({ unexplained: { noul: 0.95 }, use_fetch_history: { noul: 0.1 }, respond_with: sure('message') }) });
  assert.equal(text, 'the hackathon? yes!');
  assert.ok(!seen[0].tools.includes('fetch_history') && seen[0].tools.includes('need_more_info'));
  assert.equal(seen[0].toolChoice, 'auto', 'advice, not forced');
  assert.match(seen[0].note, /need_more_info for fetch_history/);
  assert.ok(seen[1].tools.includes('fetch_history'));
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
    const replies = [needMore('get_message_sender'), leaky, { content: 'done' }];
    await runAgent(invocation, 'q', 'q', { chat: async ({ messages }) => (seen.push(...messages), replies.shift()), decideImpl: async () => yes('get_message_sender') });
    const toolResult = seen.find((m) => m.role === 'tool' && m.tool_call_id !== 'n').content;
    assert.match(toolResult, /\[redacted\]/);
    assert.ok(!toolResult.includes('sk-or-v1-abcdef'));
  } finally {
    Object.assign(config, saved);
  }
});

test('every tool a turn calls is recorded, in order, for the line above the reply', async () => {
  const { toolsLine } = await import('../src/discord/messageHandler.js');
  const { invocation } = await turn(yes('create_poll', 'add_reminder'), [step('create_poll', 'add_reminder', 'create_poll'), { content: 'done' }]);
  assert.deepEqual(invocation.toolsUsed, ['create_poll', 'add_reminder', 'create_poll']);
  assert.equal(toolsLine(invocation.toolsUsed), '-# 🔧 create_poll ×2 · add_reminder');
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

test('the reply ends with the tokens, cost and time the turn took', async () => {
  const { statsLine } = await import('../src/discord/messageHandler.js');
  assert.equal(statsLine(undefined, 100), '');
  assert.equal(
    statsLine({ inputTokens: 1204, outputTokens: 87, cost: 0.00213, modelMs: 2900 }, 4210),
    '-# 📥 1,204 in · 📤 87 out · 💸 $0.0021 · ⏱️ 4.2s total · 🧠 2.9s model',
  );
});

test('a turn adds up the tokens and cost of every model call it makes', async () => {
  const invocation = { contextKey: 'g', config: { openrouterApiKey: 'k', botName: 'Panda', model: 'm', ownerId: '1' }, message: { channel: { name: 'general' }, author: { id: '2', username: 'someone' } }, isOwner: false };
  const chat = async ({ onUsage }) => (onUsage({ prompt_tokens: 100, completion_tokens: 20, cost: 0.001 }), { content: 'hi there' });
  assert.equal(await runAgent(invocation, 'q', 'q', { chat, decideImpl: async () => ({ respond_with: sure('message') }) }), 'hi there');
  assert.equal(invocation.stats.inputTokens, 100);
  assert.equal(invocation.stats.outputTokens, 20);
  assert.equal(invocation.stats.cost, 0.001);
  assert.ok(invocation.stats.modelMs >= 0);
});
