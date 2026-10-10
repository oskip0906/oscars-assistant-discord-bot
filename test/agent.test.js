import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runAgent, saysNothing } from '../src/agent/agent.js';
import { ContextStore } from '../src/agent/contextStore.js';

// One turn with Jev's `answers` and the model scripted to give `replies` in order.
async function turn(answers, replies, extra = {}) {
  const reactions = [];
  const invocation = {
    contextStore: new ContextStore(mkdtempSync(path.join(tmpdir(), 'panda-agent-'))),
    contextKey: 'g',
    config: { openrouterApiKey: 'k', botName: 'Panda', model: 'm', maxToolIterations: 4, ownerId: '1', contextFilesDir: 'context' },
    message: { channel: { name: 'general' }, author: { id: '2', username: 'someone' }, react: async (e) => { reactions.push(e); } },
    isOwner: false,
    reacted: false,
    ...extra,
  };
  const calls = [];
  const chat = async ({ tools, toolChoice }) => {
    calls.push({ tools: tools.map((t) => t.function.name), toolChoice });
    return replies.shift() ?? { content: 'done' };
  };
  const text = await runAgent(invocation, 'q', 'q', { chat, decideImpl: async () => answers });
  return { text, calls, reactions };
}

const sure = (choice, p = 0.95) => ({ choice, probabilities: { [choice]: p } });
const reactCall = (...emojis) => ({
  content: '',
  tool_calls: emojis.map((emoji, i) => ({ id: String(i), function: { name: 'react', arguments: JSON.stringify({ emoji }) } })),
});
const force = (name) => ({ type: 'function', function: { name } });

test('reaction only: the model must react, and the turn ends before it can add "Got it"', async () => {
  const { text, calls, reactions } = await turn({ respond_with: sure('reaction') }, [reactCall('🎲', '🔥'), { content: 'Got it' }]);
  assert.equal(text, '');
  assert.deepEqual(reactions, ['🎲', '🔥']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].toolChoice, 'required');
});

test("reaction only with a tool: Jev's tool runs first, then the reaction ends the turn", async () => {
  const tool = { content: '', tool_calls: [{ id: 't', function: { name: 'get_message_sender', arguments: '{}' } }] };
  const { text, calls } = await turn(
    { needs_tool: { noul: 0.9 }, tool: sure('get_message_sender'), respond_with: sure('reaction') },
    [tool, reactCall('👍'), { content: 'Got it' }],
  );
  assert.equal(text, '');
  assert.deepEqual(calls.map((c) => c.toolChoice), [force('get_message_sender'), 'required']);
});

test('reaction only: the model may look something up first, and the turn ends at the reaction', async () => {
  const lookup = { content: '', tool_calls: [{ id: 't', function: { name: 'get_message_sender', arguments: '{}' } }] };
  const { text, calls } = await turn({ respond_with: sure('reaction') }, [lookup, reactCall('⛅'), { content: 'Got it' }]);
  assert.equal(text, '');
  assert.deepEqual(calls.map((c) => c.toolChoice), ['required', 'required']);
});

test('message only: the model gets no react tool and its text is sent', async () => {
  const { text, calls } = await turn({ respond_with: sure('message') }, [{ content: '391' }]);
  assert.equal(text, '391');
  assert.ok(!calls[0].tools.includes('react'));
  assert.equal(calls[0].toolChoice, 'auto');
});

test('both: the model must react first, then answers in text', async () => {
  const { text, calls, reactions } = await turn({ respond_with: sure('both') }, [reactCall('🔥'), { content: '17 × 23 = 391' }]);
  assert.equal(text, '17 × 23 = 391');
  assert.deepEqual(reactions, ['🔥']);
  assert.deepEqual(calls.map((c) => c.toolChoice), ['required', 'auto']);
});

test('an unsure "reaction only" leaves the choice to the model', async () => {
  const { calls } = await turn({ respond_with: sure('reaction', 0.6) }, [{ content: 'hi' }]);
  assert.equal(calls[0].toolChoice, 'auto');
  assert.ok(calls[0].tools.includes('react'));
});

test('a sign-off gets a wave and no model call', async () => {
  const { text, calls, reactions } = await turn({ bye: { noul: 0.93 }, respond_with: sure('message') }, []);
  assert.equal(text, '');
  assert.deepEqual(reactions, ['👋']);
  assert.equal(calls.length, 0);
});

test('a request that needs an Oscar-only tool stops for anyone else', async () => {
  const answers = { needs_tool: { noul: 0.9 }, tool: sure('clear_context'), respond_with: sure('message') };
  const guest = await turn(answers, []);
  assert.equal(guest.text, 'Only Oscar can use `clear_context`.');
  assert.equal(guest.calls.length, 0);
  const owner = await turn(answers, [{ content: 'done' }], { isOwner: true });
  assert.deepEqual(owner.calls[0].toolChoice, force('clear_context'));
});

test('with Jev down the model decides, and an emoji echoed after a reaction is dropped', async () => {
  const { text, calls } = await turn(null, [reactCall('🎲'), { content: '🎲' }]);
  assert.equal(text, '');
  assert.deepEqual(calls.map((c) => c.toolChoice), ['auto', 'auto']);
  assert.equal((await turn(null, [reactCall('🎲'), { content: 'rolled a 4' }])).text, 'rolled a 4');
});

test('saysNothing only matches text without letters or digits', () => {
  assert.ok(saysNothing('👍🔥'));
  assert.ok(saysNothing('<a:spin:42>'));
  assert.ok(!saysNothing('ok'));
  assert.ok(!saysNothing('4'));
});
