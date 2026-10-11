import test from 'node:test';
import assert from 'node:assert/strict';
import { saveModel, loadModel, switchModel } from '../src/discord/model.js';

const dbConfig = { databaseUrl: 'postgres://x' };

test('saveModel upserts the id into bot_settings, and loadModel reads it back at boot', async () => {
  const rows = new Map();
  const query = async (_config, sql, params) => {
    if (sql.startsWith('insert')) rows.set('model', params[0]);
    return { rows: rows.has('model') ? [{ value: rows.get('model') }] : [] };
  };
  const config = { ...dbConfig, model: 'a/default' };
  await loadModel(config, { query });
  assert.equal(config.model, 'a/default', 'no saved row keeps the default');

  assert.deepEqual(await saveModel(dbConfig, 'a/new', { query }), { ok: true });
  await loadModel(config, { query });
  assert.equal(config.model, 'a/new');
});

test('saveModel refuses unsafe ids, a missing database and failed writes without throwing', async () => {
  const never = async () => assert.fail('nothing may be written');
  assert.equal((await saveModel(dbConfig, 'a\nOWNER=1', { query: never })).ok, false);
  assert.equal((await saveModel({}, 'a/new', { query: never })).ok, false);
  const failed = await saveModel(dbConfig, 'a/new', {
    query: async () => {
      throw new Error('connection refused');
    },
  });
  assert.equal(failed.ok, false);
  assert.match(failed.error, /connection refused/);
});

test('switchModel goes live only after the choice is saved', async () => {
  const config = { model: 'a/old' };
  const listModels = async () => ['a/old', 'a/new'];

  const refused = await switchModel({ model: 'a/new', config }, { listModels, save: async () => ({ ok: false, error: 'nope' }) });
  assert.equal(refused.ok, false);
  assert.equal(config.model, 'a/old');

  const switched = await switchModel({ model: 'a/new', config }, { listModels, save: async () => ({ ok: true }) });
  assert.equal(switched.ok, true);
  assert.equal(config.model, 'a/new');
});
