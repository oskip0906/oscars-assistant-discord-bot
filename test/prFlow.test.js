import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { repoSlug, snapshotFiles, openAutoMergedPr } from '../src/agent/tools/prFlow.js';

// A fake GitHub REST surface. Records every call, and replies from a table
// keyed by "METHOD /path" — anything not in the table gets a sane default so a
// test only has to describe the responses it actually cares about.
function fakeGh(overrides = {}) {
  const calls = [];
  const defaults = {
    'GET /repos/o/r/git/ref/heads/main': { status: 200, json: { object: { sha: 'base-sha' } } },
    'GET /repos/o/r/git/commits/base-sha': { status: 200, json: { tree: { sha: 'base-tree' } } },
    'POST /repos/o/r/git/blobs': { status: 201, json: { sha: 'blob-sha' } },
    'POST /repos/o/r/git/trees': { status: 201, json: { sha: 'tree-sha' } },
    'POST /repos/o/r/git/commits': { status: 201, json: { sha: 'commit-sha' } },
    'POST /repos/o/r/git/refs': { status: 201, json: {} },
    'POST /repos/o/r/pulls': { status: 201, json: { number: 7, html_url: 'https://gh/pr/7' } },
    'PUT /repos/o/r/pulls/7/merge': { status: 200, json: { merged: true, sha: 'merge-sha' } },
    'DELETE /repos/o/r/git/refs/heads/self-fix-1': { status: 204, json: {} },
  };
  const table = { ...defaults, ...overrides };
  const gh = async (method, endpoint, body) => {
    calls.push({ method, endpoint, body });
    const key = `${method} ${endpoint}`;
    const reply = table[key];
    if (!reply) throw new Error(`unexpected call: ${key}`);
    return Array.isArray(reply) ? reply[Math.min(calls.filter((c) => `${c.method} ${c.endpoint}` === key).length - 1, reply.length - 1)] : reply;
  };
  return { gh, calls, seen: (method, endpoint) => calls.filter((c) => c.method === method && c.endpoint === endpoint) };
}

const BASE_ARGS = {
  slug: 'o/r',
  base: 'main',
  branchName: 'self-fix-1',
  title: 'self_fix: something',
  body: 'why',
  sleep: async () => {},
};

test('a change ships as a branch, a PR against main, and an immediate merge', async () => {
  const { gh, calls, seen } = fakeGh();

  const result = await openAutoMergedPr({
    ...BASE_ARGS,
    gh,
    files: [{ path: 'src/a.js', content: 'export const a = 1;\n', mode: '100644' }],
  });

  assert.equal(result.ok, true);
  assert.equal(result.number, 7);
  assert.equal(result.merged, true);

  // The commit must be parented on the CURRENT remote main, not on anything local.
  const commit = seen('POST', '/repos/o/r/git/commits')[0];
  assert.deepEqual(commit.body.parents, ['base-sha']);
  assert.equal(commit.body.tree, 'tree-sha');

  const tree = seen('POST', '/repos/o/r/git/trees')[0];
  assert.equal(tree.body.base_tree, 'base-tree');
  assert.deepEqual(tree.body.tree, [{ path: 'src/a.js', mode: '100644', type: 'blob', sha: 'blob-sha' }]);

  const pr = seen('POST', '/repos/o/r/pulls')[0];
  assert.equal(pr.body.head, 'self-fix-1');
  assert.equal(pr.body.base, 'main');

  // No local git anywhere in the flow — every step is a REST call.
  assert.ok(calls.every((c) => c.endpoint.startsWith('/repos/o/r/')));
});

test('a file blob is uploaded base64-encoded so binary and unicode survive', async () => {
  const { gh, seen } = fakeGh();

  await openAutoMergedPr({
    ...BASE_ARGS,
    gh,
    files: [{ path: 'a.txt', content: 'héllo 🐼', mode: '100644' }],
  });

  const blob = seen('POST', '/repos/o/r/git/blobs')[0];
  assert.equal(blob.body.encoding, 'base64');
  assert.equal(Buffer.from(blob.body.content, 'base64').toString('utf8'), 'héllo 🐼');
});

test('an executable file keeps its exec bit in the tree', async () => {
  const { gh, seen } = fakeGh();

  await openAutoMergedPr({
    ...BASE_ARGS,
    gh,
    files: [{ path: 'start.sh', content: '#!/bin/bash\n', mode: '100755' }],
  });

  assert.equal(seen('POST', '/repos/o/r/git/trees')[0].body.tree[0].mode, '100755');
});

test('a deleted file ships as a null-sha tree entry, not a blob', async () => {
  const { gh, seen } = fakeGh();

  await openAutoMergedPr({
    ...BASE_ARGS,
    gh,
    files: [{ path: 'gone.js', content: null, mode: '100644' }],
  });

  assert.equal(seen('POST', '/repos/o/r/git/blobs').length, 0);
  assert.deepEqual(seen('POST', '/repos/o/r/git/trees')[0].body.tree, [
    { path: 'gone.js', mode: '100644', type: 'blob', sha: null },
  ]);
});

