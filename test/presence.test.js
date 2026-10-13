import test from 'node:test';
import assert from 'node:assert/strict';
import { ActivityType } from 'discord.js';
import { presenceFor, updatePresence, SELF_FIX_STATUS, PRIVATE_ON_STATUS, PRIVATE_OFF_STATUS } from '../src/presence.js';
import { SelfFixState } from '../src/selfFixState.js';

test('a self-fix shows Idle with a fixing-myself status; otherwise the status says private mode ON or OFF', () => {
  const fixing = presenceFor({ selfFixing: true, privateOn: true });
  assert.equal(fixing.status, 'idle');
  assert.equal(fixing.activities[0].type, ActivityType.Custom);
  assert.match(fixing.activities[0].state, /fixing myself/i);
  const on = presenceFor({ privateOn: true });
  assert.equal(on.status, 'dnd');
  assert.equal(on.activities[0].type, ActivityType.Custom);
  assert.equal(on.activities[0].state, PRIVATE_ON_STATUS);
  assert.match(PRIVATE_ON_STATUS, /private mode: ON/i);
  const off = presenceFor();
  assert.equal(off.status, 'online');
  assert.equal(off.activities[0].type, ActivityType.Custom);
  assert.equal(off.activities[0].state, PRIVATE_OFF_STATUS);
  assert.match(PRIVATE_OFF_STATUS, /private mode: OFF/i);
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
  assert.equal(set[2].activities[0].state, PRIVATE_OFF_STATUS);
  updatePresence(null, privateMode, state); // no client: nothing to do, no throw
  const broken = { user: { setPresence: () => { throw new Error('gateway down'); } } };
  updatePresence(broken, privateMode, state); // a failed update is logged, not thrown
});
