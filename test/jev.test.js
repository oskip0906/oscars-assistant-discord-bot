import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { decide } from '../src/agent/jev.js';
import { runAgent } from '../src/agent/agent.js';
import { ContextStore } from '../src/agent/contextStore.js';
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
    contextStore: new ContextStore(mkdtempSync(path.join(tmpdir(), 'panda-jev-'))),
    contextKey: 'g',
    config: { ...config, model: 'm', maxToolIterations: 4, ownerId: '1', contextFilesDir: 'context' },
    isOwner: false,
    guild: null,
    message: { channel: { name: 'general' }, author: { id: '2', username: 'someone', displayName: 'Someone' } },
  };
  const calls = [];
  const replies = [
    { content: '', tool_calls: [{ id: '1', function: { name: 'get_user_id', arguments: '{}' } }] },
    { content: 'done' },
  ];
  const chat = async ({ tools, toolChoice }) => {
    calls.push({ tools: tools.map((t) => t.function.name), toolChoice });
    return replies.shift() ?? { content: 'done' };
  };
  return runAgent(invocation, 'q', 'q', { chat, decideImpl: jev(answers) }).then((reply) => Object.assign(calls, { reply, invocation }));
}

const mention = { mayDecline: true };
const addressed = { addressed: { noul: 0.9 } };

test('a confident Jev pick forces that tool on the first call only', async () => {
  const calls = await turn({ ...addressed, tool: { choice: 'get_user_id', probabilities: { get_user_id: 0.9 } } }, mention);
  assert.deepEqual(calls[0].toolChoice, { type: 'function', function: { name: 'get_user_id' } });
  assert.ok(calls[0].tools.includes('play_music'), 'forcing a tool never hides the others');
  assert.equal(calls[1].toolChoice, 'auto');
});

test('an unsure, unknown or "none" pick leaves the model to choose', async () => {
  for (const tool of [
    { choice: 'get_user_id', probabilities: { get_user_id: 0.5 } },
    { choice: 'made_up_tool', probabilities: { made_up_tool: 0.99 } },
    { choice: 'none', probabilities: { none: 0.99 } },
  ]) assert.equal((await turn({ ...addressed, tool }, mention))[0].toolChoice, 'auto');
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

test('a mention-only turn Jev turns down, or cannot judge, gets no model call and leaves no memory', async () => {
  for (const answers of [{ addressed: { noul: 0.3 }, step_in: { noul: 0.2 } }, null]) {
    const calls = await turn(answers, { mayDecline: true });
    assert.equal(calls.reply, null);
    assert.equal(calls.length, 0);
    assert.equal(calls.invocation.contextStore.pendingCount('g'), 0);
  }
});

test('a ping or reply goes straight to the model without asking Jev', async () => {
  let asked = 0;
  const invocation = {
    contextStore: new ContextStore(mkdtempSync(path.join(tmpdir(), 'panda-jev-'))),
    contextKey: 'g',
    config: { ...config, model: 'm', maxToolIterations: 4, ownerId: '1', contextFilesDir: 'context' },
    message: { channel: { name: 'general' }, author: { id: '2', username: 'someone' } },
  };
  const chat = async ({ toolChoice }) => ({ content: `auto=${toolChoice === 'auto'}` });
  const reply = await runAgent(invocation, 'q', 'q', { chat, decideImpl: async () => (asked++, null) });
  assert.equal(reply, 'auto=true');
  assert.equal(asked, 0);
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
