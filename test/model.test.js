import test from 'node:test';
import assert from 'node:assert/strict';
import { saveModel, switchModel } from '../src/discord/model.js';
import { getDefaultModelName } from '../src/configManager.js';

const repoConfig = { githubPat: 'pat', developmentSandboxRepo: 'owner/repo' };
const SHA = 'a'.repeat(40);

// What GitHub's MCP get_file_contents answers for a text file.
const mcpFile = (obj) => async (name, args) => {
  assert.equal(name, 'get_file_contents');
  assert.deepEqual(args, { owner: 'owner', repo: 'repo', path: 'src/models.json', ref: 'refs/heads/main' });
  const text = `successfully downloaded text file (SHA: ${SHA})`;
  return { text, result: { content: [{ type: 'text', text }, { type: 'resource', resource: { text: JSON.stringify(obj) } }] } };
};

test('saveModel reads src/models.json over MCP and commits only the one key changed', async () => {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url, opts });
    return { ok: true };
  };
  const read = mcpFile({ conversation: 'a/old', development: 'b/dev' });
  assert.deepEqual(await saveModel(repoConfig, 'conversation', 'a/new', { fetchImpl, read }), { ok: true });

  assert.equal(calls.length, 1, 'the only REST call is the commit');
  const put = calls[0];
  assert.equal(put.opts.method, 'PUT');
  assert.equal(put.url, 'https://api.github.com/repos/owner/repo/contents/src/models.json');
  const body = JSON.parse(put.opts.body);
  assert.equal(body.sha, SHA);
  assert.equal(body.branch, 'main');
  assert.deepEqual(JSON.parse(Buffer.from(body.content, 'base64').toString()), { conversation: 'a/new', development: 'b/dev' });
});

test('saveModel refuses unsafe ids and reports GitHub failures without throwing', async () => {
  assert.equal((await saveModel(repoConfig, 'conversation', 'a\nOWNER=1')).ok, false);
  const failing = async () => ({ ok: false, status: 403 });
  const result = await saveModel(repoConfig, 'conversation', 'a/new', { fetchImpl: failing, read: mcpFile({ conversation: 'a/old' }) });
  assert.equal(result.ok, false);
  assert.match(result.error, /403/);

  const unreadable = await saveModel(repoConfig, 'conversation', 'a/new', {
    read: async () => {
      throw new Error('GitHub MCP get_file_contents: not found');
    },
  });
  assert.equal(unreadable.ok, false);
  assert.match(unreadable.error, /not found/);
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
