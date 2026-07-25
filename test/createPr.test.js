import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPr } from '../src/agent/tools/github.js';

function invocation() {
  return {
    isOwner: true,
    client: {},
    config: {
      ownerId: 'OWNER',
      vaultRepo: 'oskip0906/oskip-vault',
      githubPat: 'token',
      developmentSandboxRepo: 'oskip0906/oscars-assistant-discord-bot',
    },
    message: { channel: { send: async () => {} } },
  };
}

test('create_pr sends an approved development task to the remote sandbox', async () => {
  const calls = [];
  const result = await createPr(
    { repo: 'other-project', instruction: 'Add a health endpoint', base: 'trunk' },
    invocation(),
    {
      confirm: async () => 'confirm',
      getConfig: () => ({ model: 'openai/gpt-5.4-dev' }),
      state: { begin() {}, end() {} },
      runSandbox: async (args) => {
        calls.push(args);
        return { ok: true, summary: '✅ PR #7 opened.\nhttps://example.test/pr/7' };
      },
    },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].repo, 'oskip0906/other-project');
  assert.equal(calls[0].base, 'trunk');
  assert.equal(calls[0].model, 'openai/gpt-5.4-dev');
  assert.equal(calls[0].autoMerge, false);
  assert.match(result, /PR #7/);
});

test('create_pr leaves Panda’s own repository PR for manual approval too', async () => {
  const calls = [];
  await createPr(
    { repo: 'oskip0906/oscars-assistant-discord-bot', instruction: 'Improve docs' },
    invocation(),
    {
      confirm: async () => 'confirm',
      getConfig: () => ({ model: 'openai/gpt-5.4-dev' }),
      state: { begin() {}, end() {} },
      runSandbox: async (args) => {
        calls.push(args);
        return { ok: true, summary: 'ok' };
      },
    },
  );
  assert.equal(calls[0].autoMerge, false);
});

test('create_pr requires an explicit instruction instead of local file contents', async () => {
  const result = await createPr({ repo: 'other-project' }, invocation());
  assert.match(result, /instruction/i);
});

test('a non-owner never starts a development sandbox', async () => {
  const blocked = invocation();
  blocked.isOwner = false;
  const result = await createPr({ repo: 'x/y', instruction: 'change it' }, blocked);
  assert.match(result, /restricted/i);
});

test('a completed development PR sends Oscar a short DM with its link', async () => {
  const notifications = [];
  await createPr(
    { repo: 'other-project', instruction: 'Add a health endpoint' },
    invocation(),
    {
      confirm: async () => 'confirm',
      getConfig: () => ({ model: 'openai/gpt-5.4-dev' }),
      state: { begin() {}, end() {} },
      notify: async (_client, _owner, message) => notifications.push(message),
      runSandbox: async (args) => {
        await args.onPullRequest({ number: 8, html_url: 'https://example.test/pr/8' });
        return { ok: false, summary: '⚠️ The pull request is still open and awaiting merge.' };
      },
    },
  );
  assert.deepEqual(notifications, ['🛠️ Development PR #8: https://example.test/pr/8']);
});
