import test from 'node:test';
import assert from 'node:assert/strict';
import { decide } from '../src/agent/jev.js';
import { runAgent } from '../src/agent/agent.js';
import { signsOff, forPanda, createMessageHandler } from '../src/discord/messageHandler.js';
import { supportedClaims } from '../src/agent/research/stages.js';

const config = { jevEnabled: true, openrouterApiKey: 'k', botName: 'Panda' };
const jev = (answers) => async () => answers;

// --- the client ------------------------------------------------------------

test('decide sends nothing when Jev is off and returns null on failure', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; return new Response('{}', { status: 500 }); };
  assert.equal(await decide({ ...config, jevEnabled: false }, {}, {}, { fetchImpl }), null);
  assert.equal(called, false);
  assert.equal(await decide(config, {}, {}, { fetchImpl }), null);
  const ok = async () => new Response(JSON.stringify({ answers: { a: { type: 'noul', noul: 0.9 } } }));
  assert.deepEqual(await decide(config, {}, {}, { fetchImpl: ok }), { a: { type: 'noul', noul: 0.9 } });
});

// --- tool picker -------------------------------------------------------------

function turn(answers, extra = {}) {
  const invocation = {
    ...extra,
    contextKey: 'g',
    config: { ...config, model: 'm', ownerId: '1' },
    isOwner: false,
    guild: null,
    message: { channel: { name: 'general' }, author: { id: '2', username: 'someone', displayName: 'Someone' } },
  };
  const calls = [];
  // Asked to call tools, it calls get_user_id; asked to answer, it says "done".
  const chat = async ({ tools, toolChoice }) => {
    calls.push({ tools: tools.map((t) => t.function.name), toolChoice });
    return toolChoice === 'required' ? { content: '', tool_calls: [{ id: '1', function: { name: 'get_user_id', arguments: '{}' } }] } : { content: 'done' };
  };
  return runAgent(invocation, 'q', 'q', { chat, decideImpl: jev(answers) }).then((reply) => Object.assign(calls, { reply, invocation }));
}

test("Jev's picks must be called, every tool is on offer, then the model answers", async () => {
  const calls = await turn({ use_get_user_id: { noul: 0.9 }, use_play_music: { noul: 0.2 } });
  assert.equal(calls[0].toolChoice, 'required');
  assert.ok(calls[0].tools.includes('get_user_id') && calls[0].tools.includes('web_fetch'));
  assert.equal(calls[1].toolChoice, 'auto');
  assert.equal(calls.length, 2, 'answering in round 2 saves the extra call');
  assert.deepEqual(calls.invocation.toolsUsed, ['get_user_id']);
});

test('with no sure pick (or a made-up one) nothing is forced: the model may answer straight away', async () => {
  for (const answers of [{ use_get_user_id: { noul: 0.4 } }, { use_made_up_tool: { noul: 0.99 } }]) {
    const calls = await turn(answers);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].toolChoice, 'auto');
    assert.ok(!calls[0].tools.includes('made_up_tool'));
    assert.equal(calls.reply, 'done');
  }
});

// --- sign-offs and name calls ----------------------------------------------

test('sign-off trusts Jev, and falls back to the regex when Jev is down', async () => {
  assert.equal(await signsOff('aight gn', 'bot', config, jev({ bye: { noul: 0.95 } })), true);
  assert.equal(await signsOff('bye!', 'bot', config, jev({ bye: { noul: 0.1 } })), false);
  assert.equal(await signsOff('bye!', 'bot', config, jev(null)), true);
});

// --- is it for Panda? ----------------------------------------------------------

const msg = (id, author, content) => ({ id, author: { id: author, username: author }, content, createdAt: new Date(Number(id)) });

