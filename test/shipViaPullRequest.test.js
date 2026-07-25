import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { shipViaPullRequest } from '../src/agent/tools/source.js';

// A real repo with a real origin URL, so the remote-parsing and the
// "did anything get committed locally?" assertions are honest.
function scaffoldCheckout({ origin = 'https://github.com/oskip0906/panda.git' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'panda-ship-'));
  const git = (args) =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: 'pipe',
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
    });
  git(['init', '--initial-branch=main']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'test']);
  fs.writeFileSync(path.join(root, 'app.js'), 'v1\n');
  git(['add', '-A']);
  git(['commit', '-m', 'v1']);
  if (origin) git(['remote', 'add', 'origin', origin]);
  return { root, git };
}

// Claude's edit, still sitting in the working tree.
function dirty(root) {
  fs.writeFileSync(path.join(root, 'app.js'), 'v2\n');
  fs.writeFileSync(path.join(root, 'added.js'), 'new\n');
}

const okPr = { ok: true, number: 12, url: 'https://gh/pr/12', merged: true, detail: 'PR #12 merged into main.' };

function spies({ pr = okPr, syncSummary = '✅ Pulled origin/main' } = {}) {
  const seen = { openPr: [], sync: [] };
  return {
    seen,
    openPr: async (args) => {
      seen.openPr.push(args);
      return pr;
    },
    sync: async (args) => {
      seen.sync.push(args);
      return syncSummary;
    },
  };
}

test('the working tree is shipped as a PR and nothing is committed locally', async () => {
  const { root, git } = scaffoldCheckout();
  dirty(root);
  const { openPr, sync, seen } = spies();

  const result = await shipViaPullRequest({
    root,
    title: 'self_fix: do a thing',
    changed: ['app.js', 'added.js'],
    openPr,
    sync,
    now: () => 1700000000000,
  });

  assert.equal(result.ok, true);
  assert.equal(seen.openPr.length, 1);
  assert.equal(seen.openPr[0].slug, 'oskip0906/panda');
  assert.deepEqual(
    seen.openPr[0].files.map((f) => f.path).sort(),
    ['added.js', 'app.js'],
  );
  assert.equal(seen.openPr[0].files.find((f) => f.path === 'app.js').content, 'v2\n');

  // The whole point: the deployment's own history is untouched by a self-fix.
  assert.equal(git(['rev-list', '--count', 'HEAD']).trim(), '1');
});

test('the merged code is pulled back down only after the merge succeeds', async () => {
  const { root } = scaffoldCheckout();
  dirty(root);
  const { openPr, sync, seen } = spies();

  const result = await shipViaPullRequest({ root, title: 't', changed: ['app.js'], openPr, sync, now: () => 1 });

  assert.equal(seen.sync.length, 1);
  assert.equal(seen.sync[0].base, 'main');
  assert.match(result.summary, /Pulled origin\/main/);
});

test('a merge that fails leaves the checkout alone and blocks the restart', async () => {
  const { root } = scaffoldCheckout();
  dirty(root);
  const { openPr, sync, seen } = spies({
    pr: { ok: false, number: 12, url: 'https://gh/pr/12', merged: false, detail: 'Merge conflict' },
  });

  const result = await shipViaPullRequest({ root, title: 't', changed: ['app.js'], openPr, sync, now: () => 1 });

  assert.equal(result.ok, false);
  assert.equal(seen.sync.length, 0, 'syncing to a main that lacks the fix would revert it');
  assert.match(result.summary, /Merge conflict/);
});

test('each self-fix gets its own branch name', async () => {
  const { root } = scaffoldCheckout();
  dirty(root);
  const { openPr, sync, seen } = spies();

  await shipViaPullRequest({ root, title: 't', changed: ['app.js'], openPr, sync, now: () => 1700000000000 });
  await shipViaPullRequest({ root, title: 't', changed: ['app.js'], openPr, sync, now: () => 1700000009999 });

  assert.notEqual(seen.openPr[0].branchName, seen.openPr[1].branchName);
  assert.match(seen.openPr[0].branchName, /^self-fix-/);
});

test('a checkout with no GitHub origin is reported instead of half-shipped', async () => {
  const { root } = scaffoldCheckout({ origin: null });
  dirty(root);
  const { openPr, sync, seen } = spies();

  const result = await shipViaPullRequest({ root, title: 't', changed: ['app.js'], openPr, sync, now: () => 1 });

  assert.equal(result.ok, false);
  assert.equal(seen.openPr.length, 0);
  assert.match(result.summary, /origin/i);
});
