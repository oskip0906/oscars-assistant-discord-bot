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

test("only the tools Jev says yes to are offered, then the model answers with none", async () => {
  const calls = await turn({ use_get_user_id: { noul: 0.9 }, use_play_music: { noul: 0.2 } });
  assert.deepEqual(calls[0], { tools: ['get_user_id'], toolChoice: 'required' });
  assert.equal(calls[1].toolChoice, 'none');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.invocation.toolsUsed, ['get_user_id']);
});

test('a tool Jev is unsure of, or does not know, is never offered', async () => {
  for (const answers of [{ use_get_user_id: { noul: 0.4 } }, { use_made_up_tool: { noul: 0.99 } }]) {
    const calls = await turn(answers);
    assert.deepEqual([...calls], [{ tools: [], toolChoice: 'none' }]);
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

test('Jev decides whether an unpinged message is for Panda, reading only the 2 lines before it', async () => {
  const before = [msg('1', 'a', 'one'), msg('2', 'bot', 'sunny today'), msg('3', 'a', 'nice')];
  let state;
  const yes = async (_c, s) => ((state = s), { for_assistant: { noul: 0.9 } });
  assert.equal(await forPanda(msg('4', 'a', 'and tomorrow?'), before, 'bot', config, yes), true);
  assert.equal(state.recent_messages, '(you) bot (@bot, id:bot): sunny today\na (@a, id:a): nice');
  assert.equal(await forPanda(msg('4', 'a', 'lol'), before, 'bot', config, jev({ for_assistant: { noul: 0.6 } })), false);
  assert.equal(await forPanda(msg('4', 'a', 'panda?'), before, 'bot', config, jev(null)), false, 'Jev down means only pings, replies and DMs are answered');
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
    selfFix: { isActive: () => false },
    runAgentImpl: async (invocation) => (answered.push(invocation.message.content), ''),
    // The earlier message's check is the slow one.
    decideImpl: async (_c, state) => {
      if (state.message.endsWith('first')) await new Promise((r) => setTimeout(r, 200));
      return { for_assistant: { noul: 0.9 } };
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
