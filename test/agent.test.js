import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runAgent, saysNothing } from '../src/agent/agent.js';
import { ContextStore } from '../src/agent/contextStore.js';

// The model reacts with 🎲 (asking to reply or not), then would answer `final`.
async function reactThen(reply, final, react = async () => {}) {
  const invocation = {
    contextStore: new ContextStore(mkdtempSync(path.join(tmpdir(), 'panda-agent-'))),
    contextKey: 'g',
    config: { openrouterApiKey: 'k', botName: 'Panda', model: 'm', maxToolIterations: 4, ownerId: '1', contextFilesDir: 'context' },
    message: { channel: { name: 'general' }, author: { id: '2', username: 'someone' }, react },
    reacted: false,
  };
  const replies = [
    { content: '', tool_calls: [{ id: '1', function: { name: 'react', arguments: JSON.stringify({ emoji: '🎲', reply }) } }] },
    { content: final },
  ];
  let calls = 0;
  const text = await runAgent(invocation, 'q', 'q', { chat: async () => (calls++, replies.shift()) });
  return { text, calls };
}

test('a reaction with reply:false ends the turn before the model can add "Got it"', async () => {
  assert.deepEqual(await reactThen(false, 'Got it'), { text: '', calls: 1 });
});

test('a reaction with reply:true still sends the answer, but not an echoed emoji', async () => {
  assert.equal((await reactThen(true, '🎲 rolled a 4')).text, '🎲 rolled a 4');
  assert.equal((await reactThen(true, '🎲')).text, '');
  assert.equal((await reactThen(true, ' 🎲 <:dice:123> ! ')).text, '');
});

test('a reaction that fails does not end the turn', async () => {
  const failing = async () => { throw new Error('Unknown Emoji'); };
  assert.deepEqual(await reactThen(false, 'rolled a 4', failing), { text: 'rolled a 4', calls: 2 });
});

test('saysNothing only matches text without letters or digits', () => {
  assert.ok(saysNothing('👍🔥'));
  assert.ok(saysNothing('<a:spin:42>'));
  assert.ok(!saysNothing('ok'));
  assert.ok(!saysNothing('4'));
});
