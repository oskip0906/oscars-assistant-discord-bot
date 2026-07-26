import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInteractionHandler } from '../src/discord/commands.js';
import { SelfFixState } from '../src/selfFixState.js';
import { approvalButtonId } from '../src/agent/tools/source.js';

const config = { ownerId: 'OWNER', projectRoot: '/tmp' };

function harness({ updateError } = {}) {
  const state = new SelfFixState();
  const { id, result } = state.beginApproval({ userId: 'OWNER' });
  const edits = [];
  const updates = [];
  const interaction = {
    isButton: () => true,
    customId: approvalButtonId(id, true),
    user: { id: 'OWNER' },
    message: { edit: async (payload) => edits.push(payload) },
    update: async (payload) => {
      if (updateError) throw updateError;
      updates.push(payload);
    },
  };
  const handler = createInteractionHandler({ client: {}, config, state });
  return { handler, interaction, state, result, edits, updates };
}

test('an approved click is answered before the development run is released', async () => {
  const { handler, interaction, state, result, updates } = harness();
  let answeredBeforeRelease = false;
  interaction.update = async (payload) => {
    // The run must still be waiting at this point: whatever it does next
    // (OpenRouter, GitHub) cannot be allowed to eat the 3-second reply budget.
    answeredBeforeRelease = state.isAwaitingConfirmation();
    updates.push(payload);
  };

  await handler(interaction);
  assert.equal(answeredBeforeRelease, true);
  assert.equal(await result, 'confirm');
  assert.match(updates[0].content, /approved/i);
  assert.deepEqual(updates[0].components, []);
});

test('a dead interaction token edits the message instead of crashing the client', async () => {
  const expired = Object.assign(new Error('Unknown interaction'), { code: 10062 });
  const { handler, interaction, result, edits } = harness({ updateError: expired });

  await handler(interaction);
  assert.equal(await result, 'confirm');
  assert.match(edits[0].content, /approved/i);
});

test('a click from anyone but Oscar neither approves nor throws', async () => {
  const { handler, interaction, state } = harness();
  interaction.user = { id: 'SOMEONE_ELSE' };
  let replied = '';
  interaction.reply = async (payload) => {
    replied = payload.content;
  };

  await handler(interaction);
  assert.match(replied, /Only Oscar/);
  assert.equal(state.isAwaitingConfirmation(), true);
});

test('a stale button reports the expiry rather than releasing a run', async () => {
  const { handler, interaction, state } = harness();
  state.end();
  let replied = '';
  interaction.reply = async (payload) => {
    replied = payload.content;
  };

  await handler(interaction);
  assert.match(replied, /expired/i);
});