test('Jev decides whether an unpinged message is for Panda, reading the 5 lines before it', async () => {
  const before = [msg('1', 'a', 'zero'), msg('2', 'a', 'one'), msg('3', 'b', 'two'), msg('4', 'a', 'three'), msg('5', 'bot', 'sunny today'), msg('6', 'a', 'nice')];
  let state;
  const yes = async (_c, s) => ((state = s), { addressed: { noul: 0.9 } });
  assert.equal(await forPanda(msg('7', 'a', 'and tomorrow?'), before, 'bot', config, yes, () => 0), 'talk');
  assert.equal(state.recent_messages.split('\n').length, 5);
  assert.ok(state.recent_messages.endsWith('(you) bot (@bot, id:bot): sunny today\na (@a, id:a): nice'));
  assert.equal(await forPanda(msg('7', 'a', 'panda?'), before, 'bot', config, jev(null)), false, 'Jev down means only pings, replies and DMs are answered');
});

const at = (answers, r, before = []) => forPanda(msg('7', 'a', 'hm'), before, 'bot', config, jev(answers), () => r);

test('unpinged, Panda talks only when Jev is at least 80% sure, never by chance', async () => {
  for (const r of [0, 0.5]) {
    assert.equal(await at({ addressed: { noul: 0.79 } }, r), false);
    assert.equal(await at({ follows_up: { noul: 0.79 } }, r, [msg('5', 'bot', 'hi')]), false);
  }
});

test('a maybe never talks: only the 80% addressed / follow-up checks do', async () => {
  for (const r of [0, 0.5]) assert.equal(await at({ for_assistant: { noul: 0.99 } }, r), false);
});

test('a ping or a reply to Panda is answered even when the gate would say no', async () => {
  const answered = [];
  const channel = { sendTyping: async () => {}, send: async () => ({}), messages: { fetch: async () => new Map() } };
  const handler = createMessageHandler({
    client: { user: { id: 'bot' } },
    config,
    player: null,
    privateMode: { isOn: () => false },
    runAgentImpl: async (invocation) => (answered.push(invocation.message.content), ''),
    decideImpl: jev({ for_assistant: { noul: 0 }, addressed: { noul: 0 }, follows_up: { noul: 0 } }),
  });
  const base = (id, content, extra) => ({
    ...msg(id, 'a', content), channelId: `c${id}`, channel, guild: { id: 'g' }, attachments: new Map(), embeds: [],
    react: async () => {}, reply: async () => ({}), mentions: { users: new Map() }, ...extra,
  });
  await handler(base('1', '<@bot> hi', { mentions: { users: new Map([['bot', {}]]) } }));
  await handler(base('2', 'same', { reference: { messageId: '0' }, fetchReference: async () => ({ author: { id: 'bot' } }) }));
  await handler(base('3', 'whatever'));
  for (let i = 0; i < 60 && answered.length < 2; i++) await new Promise((r) => setTimeout(r, 100));
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(answered.sort(), ['<@bot> hi', 'same']);
});

test('bots are judged exactly like people, reactions included', async () => {
  const bot = { ...msg('7', 'b', 'hm'), author: { id: 'b', username: 'b', bot: true } };
  assert.equal(await forPanda(bot, [], 'bot', config, jev({ addressed: { noul: 0.8 } }), () => 0.5), 'talk');
  assert.equal(await forPanda(bot, [], 'bot', config, jev({ worth_reacting: { noul: 0.8 } }), () => 0.5), 'react');
});

test('a message Jev is fairly sure is addressed to Panda is always answered, judged against identity.md', async () => {
  assert.equal(await at({ addressed: { noul: 0.8 } }, 0.999), 'talk', 'not sampled');
  assert.equal(await at({ addressed: { noul: 0.79 } }, 0.999), false);
  let seen;
  await forPanda(msg('7', 'a', 'hm'), [], 'bot', config, async (_c, s, q) => ((seen = { s, q }), null));
  assert.ok('assistant_identity' in seen.s);
  assert.match(seen.q.addressed.instructions, /assistant_identity/);
});

