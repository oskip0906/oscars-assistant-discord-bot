import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selfFix } from '../src/agent/tools/source.js';
import { selfFixState } from '../src/selfFixState.js';
import { startDevRunLog } from '../src/devRunLog.js';

function harness({ sandbox } = {}) {
  const dms = [];
  const requests = [];
  const lines = [];
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
    lines,
    deps: {
      startLog: (kind, fields) => startDevRunLog(kind, fields, { write: (line) => lines.push(line), now: () => 0 }),
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
  const { invocation, deps, dms, requests, lines } = harness();
  await selfFix({ instruction: 'make the panda friendlier' }, invocation, deps);

  assert.match(lines[0], /^\[panda\] self_fix start .*task="make the panda friendlier"/);
  assert.match(lines[1], /^\[panda\] self_fix finish outcome=merged/);

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
  const { invocation, deps, dms, lines } = harness({ sandbox: { ok: false, summary: '⚠️ The pull request is still open.' } });
  await selfFix({ instruction: 'break something' }, invocation, deps);
  assert.equal(invocation.requestRestart, false);
  assert.match(dms[0].content, /still open/);
  assert.match(lines[1], /^\[panda\] self_fix finish outcome=failed/);
});

test('a self-fix that crashes in the sandbox still logs a finish line', async () => {
  const { invocation, deps, lines } = harness();
  deps.runSandbox = async () => {
    throw new Error('OpenRouter request failed');
  };
  await selfFix({ instruction: 'break the sandbox' }, invocation, deps);
  assert.match(lines[1], /^\[panda\] self_fix finish outcome=crashed .*OpenRouter request failed/);
});

test('a declined approval does not start the sandbox', async () => {
  const { invocation, deps, requests, dms, lines } = harness();
  deps.confirm = async () => 'cancel';
  const result = await selfFix({ instruction: 'do not run' }, invocation, deps);
  assert.equal(requests.length, 0);
  assert.equal(dms.length, 0);
  assert.match(result, /aborted/i);
  // A request that was never approved is still a request worth seeing in the log.
  assert.match(lines[0], /^\[panda\] self_fix start/);
  assert.match(lines[1], /^\[panda\] self_fix finish outcome=aborted/);
});
