import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPr } from '../src/agent/tools/github.js';

function harness({ pr = { ok: true, number: 3, url: 'https://gh/pr/3', merged: false, detail: 'PR #3 opened.' }, defaultBranch = 'main' } = {}) {
  const opened = [];
  const invocation = { isOwner: true, config: { githubPat: 'pat', vaultRepo: 'oskip0906/oskip-vault' } };
  const deps = {
    openPr: async (args) => {
      opened.push(args);
      return pr;
    },
    // Only the repo lookup goes through the raw REST stub here.
    gh: async () => ({ status: 200, json: { default_branch: defaultBranch } }),
    now: () => 1700000000000,
  };
  return { invocation, deps, opened };
}

test('a PR can be opened against any of Oscar’s repos', async () => {
  const { invocation, deps, opened } = harness();

  const result = await createPr(
    { repo: 'oskip0906/oskip-vault', title: 'Add a note', files: [{ path: 'notes/a.md', content: '# hi' }] },
    invocation,
    deps,
  );

  assert.equal(opened.length, 1);
  assert.equal(opened[0].slug, 'oskip0906/oskip-vault');
  assert.deepEqual(opened[0].files, [{ path: 'notes/a.md', content: '# hi', mode: '100644' }]);
  assert.match(result, /PR #3/);
  assert.match(result, /https:\/\/gh\/pr\/3/);
});

test('a bare repo name resolves to Oscar’s account', async () => {
  const { invocation, deps, opened } = harness();

  await createPr({ repo: 'panda-bot', title: 't', files: [{ path: 'a.md', content: 'x' }] }, invocation, deps);

  assert.equal(opened[0].slug, 'oskip0906/panda-bot');
});

test('a repo whose default branch is not main is targeted correctly', async () => {
  const { invocation, deps, opened } = harness({ defaultBranch: 'master' });

  await createPr({ repo: 'o/old-repo', title: 't', files: [{ path: 'a.md', content: 'x' }] }, invocation, deps);

  assert.equal(opened[0].base, 'master');
});

test('an explicit base branch wins over the repo default', async () => {
  const { invocation, deps, opened } = harness();

  await createPr({ repo: 'o/r', title: 't', base: 'dev', files: [{ path: 'a.md', content: 'x' }] }, invocation, deps);

  assert.equal(opened[0].base, 'dev');
});

test('PRs on other repos are left open unless auto-merge is asked for', async () => {
  const { invocation, deps, opened } = harness();

  await createPr({ repo: 'o/r', title: 't', files: [{ path: 'a.md', content: 'x' }] }, invocation, deps);
  assert.equal(opened[0].autoMerge, false, 'merging someone’s repo by surprise is not the default');

  await createPr({ repo: 'o/r', title: 't', auto_merge: true, files: [{ path: 'a.md', content: 'x' }] }, invocation, deps);
  assert.equal(opened[1].autoMerge, true);
});

test('a deletion is expressed as a file with null content', async () => {
  const { invocation, deps, opened } = harness();

  await createPr({ repo: 'o/r', title: 't', files: [{ path: 'dead.md', content: null }] }, invocation, deps);

  assert.deepEqual(opened[0].files, [{ path: 'dead.md', content: null, mode: '100644' }]);
});

test('a non-owner never reaches GitHub', async () => {
  const { invocation, deps, opened } = harness();
  invocation.isOwner = false;

  const result = await createPr({ repo: 'o/r', title: 't', files: [{ path: 'a.md', content: 'x' }] }, invocation, deps);

  assert.equal(opened.length, 0);
  assert.match(result, /⛔/);
});

test('a call with no files is refused with an explanation', async () => {
  const { invocation, deps, opened } = harness();

  const result = await createPr({ repo: 'o/r', title: 't', files: [] }, invocation, deps);

  assert.equal(opened.length, 0);
  assert.match(result, /files/i);
});

test('a failed PR is reported as a failure', async () => {
  const { invocation, deps } = harness({ pr: { ok: false, number: null, merged: false, detail: 'Validation failed' } });

  const result = await createPr({ repo: 'o/r', title: 't', files: [{ path: 'a.md', content: 'x' }] }, invocation, deps);

  assert.match(result, /❌/);
  assert.match(result, /Validation failed/);
});
