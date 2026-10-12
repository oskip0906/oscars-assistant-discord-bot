import test from 'node:test';
import assert from 'node:assert/strict';
import { saveModel, loadModel, switchModel } from '../src/discord/model.js';
import { providerFor } from '../src/agent/openrouter.js';

const dbConfig = { databaseUrl: 'postgres://x' };

// bot_settings in memory: the upsert writes 'model' then 'model_providers'.
const fakeSettings = (rows) => async (_config, sql, params) => {
  if (sql.startsWith('insert')) {
    rows.set('model', params[0]);
    rows.set('model_providers', params[1]);
  }
  return { rows: [...rows].map(([key, value]) => ({ key, value })) };
};

test('saveModel upserts the id into bot_settings, and loadModel reads it back at boot', async () => {
  const rows = new Map();
  const query = fakeSettings(rows);
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

test('a legacy database with only a model row loads with no providers', async () => {
  const config = { ...dbConfig, model: 'a/default' };
  await loadModel(config, { query: fakeSettings(new Map([['model', 'a/legacy']])) });
  assert.equal(config.model, 'a/legacy');
  assert.deepEqual(config.modelProviders, {});
  assert.equal(providerFor(config, config.model), '');
});

test('saved providers round-trip per model, and blank or junk ones mean the default', async () => {
  const rows = new Map();
  const query = fakeSettings(rows);
  const config = { ...dbConfig, model: 'a/one', modelProviders: { 'b/two': 'together' } };

  assert.deepEqual(await saveModel(config, 'a/one', { query, provider: '  deepinfra ' }), { ok: true });
  assert.deepEqual(JSON.parse(rows.get('model_providers')), { 'b/two': 'together', 'a/one': 'deepinfra' });
  assert.deepEqual(await saveModel({ ...config, modelProviders: { 'a/one': 'deepinfra' } }, 'a/one', { query, provider: '   ' }), { ok: true });
  assert.deepEqual(JSON.parse(rows.get('model_providers')), {}, 'a blank provider clears the entry');
  assert.equal((await saveModel(config, 'a/one', { query: async () => assert.fail('no write'), provider: 'bad\nslug' })).ok, false);

  rows.set('model_providers', JSON.stringify({ 'a/one': 'deepinfra', 'b/two': '  ', 'c/three': 'x y' }));
  await loadModel(config, { query });
  assert.deepEqual(config.modelProviders, { 'a/one': 'deepinfra' });

  rows.set('model_providers', 'not json');
  await loadModel(config, { query });
  assert.deepEqual(config.modelProviders, {}, 'unreadable map falls back to default routing');
});

test('switchModel pins a provider the model is served by, and refuses one it is not', async () => {
  const config = { model: 'a/old' };
  const listModels = async () => ['a/old', 'a/new'];
  const listProviders = async () => ['deepinfra/fp8', 'deepinfra', 'DeepInfra', 'google-vertex', 'Google Vertex'];
  const saves = [];
  const save = async (_config, model, opts) => (saves.push({ model, ...opts }), { ok: true });

  const refused = await switchModel({ model: 'a/new', provider: 'nowhere', config }, { listModels, listProviders, save });
  assert.equal(refused.ok, false);
  assert.match(refused.summary, /no `nowhere` provider/);
  assert.match(refused.summary, /`deepinfra`/);
  assert.equal(config.model, 'a/old');
  assert.equal(saves.length, 0);

  const pinned = await switchModel({ model: 'a/new', provider: ' GOOGLE-VERTEX ', config }, { listModels, listProviders, save });
  assert.equal(pinned.ok, true);
  assert.equal(config.model, 'a/new');
  assert.equal(providerFor(config, 'a/new'), 'GOOGLE-VERTEX');
  assert.equal(providerFor(config, 'a/old'), '', 'other models keep the default');

  const same = await switchModel({ model: 'a/new', provider: 'GOOGLE-VERTEX', config }, { listModels, listProviders, save });
  assert.match(same.summary, /Already running/);

  // Same model, provider cleared → back to the default, model id unchanged.
  const cleared = await switchModel({ model: 'a/new', provider: '  ', config }, { listModels, listProviders: async () => assert.fail('not checked'), save });
  assert.equal(cleared.ok, true);
  assert.equal(config.model, 'a/new');
  assert.equal(providerFor(config, 'a/new'), '');
  assert.deepEqual(saves.at(-1), { model: 'a/new', provider: '' });
});

test('switchModel still switches when the provider list is unreachable, and says so', async () => {
  const config = { model: 'a/old' };
  const result = await switchModel(
    { model: 'a/new', provider: 'deepinfra', config },
    { listModels: async () => ['a/new'], listProviders: async () => { throw new Error('HTTP 503'); }, save: async () => ({ ok: true }) },
  );
  assert.equal(result.ok, true);
  assert.match(result.summary, /Couldn’t verify the provider/);
  assert.equal(providerFor(config, 'a/new'), 'deepinfra');
});
