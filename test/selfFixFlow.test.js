import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selfFix } from '../src/agent/tools/source.js';
import { selfFixState } from '../src/selfFixState.js';

function harness({ sandbox } = {}) {
  const dms = [];
  const requests = [];
  const invocation = {
    client: { user: { id: 'BOT' } },
    isOwner: true,
    message: { channel: { send: async () => {} } },
    requestRestart: false,
  };
  return {
    invocation,
    dms,
    requests,
    deps: {
      confirm: async () => 'confirm',
      getConfig: () => ({ model: 'openai/gpt-5.4-dev' }),
      runSandbox: async (args) => {
        requests.push(args);
        return sandbox ?? { ok: true, summary: '✅ Remote sandbox opened and merged PR #12.\nhttps://gh/pr/12' };
      },
      notify: async (_client, ownerId, content) => dms.push({ ownerId, content }),
    },
  };
}

test('an approved self-fix uses the remote sandbox and restarts only after merge', async () => {
  const { invocation, deps, dms, requests } = harness();
  await selfFix({ instruction: 'make the panda friendlier' }, invocation, deps);

  assert.equal(requests.length, 1);
  assert.equal(requests[0].selfFix, true);
  assert.equal(requests[0].autoMerge, true);
  assert.equal(requests[0].model, 'openai/gpt-5.4-dev');
  assert.equal(invocation.requestRestart, true);
  assert.equal(dms.length, 1);
  assert.match(dms[0].content, /PR #12/);
  assert.equal(selfFixState.isActive(), false);
});

test('a remote sandbox failure notifies Oscar and never restarts', async () => {
  const { invocation, deps, dms } = harness({ sandbox: { ok: false, summary: '⚠️ The pull request is still open.' } });
  await selfFix({ instruction: 'break something' }, invocation, deps);
  assert.equal(invocation.requestRestart, false);
  assert.match(dms[0].content, /still open/);
});

test('a declined approval does not start the sandbox', async () => {
  const { invocation, deps, requests, dms } = harness();
  deps.confirm = async () => 'cancel';
  const result = await selfFix({ instruction: 'do not run' }, invocation, deps);
  assert.equal(requests.length, 0);
  assert.equal(dms.length, 0);
  assert.match(result, /aborted/i);
});
