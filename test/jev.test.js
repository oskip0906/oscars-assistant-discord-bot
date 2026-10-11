import test from 'node:test';
import assert from 'node:assert/strict';
import { decide } from '../src/agent/jev.js';
import { runAgent } from '../src/agent/agent.js';
import { signsOff, mentionsPanda } from '../src/discord/messageHandler.js';
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

const mention = { mayDecline: true };
const addressed = { addressed: { noul: 0.9 } };

test("only the tools Jev says yes to are offered, then the model answers with none", async () => {
  const calls = await turn({ ...addressed, use_get_user_id: { noul: 0.9 }, use_play_music: { noul: 0.2 } }, mention);
  assert.deepEqual(calls[0], { tools: ['get_user_id'], toolChoice: 'required' });
  assert.equal(calls[1].toolChoice, 'none');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.invocation.toolsUsed, ['get_user_id']);
});

test('a tool Jev is unsure of, or does not know, is never offered', async () => {
  for (const answers of [{ ...addressed, use_get_user_id: { noul: 0.4 } }, { ...addressed, use_made_up_tool: { noul: 0.99 } }]) {
    const calls = await turn(answers, mention);
    assert.deepEqual([...calls], [{ tools: [], toolChoice: 'none' }]);
  }
});

// --- sign-offs and name calls ----------------------------------------------

test('sign-off trusts Jev, and falls back to the regex when Jev is down', async () => {
  assert.equal(await signsOff('aight gn', 'bot', config, jev({ bye: { noul: 0.95 } })), true);
  assert.equal(await signsOff('bye!', 'bot', config, jev({ bye: { noul: 0.1 } })), false);
  assert.equal(await signsOff('bye!', 'bot', config, jev(null)), true);
});

test('only messages that may mean Panda become candidates', () => {
  for (const text of ['panda what is the weather', "ask oscar's assistant", 'the assistant of Oscar', 'Oscar’s thing is slow', 'is the bot down?'])
    assert.equal(mentionsPanda(text, config), true, text);
  for (const text of ['what is the weather', 'pandas are cute', 'nice robot']) assert.equal(mentionsPanda(text, config), false, text);
});

test('a mention-only turn is answered when Jev says it is addressed or worth stepping into', async () => {
  for (const answers of [{ addressed: { noul: 0.9 } }, { step_in: { noul: 0.85 } }]) {
    let accepted = 0;
    const calls = await turn(answers, { mayDecline: true, onAccept: () => accepted++ });
    assert.equal(calls.reply, 'done');
    assert.equal(accepted, 1);
  }
});

test('a mention-only turn Jev turns down, or cannot judge, gets no model call', async () => {
  for (const answers of [{ addressed: { noul: 0.3 }, step_in: { noul: 0.2 } }, null]) {
    const calls = await turn(answers, { mayDecline: true });
    assert.equal(calls.reply, null);
    assert.equal(calls.length, 0);
  }
});

test('a ping or reply is triaged by Jev but never turned down', async () => {
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