test('the throwaway branch is deleted once the PR is merged', async () => {
  const { gh, seen } = fakeGh();

  await openAutoMergedPr({ ...BASE_ARGS, gh, files: [{ path: 'a.js', content: 'x', mode: '100644' }] });

  assert.equal(seen('DELETE', '/repos/o/r/git/refs/heads/self-fix-1').length, 1);
});

test('a PR GitHub has not finished checking is retried, then merges', async () => {
  const { gh, seen } = fakeGh({
    'PUT /repos/o/r/pulls/7/merge': [
      { status: 405, json: { message: 'Base branch was modified' } },
      { status: 200, json: { merged: true, sha: 'merge-sha' } },
    ],
  });

  const result = await openAutoMergedPr({ ...BASE_ARGS, gh, files: [{ path: 'a.js', content: 'x', mode: '100644' }] });

  assert.equal(result.ok, true);
  assert.equal(seen('PUT', '/repos/o/r/pulls/7/merge').length, 2);
});

test('a merge GitHub keeps refusing is reported as a failure, not a success', async () => {
  const { gh } = fakeGh({
    'PUT /repos/o/r/pulls/7/merge': { status: 409, json: { message: 'Merge conflict' } },
  });

  const result = await openAutoMergedPr({ ...BASE_ARGS, gh, files: [{ path: 'a.js', content: 'x', mode: '100644' }] });

  assert.equal(result.ok, false);
  assert.equal(result.number, 7); // the PR still exists for Oscar to look at
  assert.match(result.detail, /Merge conflict/);
});

test('a branch that cannot be created stops the flow before a PR is opened', async () => {
  const { gh, seen } = fakeGh({
    'POST /repos/o/r/git/refs': { status: 422, json: { message: 'Reference already exists' } },
  });

  const result = await openAutoMergedPr({ ...BASE_ARGS, gh, files: [{ path: 'a.js', content: 'x', mode: '100644' }] });

  assert.equal(result.ok, false);
  assert.equal(seen('POST', '/repos/o/r/pulls').length, 0);
});

test('nothing is pushed when there are no changed files', async () => {
  const { gh, calls } = fakeGh();

  const result = await openAutoMergedPr({ ...BASE_ARGS, gh, files: [] });

  assert.equal(result.ok, false);
  assert.equal(calls.length, 0);
  assert.match(result.detail, /no changed files/i);
});

test('repoSlug reads owner/name out of every remote URL form', () => {
  assert.equal(repoSlug('https://github.com/oskip0906/oscars-assistant-discord-bot.git'), 'oskip0906/oscars-assistant-discord-bot');
  assert.equal(repoSlug('https://github.com/oskip0906/oscars-assistant-discord-bot'), 'oskip0906/oscars-assistant-discord-bot');
  assert.equal(repoSlug('git@github.com:oskip0906/panda.git'), 'oskip0906/panda');
  assert.equal(repoSlug('ssh://git@github.com/oskip0906/panda.git'), 'oskip0906/panda');
  assert.equal(repoSlug('not a url'), null);
});

test('snapshotFiles reads the working tree, marking deletions with null content', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'panda-snap-'));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src/a.js'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(root, 'start.sh'), '#!/bin/bash\n');
  fs.chmodSync(path.join(root, 'start.sh'), 0o755);

  const files = snapshotFiles(root, ['src/a.js', 'start.sh', 'src/gone.js']);

  assert.deepEqual(files, [
    { path: 'src/a.js', content: 'export const a = 1;\n', mode: '100644' },
    { path: 'start.sh', content: '#!/bin/bash\n', mode: '100755' },
    { path: 'src/gone.js', content: null, mode: '100644' },
  ]);
});

test('a PR can be left open for review instead of merged', async () => {
  const { gh, seen } = fakeGh();

  const result = await openAutoMergedPr({
    ...BASE_ARGS,
    gh,
    autoMerge: false,
    files: [{ path: 'a.js', content: 'x', mode: '100644' }],
  });

  assert.equal(result.ok, true);
  assert.equal(result.merged, false);
  assert.equal(seen('PUT', '/repos/o/r/pulls/7/merge').length, 0);
  // The branch has to survive — deleting it would close the open PR.
  assert.equal(seen('DELETE', '/repos/o/r/git/refs/heads/self-fix-1').length, 0);
});

test('a directory is skipped rather than crashing the snapshot', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'panda-snap-dir-'));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src/a.js'), 'export const a = 1;\n');
  fs.symlinkSync(path.join(root, 'src'), path.join(root, 'link'));

  // git can report a bare directory (and a symlink to one) as changed; reading
  // either as a file throws EISDIR and would take a whole self_fix down.
  const files = snapshotFiles(root, ['src', 'link', 'src/a.js']);

  assert.deepEqual(files.map((f) => f.path), ['src/a.js']);
});