test("a reply to one of Panda's own lines is always answered, but only when Panda really said something there", async () => {
  const pandaSpoke = [msg('5', 'bot', 'pineapple belongs on pizza'), msg('6', 'b', 'lol')];
  assert.equal(await at({ follows_up: { noul: 0.8 } }, 0.999, pandaSpoke), 'talk', 'not sampled');
  assert.equal(await at({ follows_up: { noul: 0.8 } }, 0.999, [msg('6', 'b', 'lol')]), false, 'no (you) line, nothing to follow up');
  assert.equal(await at({ follows_up: { noul: 0.4 } }, 0.999, pandaSpoke), false);
});

test('a message not for Panda that stands out gets a reaction, sampled, and plain chatter does not', async () => {
  assert.equal(await at({ worth_reacting: { noul: 0.8 } }, 0.5), 'react');
  assert.equal(await at({ worth_reacting: { noul: 0.8 } }, 0.9), false, 'not every time');
  assert.equal(await at({ worth_reacting: { noul: 0.45 } }, 0), false, 'below the floor is never a reaction');
  assert.equal(await at({ addressed: { noul: 0.9 }, worth_reacting: { noul: 0.9 } }, 0.5), 'talk', 'talking wins over reacting');
});

test("the gate knows Panda's names, so another bot's nickname is not Panda", async () => {
  let state;
  const m = { ...msg('7', 'a', 'slopbot do u have any words'), client: { user: { id: 'bot', username: "Oscar's Assistant" } } };
  await forPanda(m, [], 'bot', config, async (_c, s, q) => ((state = { s, q }), null));
  assert.match(state.s.assistant_names, /Oscar's Assistant/);
  assert.match(state.s.assistant_names, /<@bot>/);
  assert.match(state.q.addressed.instructions, /slopbot.*NOT the assistant/);
});

test('turns go in the order they were sent, even when the later one passes Jev first', async () => {
  const answered = [];
  const channel = { sendTyping: async () => {}, send: async () => ({}), messages: { fetch: async () => new Map() } };
  const message = (id, author, content) => ({
    ...msg(id, author, content), channelId: 'c', channel, guild: { id: 'g' },
    mentions: { users: new Map() }, attachments: new Map(), embeds: [], react: async () => {}, reply: async () => ({}),
  });
  const handler = createMessageHandler({
    client: { user: { id: 'bot' } },
    config,
    player: null,
    privateMode: { isOn: () => false },
    runAgentImpl: async (invocation) => (answered.push(invocation.message.content), ''),
    // The earlier message's check is the slow one.
    decideImpl: async (_c, state) => {
      if (state.message.endsWith('first')) await new Promise((r) => setTimeout(r, 200));
      return { addressed: { noul: 1 } };
    },
  });
  await Promise.all([handler(message('1', 'a', 'first')), handler(message('2', 'b', 'second'))]);
  for (let i = 0; i < 60 && answered.length < 2; i++) await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(answered, ['first', 'second']);
});

test('every turn is triaged by Jev once and never turned down', async () => {
  let asked = 0;
  const invocation = {
    contextKey: 'g',
    config: { ...config, model: 'm', ownerId: '1' },
    message: { channel: { name: 'general' }, author: { id: '2', username: 'someone' } },
  };
  const reply = await runAgent(invocation, 'q', 'q', { chat: async () => ({ content: 'hi' }), decideImpl: async () => (asked++, null) });
  assert.equal(reply, 'hi');
  assert.equal(asked, 1);
});

// --- research claims ---------------------------------------------------------

test('drops claims Jev is sure the quote does not back, keeps all on failure', async () => {
  const claims = [
    { text: 'CMU funds every PhD', quote: 'CMU funds every PhD student in good standing.' },
    { text: 'CMU is free for undergrads', quote: 'CMU funds every PhD student in good standing.' },
  ];
  const kept = await supportedClaims(claims, config, jev({ supported_0: { noul: 0.97 }, supported_1: { noul: 0.05 } }));
  assert.deepEqual(kept, [claims[0]]);
  assert.deepEqual(await supportedClaims(claims, config, jev(null)), claims);
});
