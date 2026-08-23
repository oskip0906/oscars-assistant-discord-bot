import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const REPO = process.cwd();

// A throwaway copy of the repo layout the script needs, plus a fake `docker`
// early on PATH so nothing real is started.
function stage({ withDocker = true, settings = null } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'panda-searx-'));
  mkdirSync(path.join(root, 'scripts'));
  mkdirSync(path.join(root, 'searxng', 'config'), { recursive: true });
  copyFileSync(path.join(REPO, 'scripts', 'ensure-searxng.sh'), path.join(root, 'scripts', 'ensure-searxng.sh'));
  copyFileSync(
    path.join(REPO, 'searxng', 'config', 'settings.example.yml'),
    path.join(root, 'searxng', 'config', 'settings.example.yml'),
  );
  copyFileSync(path.join(REPO, 'searxng', 'docker-compose.yml'), path.join(root, 'searxng', 'docker-compose.yml'));
  if (settings !== null) writeFileSync(path.join(root, 'searxng', 'config', 'settings.yml'), settings);

  const bin = path.join(root, 'bin');
  mkdirSync(bin);
  if (withDocker) {
    const fake = path.join(bin, 'docker');
    writeFileSync(fake, '#!/bin/bash\necho "$@" >> "$(dirname "$0")/../docker.log"\nexit 0\n');
    chmodSync(fake, 0o755);
  }
  return { root, bin };
}

// DOCKER_BIN, not PATH surgery: stripping the system PATH broke bash itself on
// Windows, and merely omitting the fake left the REAL docker answering
// `command -v docker` — which ran a real `docker compose` against the temp dir.
const run = ({ root, bin }, env = {}) =>
  spawnSync('bash', [path.join(root, 'scripts', 'ensure-searxng.sh')], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      DOCKER_BIN: path.join(bin, 'docker'),
      SEARXNG_URL: 'http://127.0.0.1:8899',
      SEARXNG_WAIT: '0',
      ...env,
    },
  });

test('generates settings.yml with a real secret key when it is missing', () => {
  const dirs = stage();
  const result = run(dirs);

  const written = readFileSync(path.join(dirs.root, 'searxng', 'config', 'settings.yml'), 'utf8');
  assert.doesNotMatch(written, /REPLACE_ME/, 'the placeholder secret must be replaced');
  assert.match(written, /secret_key: "[0-9a-f]{64}"/, 'a 32-byte hex secret is required by SearXNG');
  assert.equal(result.status, 0);
});

test('never clobbers a settings.yml that already exists', () => {
  const mine = 'use_default_settings: true\nserver:\n  secret_key: "mine"\n';
  const dirs = stage({ settings: mine });

  run(dirs);

  assert.equal(readFileSync(path.join(dirs.root, 'searxng', 'config', 'settings.yml'), 'utf8'), mine);
});

test('starts the container once the settings exist', () => {
  const dirs = stage();

  run(dirs);

  const log = readFileSync(path.join(dirs.root, 'docker.log'), 'utf8');
  assert.match(log, /compose .*up -d/, 'the compose stack should be brought up');
});

test('exits cleanly when docker is unavailable — a missing search backend must not stop the bot booting', () => {
  const dirs = stage({ withDocker: false });

  const result = run(dirs, { DOCKER_BIN: 'panda-no-such-docker' });

  assert.equal(result.status, 0, 'run.sh sources this on the boot path; a non-zero exit would kill startup');
  assert.match(result.stderr, /docker/i, 'it should say why search will not work');
});

test('does nothing when SEARXNG_URL is not a loopback address', () => {
  const dirs = stage();

  const result = run(dirs, { SEARXNG_URL: 'http://searxng:8080' });

  assert.equal(result.status, 0);
  assert.ok(!existsSync(path.join(dirs.root, 'docker.log')), 'the deploy container has no docker socket and its own searxng service');
});
