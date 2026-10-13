import test from 'node:test';
import assert from 'node:assert/strict';
import { PrivateMode } from '../src/privateMode.js';

const config = { databaseUrl: 'postgres://fake' };

// A fake db-1 holding the one pms row.
function fakeDb() {
  const store = { row: null, fail: false, calls: [] };
  store.query = async (_config, text, params) => {
    store.calls.push(text);
    if (store.fail) throw new Error('db down');
    if (/^select/i.test(text)) return { rows: store.row ? [store.row] : [] };
    store.row = { enabled: params[0] };
    return { rows: [] };
  };
  return store;
}

test('private mode loads from the pms table and starts OFF without a row', async () => {
  const store = fakeDb();
  const mode = new PrivateMode(config, { query: store.query });
  assert.equal(await mode.load(), false);
  assert.match(store.calls[0], /from pms/);
  store.row = { enabled: true };
  const restarted = new PrivateMode(config, { query: store.query });
  assert.equal(await restarted.load(), true);
  assert.equal(restarted.isOn(), true);
});

test('a toggle is saved to pms and applies at once; it survives a restart', async () => {
  const store = fakeDb();
  const mode = new PrivateMode(config, { query: store.query });
  await mode.load();
  assert.deepEqual(await mode.set(true), { ok: true, on: true });
  assert.equal(mode.isOn(), true);
  assert.match(store.calls.at(-1), /insert into pms/);
  assert.equal(store.row.enabled, true);

  const restarted = new PrivateMode(config, { query: store.query });
  assert.equal(await restarted.load(), true);
  await restarted.set(false);
  assert.equal(restarted.isOn(), false);
  assert.equal(store.row.enabled, false);
});

test('a failed save leaves the runtime state matching the database', async () => {
  const store = fakeDb();
  const mode = new PrivateMode(config, { query: store.query });
  store.fail = true;
  const result = await mode.set(true);
  assert.equal(result.ok, false);
  assert.equal(result.on, false);
  assert.match(result.error, /db down/);
  assert.equal(mode.isOn(), false);
  assert.equal(await mode.load(), false, 'a database down at boot means OFF, not a crash');
});

test('without a database nothing is queried and a toggle is refused', async () => {
  let queried = false;
  const mode = new PrivateMode({}, { query: async () => { queried = true; } });
  assert.equal(await mode.load(), false);
  const result = await mode.set(true);
  assert.equal(result.ok, false);
  assert.match(result.error, /DATABASE_URL/);
  assert.equal(mode.isOn(), false);
  assert.equal(queried, false);
});

test('toggles are applied in order', async () => {
  const store = fakeDb();
  const slow = async (...args) => { await new Promise((r) => setTimeout(r, 10)); return store.query(...args); };
  const mode = new PrivateMode(config, { query: slow });
  await Promise.all([mode.set(true), mode.set(false)]);
  assert.equal(mode.isOn(), false);
  assert.equal(store.row.enabled, false);
});
