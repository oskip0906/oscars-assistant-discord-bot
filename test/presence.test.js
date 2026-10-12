import test from 'node:test';
import assert from 'node:assert/strict';
import { ActivityType } from 'discord.js';
import { presenceFor, updatePresence, SELF_FIX_STATUS } from '../src/presence.js';
import { SelfFixState } from '../src/selfFixState.js';

test('a self-fix shows Idle with a fixing-myself status; private mode is Do Not Disturb', () => {
  const fixing = presenceFor({ selfFixing: true, privateOn: true });
  assert.equal(fixing.status, 'idle');
  assert.equal(fixing.activities[0].type, ActivityType.Custom);
  assert.match(fixing.activities[0].state, /fixing myself/i);
  assert.deepEqual(presenceFor({ privateOn: true }), { status: 'dnd', activities: [] });
  assert.deepEqual(presenceFor(), { status: 'online', activities: [] });
});

test('updatePresence reads the self-fix run and private mode', () => {
  const set = [];
  const client = { user: { setPresence: (p) => set.push(p) } };
  const state = new SelfFixState();
  const privateMode = { isOn: () => true };
  updatePresence(client, privateMode, state);
  state.begin();
  updatePresence(client, privateMode, state);
  state.end();
  updatePresence(client, null, state);
  assert.deepEqual(set.map((p) => p.status), ['dnd', 'idle', 'online']);
  assert.equal(set[1].activities[0].state, SELF_FIX_STATUS);
  updatePresence(null, privateMode, state); // no client: nothing to do, no throw
});
