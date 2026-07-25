import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selfFix } from '../src/agent/tools/source.js';
import { selfFixState } from '../src/selfFixState.js';

// The orchestration only — Claude, the GitHub round-trip and the DM are all
// injected, so these tests are about the decisions selfFix makes between them.
function harness({ fix, ship, verify } = {}) {
  const dms = [];
  const shipped = [];
  const invocation = {
    client: { user: { id: 'BOT' } },
    isOwner: true,
    message: { channel: { send: async () => {} } },
    requestRestart: false,
  };
  const deps = {
    // These tests exercise the orchestration AFTER Oscar confirms; auto-confirm
    // so they don't block on the 30s development-task confirmation prompt.
    confirm: async () => 'confirm',
    runFix: async () => fix ?? { completed: true, text: 'Claude did the thing.', rounds: 1 },
    verify: async () => verify ?? { changed: ['src/a.js'], problems: [] },
    ship: async (args) => {
      shipped.push(args);
      return ship ?? { ok: true, summary: '✅ PR #12 merged into main.\nhttps://gh/pr/12' };
    },
    notify: async (client, ownerId, content) => {
      dms.push({ client, ownerId, content });
      return true;
    },
  };
  return { invocation, deps, dms, shipped };
}

test('a successful self-fix DMs Oscar and asks for the restart', async () => {
  const { invocation, deps, dms } = harness();

  await selfFix({ instruction: 'make the panda friendlier' }, invocation, deps);

  assert.equal(invocation.requestRestart, true);
  assert.equal(dms.length, 1, 'exactly one DM, sent directly — no model in the loop');
  assert.equal(dms[0].ownerId, '767525911695851550');
  assert.match(dms[0].content, /PR #12/);
  assert.match(dms[0].content, /make the panda friendlier/);
  assert.equal(selfFixState.isActive(), false, 'the lock must always be released');
});

test('a self-fix whose PR never merges DMs the failure and blocks the restart', async () => {
  const { invocation, deps, dms } = harness({ ship: { ok: false, summary: '❌ Merge conflict' } });

  await selfFix({ instruction: 'break something' }, invocation, deps);

  assert.equal(invocation.requestRestart, false);
  assert.equal(dms.length, 1);
  assert.match(dms[0].content, /Merge conflict/);
});

test('edits that fail verification are never shipped, and Oscar is told', async () => {
  const { invocation, deps, dms, shipped } = harness({
    verify: { changed: ['src/a.js'], problems: ['src/a.js: syntax error'] },
  });

  const result = await selfFix({ instruction: 'oops' }, invocation, deps);

  assert.equal(shipped.length, 0);
  assert.equal(invocation.requestRestart, false);
  assert.match(result, /verification/i);
  assert.match(dms[0].content, /syntax error/);
});

test('a Claude session that never finished is not shipped', async () => {
  const { invocation, deps, dms, shipped } = harness({
    fix: { completed: false, text: 'I have a question…', rounds: 5 },
  });

  await selfFix({ instruction: 'ambiguous thing' }, invocation, deps);

  assert.equal(shipped.length, 0);
  assert.equal(invocation.requestRestart, false);
  assert.equal(dms.length, 1);
});

test('the DM goes out even when the reply is never delivered', async () => {
  const { invocation, deps, dms } = harness();
  // A slash command whose interaction expired: the channel send throws.
  invocation.message.channel.send = async () => {
    throw new Error('Unknown interaction');
  };

  await selfFix({ instruction: 'still notify me' }, invocation, deps);

  assert.equal(dms.length, 1);
});
