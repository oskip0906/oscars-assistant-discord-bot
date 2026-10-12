import test from 'node:test';
import assert from 'node:assert/strict';
import { reactOnce, hasReacted, clearReactionClaims } from '../src/discord/reactions.js';
import { react } from '../src/agent/tools/discord.js';
import { runAgent } from '../src/agent/agent.js';

// A message whose react() records what landed, optionally failing every call.
const message = (id, { fails = false, reactions } = {}) => {
  const added = [];
  return {
    id,
    added,
    reactions,
    react: async (emoji) => {
      added.push(emoji);
      if (fails) throw new Error('Missing Permissions');
    },
  };
};

test('a message matching several reaction triggers gets exactly one reaction, the first asked for', async () => {
  clearReactionClaims();
  const m = message('r1');
  // The wave, the model's picks and the 👀 fallback all at once.
  const results = await Promise.all([reactOnce(m, '👋'), reactOnce(m, '😂'), reactOnce(m, '🔥'), reactOnce(m, '👀')]);
  assert.deepEqual(m.added, ['👋']);
  assert.deepEqual(results, [true, false, false, false]);
  assert.equal(hasReacted(m), true);
});

test('a repeat attempt on the same message adds nothing, even through a new object for it', async () => {
  clearReactionClaims();
  const first = message('r2');
  assert.equal(await reactOnce(first, '👍'), true);
  const again = message('r2');
  assert.equal(await reactOnce(again, '🎉'), false);
  assert.deepEqual(again.added, []);
});

test("a message Panda already reacted to on Discord (e.g. before a restart) gets nothing more", async () => {
  clearReactionClaims();
  const m = message('r3', { reactions: { cache: [{ me: false }, { me: true }] } });
  assert.equal(await reactOnce(m, '🔥'), false);
  assert.deepEqual(m.added, []);
});

test('a failed reaction is not retried and not swapped for another emoji', async () => {
  clearReactionClaims();
  const m = message('r4', { fails: true });
  assert.equal(await reactOnce(m, '<:gone:1>'), false);
  assert.equal(await reactOnce(m, '👀'), false);
  assert.deepEqual(m.added, ['<:gone:1>'], 'one try, then nothing');
  assert.equal(hasReacted(m), false);
});

test('the react tool adds one reaction per message and says so when asked for more', async () => {
  clearReactionClaims();
  const m = message('r5');
  const invocation = { message: m, reacted: false };
  assert.match(await react({ emoji: '😂' }, invocation), /Reacted with 😂/);
  assert.match(await react({ emoji: '💀' }, invocation), /at most one reaction/);
  assert.deepEqual(m.added, ['😂']);
  assert.equal(invocation.reacted, true);

  const broken = { message: message('r6', { fails: true }), reacted: false };
  assert.match(await react({ emoji: '😂' }, broken), /no other reaction will be tried/);
  assert.equal(broken.reacted, false);
});

test('a turn whose model asks for several reactions in one step adds one', async () => {
  clearReactionClaims();
  const m = { ...message('r7'), channel: { name: 'general' }, author: { id: '2', username: 'someone' } };
  const invocation = { contextKey: 'g', config: { openrouterApiKey: 'k', botName: 'Panda', model: 'm', ownerId: '1' }, message: m, isOwner: false, reacted: false };
  const calls = ['🎲', '🔥', '😂'].map((emoji, i) => ({ id: String(i), function: { name: 'react', arguments: JSON.stringify({ emoji }) } }));
  const chat = async () => ({ content: '', tool_calls: calls });
  const decideImpl = async () => ({ respond_with: { choice: 'reaction', probabilities: { reaction: 0.95 } } });
  assert.equal(await runAgent(invocation, 'q', 'q', { chat, decideImpl }), '');
  assert.deepEqual(m.added, ['🎲']);
});
