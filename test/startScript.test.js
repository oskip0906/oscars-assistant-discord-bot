import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const git = (args, cwd) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: 'pipe',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  });

// A throwaway deployment: bare remote + the "bot's" clone + a second clone that
// stands in for a merged pull request arriving on main.
function scaffoldDeployment(indexSource) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panda-start-'));
  const remote = path.join(dir, 'remote.git');
  const local = path.join(dir, 'local');
  const other = path.join(dir, 'other');

  git(['init', '--bare', '--initial-branch=main', remote], dir);
  git(['clone', remote, local], dir);
  git(['config', 'user.email', 't@e.com'], local);
  git(['config', 'user.name', 't'], local);
  fs.mkdirSync(path.join(local, 'src'));
  fs.writeFileSync(path.join(local, 'src/index.js'), indexSource);
  fs.copyFileSync(path.join(REPO, 'run.sh'), path.join(local, 'run.sh'));
  fs.chmodSync(path.join(local, 'run.sh'), 0o755);
  fs.writeFileSync(path.join(local, '.gitignore'), 'start.sh\n');
  git(['add', '-A'], local);
  git(['commit', '-m', 'v1'], local);
  git(['push', 'origin', 'main'], local);
  git(['clone', remote, other], dir);
  git(['config', 'user.email', 't@e.com'], other);
  git(['config', 'user.name', 't'], other);

  return { dir, local, other };
}

// The fake bot. First boot: publish "v2" to main (standing in for an
// auto-merged self_fix PR) and exit 42 asking for a restart. If it ever runs a
// second time it just stops — so a supervisor that fails to pull loops exactly
// once and the test gets a clean failure instead of hanging.
const V1 = `
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
fs.appendFileSync(process.env.PANDA_TEST_LOG, 'v1\\n');
if (fs.existsSync(process.env.PANDA_MARKER)) process.exit(0);
fs.writeFileSync(process.env.PANDA_MARKER, 'x');
execFileSync('bash', [process.env.PANDA_PUBLISH_V2], { stdio: 'pipe' });
process.exit(42);
`;

const V2 = `
import fs from 'node:fs';
fs.appendFileSync(process.env.PANDA_TEST_LOG, 'v2\\n');
process.exit(0);
`;

function runSupervisor({ local, dir, other }) {
  const log = path.join(dir, 'boot.log');
  const marker = path.join(dir, 'marker');
  const publish = path.join(dir, 'publish-v2.sh');
  fs.writeFileSync(
    publish,
    [
      '#!/bin/bash',
      'set -e',
      `cd ${JSON.stringify(other)}`,
      `cat > src/index.js <<'EOF'\n${V2}\nEOF`,
      'git add -A && git commit -m v2 && git push origin main',
    ].join('\n'),
  );

  execFileSync('bash', ['run.sh'], {
    cwd: local,
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: 60_000,
    env: {
      ...process.env,
      PANDA_TEST_LOG: log,
      PANDA_MARKER: marker,
      PANDA_PUBLISH_V2: publish,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
    },
  });
  return fs.readFileSync(log, 'utf8');
}

test('a restart picks up code that landed on main while the bot was running', async () => {
  const deployment = scaffoldDeployment(V1);

  const bootLog = runSupervisor(deployment);

  // v1 asked for a restart; the supervisor must pull before booting again, so
  // the second boot is the merged v2 — not v1 over and over.
  assert.equal(bootLog, 'v1\nv2\n');
  assert.match(fs.readFileSync(path.join(deployment.local, 'src/index.js'), 'utf8'), /v2/);
});

test('run.sh writes the gitignored supervisor when it is missing', async () => {
  const deployment = scaffoldDeployment(V1);
  assert.equal(fs.existsSync(path.join(deployment.local, 'start.sh')), false);

  runSupervisor(deployment);

  const startSh = path.join(deployment.local, 'start.sh');
  assert.ok(fs.existsSync(startSh), 'start.sh should have been bootstrapped');
  assert.ok(fs.statSync(startSh).mode & 0o111, 'start.sh must be executable');
  // Generated, never committed — that is what keeps a pull from yanking the
  // script out from under the running supervisor.
  assert.equal(git(['status', '--porcelain'], deployment.local).trim(), '');
});

test('start.sh is gitignored in this repo', () => {
  const ignored = execFileSync('git', ['check-ignore', 'start.sh'], { cwd: REPO, encoding: 'utf8', stdio: 'pipe' });
  assert.equal(ignored.trim(), 'start.sh');
});
