import test from 'node:test';
import assert from 'node:assert/strict';
import { saveModel, switchModel } from '../src/discord/model.js';
import { getDefaultModelName } from '../src/configManager.js';

const repoConfig = { githubPat: 'pat', developmentSandboxRepo: 'owner/repo' };
const encode = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64');

test('saveModel commits src/models.json with only the one key changed', async () => {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url, opts });
    if (!opts.method) return { ok: true, json: async () => ({ sha: 'abc', content: encode({ conversation: 'a/old', development: 'b/dev' }) }) };
    return { ok: true };
  };
  assert.deepEqual(await saveModel(repoConfig, 'conversation', 'a/new', { fetchImpl }), { ok: true });

  const put = calls[1];
  assert.equal(put.url, 'https://api.github.com/repos/owner/repo/contents/src/models.json');
  const body = JSON.parse(put.opts.body);
  assert.equal(body.sha, 'abc');
  assert.equal(body.branch, 'main');
  assert.deepEqual(JSON.parse(Buffer.from(body.content, 'base64').toString()), { conversation: 'a/new', development: 'b/dev' });
});

test('saveModel refuses unsafe ids and reports GitHub failures without throwing', async () => {
  assert.equal((await saveModel(repoConfig, 'conversation', 'a\nOWNER=1')).ok, false);
  const failing = async () => ({ ok: false, status: 403 });
  const result = await saveModel(repoConfig, 'conversation', 'a/new', { fetchImpl: failing });
  assert.equal(result.ok, false);
  assert.match(result.error, /403/);
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
  assert.equal(getDefaultModelName(), 'a/new');
});
