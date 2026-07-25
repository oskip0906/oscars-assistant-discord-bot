import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dmOwner } from '../src/discord/notify.js';

// A stand-in Discord client that records what got DM'd to whom.
function fakeClient({ fetchFails = false, sendFails = false } = {}) {
  const sent = [];
  const fetched = [];
  return {
    sent,
    fetched,
    users: {
      fetch: async (id) => {
        fetched.push(id);
        if (fetchFails) throw new Error('Unknown User');
        return {
          send: async (content) => {
            if (sendFails) throw new Error('Cannot send messages to this user');
            sent.push(content);
          },
        };
      },
    },
  };
}

test('a finished self-fix is DMed straight to the owner', async () => {
  const client = fakeClient();

  await dmOwner(client, 'OWNER', '🛠️ self_fix finished.');

  assert.deepEqual(client.fetched, ['OWNER']);
  assert.deepEqual(client.sent, ['🛠️ self_fix finished.']);
});

test('a long report is split into sendable chunks', async () => {
  const client = fakeClient();

  await dmOwner(client, 'OWNER', 'x'.repeat(4500));

  assert.ok(client.sent.length > 1, 'should be split');
  assert.ok(client.sent.every((c) => c.length <= 2000), 'every chunk must fit Discord’s cap');
  assert.equal(client.sent.join(''), 'x'.repeat(4500));
});

test('a DM that cannot be delivered never takes the caller down', async () => {
  await assert.doesNotReject(() => dmOwner(fakeClient({ sendFails: true }), 'OWNER', 'hi'));
  await assert.doesNotReject(() => dmOwner(fakeClient({ fetchFails: true }), 'OWNER', 'hi'));
  await assert.doesNotReject(() => dmOwner(null, 'OWNER', 'hi'));
});

test('an empty report is not sent at all', async () => {
  const client = fakeClient();
  await dmOwner(client, 'OWNER', '   ');
  assert.equal(client.sent.length, 0);
});
