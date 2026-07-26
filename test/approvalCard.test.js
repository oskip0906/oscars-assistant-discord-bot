import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ApprovalCard } from '../src/discord/approvalCard.js';

const dataDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'panda-card-'));

function fakeClient(message) {
  return { channels: { fetch: async () => ({ messages: { fetch: async () => message } }) } };
}

test('a card left behind by a restart loses its buttons on the next boot', async () => {
  const dir = dataDir();
  new ApprovalCard(dir).remember('chan1', 'msg1');
  const edits = [];
  const client = fakeClient({ edit: async (payload) => edits.push(payload) });

  // A Discord button never expires, so before this the card sat there looking
  // live and clicking it only produced a confusing error.
  const retired = await new ApprovalCard(dir).retireStale(client);

  assert.equal(retired, true);
  assert.deepEqual(edits[0].components, []);
  assert.match(edits[0].content, /restarted while this was waiting/i);
  assert.doesNotMatch(edits[0].content, /expired/i);
});

test('an answered card is forgotten, so a later boot leaves it alone', async () => {
  const dir = dataDir();
  const card = new ApprovalCard(dir);
  card.remember('chan1', 'msg1');
  card.forget();
  let fetched = false;
  const client = { channels: { fetch: async () => { fetched = true; return null; } } };

  assert.equal(await new ApprovalCard(dir).retireStale(client), false);
  assert.equal(fetched, false);
});

test('a card that can no longer be fetched is dropped rather than retried forever', async () => {
  const dir = dataDir();
  new ApprovalCard(dir).remember('chan1', 'msg1');
  const client = { channels: { fetch: async () => { throw new Error('Unknown Channel'); } } };

  const card = new ApprovalCard(dir);
  assert.equal(await card.retireStale(client), false);
  assert.equal(card.read(), null);
});
