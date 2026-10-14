import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const REPO = process.cwd();

const script = (file, body) => {
  writeFileSync(file, `#!/bin/bash\n${body}\n`);
  chmodSync(file, 0o755);
};

// A throwaway copy of the repo layout the script needs, with fake `git` and `uv`
// so nothing is downloaded. The fake `uv venv` makes a fake python that records
// how it was started and then just waits, standing in for SearXNG.
function stage({ settings = null } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'panda-searx-'));
  mkdirSync(path.join(root, 'scripts'));
  mkdirSync(path.join(root, 'searxng', 'config'), { recursive: true });
  copyFileSync(path.join(REPO, 'scripts', 'ensure-searxng.sh'), path.join(root, 'scripts', 'ensure-searxng.sh'));
  copyFileSync(path.join(REPO, 'searxng', 'config', 'settings.example.yml'), path.join(root, 'searxng', 'config', 'settings.example.yml'));
  if (settings !== null) writeFileSync(path.join(root, 'searxng', 'config', 'settings.yml'), settings);

  const bin = path.join(root, 'bin');
  mkdirSync(bin);
  script(path.join(bin, 'git'), 'echo "git $*" >> "$TOOL_LOG"\n[ -n "$GIT_FAIL" ] && exit 1\n[ "$1" = init ] && mkdir -p "$3/.git"\nexit 0');
  script(
    path.join(bin, 'uv'),
    [
      'echo "uv $*" >> "$TOOL_LOG"',
      'if [ "$1" = venv ]; then',
      '  mkdir -p searxng/.venv/bin',
      `  printf '#!/bin/bash\\nenv | grep ^SEARXNG_ > searxng/python.log\\necho "args $*" >> searxng/python.log\\nexec sleep 30\\n' > searxng/.venv/bin/python`,
      '  chmod +x searxng/.venv/bin/python',
      'fi',
    ].join('\n'),
  );
  return { root, bin };
}

// UV_BIN / GIT_BIN, not PATH surgery: stripping the system PATH broke bash itself
// on Windows. SEARXNG_URL points at a port nothing listens on, so it is never "already up".
function run({ root, bin }, env = {}) {
  const result = spawnSync('bash', [path.join(root, 'scripts', 'ensure-searxng.sh')], {
    encoding: 'utf8',
    env: {
      ...process.env,
      UV_BIN: path.join(bin, 'uv'),
      GIT_BIN: path.join(bin, 'git'),
      TOOL_LOG: path.join(root, 'tools.log'),
      SEARXNG_URL: 'http://127.0.0.1:8899',
      SEARXNG_WAIT: '0',
      ...env,
    },
  });
  // Stop the stand-in SearXNG the script left running, once it has logged how it
  // was started: with SEARXNG_WAIT=0 the script returns before that on a slow
  // runner, and killing it first left the log empty in CI.
  const pidFile = path.join(root, 'searxng', 'searxng.pid');
  if (existsSync(pidFile)) {
    for (let i = 0; i < 100 && !read(root, 'searxng/python.log').includes('args '); i++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    result.pid = Number(readFileSync(pidFile, 'utf8'));
    try { process.kill(result.pid); } catch {}
  }
  return result;
}
const read = (root, file) => (existsSync(path.join(root, file)) ? readFileSync(path.join(root, file), 'utf8') : '');

test('never clobbers a settings.yml that already exists', () => {
  const mine = 'use_default_settings: true\nserver:\n  secret_key: "mine"\n';
  const dirs = stage({ settings: mine });
  run(dirs);
  assert.equal(read(dirs.root, 'searxng/config/settings.yml'), mine);
});

test('does nothing when SEARXNG_URL is not a loopback address', () => {
  const dirs = stage();
  const result = run(dirs, { SEARXNG_URL: 'http://searxng:8080' });
  assert.equal(result.status, 0);
  assert.equal(read(dirs.root, 'tools.log'), '', 'the deploy runs its own searxng service');
});

// run.sh with a stand-in bot (`node` that exits at once) and a given ensure-searxng.sh.
function boot(ensureBody) {
  const root = mkdtempSync(path.join(tmpdir(), 'panda-run-'));
  mkdirSync(path.join(root, 'scripts'));
  mkdirSync(path.join(root, 'searxng'));
  copyFileSync(path.join(REPO, 'run.sh'), path.join(root, 'run.sh'));
  writeFileSync(path.join(root, 'scripts', 'ensure-searxng.sh'), `${ensureBody}\n`);
  chmodSync(path.join(root, 'scripts', 'ensure-searxng.sh'), 0o644); // as git stores it
  const bin = path.join(root, 'bin');
  mkdirSync(bin);
  script(path.join(bin, 'node'), 'exit 0');
  const result = spawnSync('bash', [path.join(root, 'run.sh')], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, PANDA_SUPERVISED: '1' },
  });
  return { root, result };
}

test('run.sh brings SearXNG up even when the script has no executable bit', () => {
  const { root, result } = boot('cd "$(dirname "$0")/.." && touch ran');
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(path.join(root, 'ran')), 'ensure-searxng.sh must run on boot');
});

test('run.sh stops the SearXNG it started when the bot stops', () => {
  // started.pid is the test's own copy: run.sh only knows searxng.pid.
  const { root, result } = boot('cd "$(dirname "$0")/.." && { sleep 30 & echo $! > searxng/searxng.pid; echo $! > started.pid; }');
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!existsSync(path.join(root, 'searxng/searxng.pid')), 'the pid file is cleared');
  const pid = Number(readFileSync(path.join(root, 'started.pid'), 'utf8'));
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'the stand-in SearXNG must be gone');
});
