import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncToRemote, changedFiles } from '../src/agent/tools/source.js';

// Real git, no mocks: a bare "remote" plus a clone standing in for the bot's
// deployed checkout. These tests are the safety net for the step that runs
// immediately before the bot restarts into whatever is on disk.
function scaffoldRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panda-sync-'));
  const remote = path.join(dir, 'remote.git');
  const local = path.join(dir, 'local');
  const git = (args, cwd) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: 'pipe', // git chatters on stderr; keep the test output clean
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
    });

  git(['init', '--bare', '--initial-branch=main', remote], dir);
  git(['clone', remote, local], dir);
  git(['config', 'user.email', 'test@example.com'], local);
  git(['config', 'user.name', 'test'], local);
  fs.writeFileSync(path.join(local, 'app.js'), 'v1\n');
  git(['add', '-A'], local);
  git(['commit', '-m', 'v1'], local);
  git(['push', 'origin', 'main'], local);

  // A second clone plays "the merged PR": it pushes to main behind the bot's back.
  const other = path.join(dir, 'other');
  git(['clone', remote, other], dir);
  git(['config', 'user.email', 'test@example.com'], other);
  git(['config', 'user.name', 'test'], other);

  return { local, other, git };
}

test('the checkout ends up matching remote main after a merge lands', async () => {
  const { local, other, git } = scaffoldRepo();
  fs.writeFileSync(path.join(other, 'app.js'), 'v2-from-pr\n');
  git(['commit', '-am', 'v2'], other);
  git(['push', 'origin', 'main'], other);

  const summary = await syncToRemote({ root: local, base: 'main' });

  assert.match(summary, /^✅/);
  assert.equal(fs.readFileSync(path.join(local, 'app.js'), 'utf8'), 'v2-from-pr\n');
});

test('local edits are discarded — the merged remote version wins', async () => {
  const { local, other, git } = scaffoldRepo();
  // Exactly the self_fix situation: Claude's edits are still sitting in the
  // working tree, and the same change has already been merged remotely.
  fs.writeFileSync(path.join(local, 'app.js'), 'v2-local-draft\n');
  fs.writeFileSync(path.join(other, 'app.js'), 'v2-merged\n');
  git(['commit', '-am', 'v2'], other);
  git(['push', 'origin', 'main'], other);

  await syncToRemote({ root: local, base: 'main' });

  assert.equal(fs.readFileSync(path.join(local, 'app.js'), 'utf8'), 'v2-merged\n');
  // A plain `git pull` would have aborted here; nothing may be left dirty.
  assert.equal(git(['status', '--porcelain'], local).trim(), '');
});

test('an untracked new file is replaced by its merged version', async () => {
  const { local, other, git } = scaffoldRepo();
  fs.writeFileSync(path.join(local, 'new.js'), 'local draft\n');
  fs.writeFileSync(path.join(other, 'new.js'), 'merged version\n');
  git(['add', '-A'], other);
  git(['commit', '-m', 'add new.js'], other);
  git(['push', 'origin', 'main'], other);

  await syncToRemote({ root: local, base: 'main' });

  assert.equal(fs.readFileSync(path.join(local, 'new.js'), 'utf8'), 'merged version\n');
});

test('a checkout sitting on a stale branch is moved onto remote main', async () => {
  const { local, other, git } = scaffoldRepo();
  git(['checkout', '-b', 'stale'], local);
  fs.writeFileSync(path.join(other, 'app.js'), 'v2-merged\n');
  git(['commit', '-am', 'v2'], other);
  git(['push', 'origin', 'main'], other);

  await syncToRemote({ root: local, base: 'main' });

  assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD'], local).trim(), 'main');
  assert.equal(fs.readFileSync(path.join(local, 'app.js'), 'utf8'), 'v2-merged\n');
});

test('a directory that is not a repo is reported, not crashed on', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panda-notrepo-'));
  const summary = await syncToRemote({ root: dir, base: 'main' });
  assert.match(summary, /^❌/);
});

test('a checkout whose main is claimed by another worktree still ends up on the merged code', async () => {
  const { local, other, git } = scaffoldRepo();
  // `git worktree add` parks main elsewhere, so `checkout -B main` here is
  // refused outright. Matching remote main still has to win.
  const parked = path.join(local, '..', 'parked');
  git(['checkout', '-b', 'deploy'], local);
  git(['worktree', 'add', parked, 'main'], local);
  fs.writeFileSync(path.join(other, 'app.js'), 'v2-merged\n');
  git(['commit', '-am', 'v2'], other);
  git(['push', 'origin', 'main'], other);

  const summary = await syncToRemote({ root: local, base: 'main' });

  assert.match(summary, /^✅/);
  assert.equal(fs.readFileSync(path.join(local, 'app.js'), 'utf8'), 'v2-merged\n');
});

test('a new directory of files is listed file by file, never as the directory', async () => {
  const { local } = scaffoldRepo();
  fs.mkdirSync(path.join(local, 'src/deep'), { recursive: true });
  fs.writeFileSync(path.join(local, 'src/deep/a.js'), 'a\n');
  fs.writeFileSync(path.join(local, 'src/deep/b.js'), 'b\n');

  const changed = await changedFiles(local);

  // Plain `git status --porcelain` collapses this to "src/" — and a self_fix
  // that tried to upload a directory as a blob would die on EISDIR.
  assert.deepEqual(changed.sort(), ['src/deep/a.js', 'src/deep/b.js']);
});

test('ignored files are never treated as changes', async () => {
  const { local, git } = scaffoldRepo();
  fs.writeFileSync(path.join(local, '.gitignore'), 'secret.env\nnode_modules\n');
  git(['add', '-A'], local);
  git(['commit', '-m', 'ignore'], local);
  fs.writeFileSync(path.join(local, 'secret.env'), 'TOKEN=nope\n');
  fs.mkdirSync(path.join(local, 'node_modules'));
  fs.writeFileSync(path.join(local, 'node_modules/x.js'), 'x\n');

  assert.deepEqual(await changedFiles(local), []);
});
