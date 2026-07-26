import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DevRunStore, resolveInterruptedRun } from '../src/devRunStore.js';

const dataDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'panda-run-'));
const RUN = { kind: 'self_fix', repo: 'oskip0906/oscars-assistant-discord-bot', branch: 'panda-dev-abc', base: 'main' };

function harness(pr) {
  const lines = [];
  const dms = [];
  return {
    lines,
    dms,
    deps: {
      gh: async () => ({ status: 200, json: pr ? [pr] : [] }),
      log: (line) => lines.push(line),
      notify: async (_client, _owner, content) => dms.push(content),
    },
  };
}

test('a self-fix that merged while the bot was restarting is logged and reported', async () => {
  const store = new DevRunStore(dataDir());
  store.begin(RUN);
  const { lines, dms, deps } = harness({ number: 31, merged_at: '2026-07-26T00:00:00Z', state: 'closed', html_url: 'https://example.test/pr/31' });

  // The exact gap: the sandbox merged the fix, the restart killed the process
  // waiting on it, and the run finished with nothing written anywhere.
  const result = await resolveInterruptedRun({ store, ...deps });

  assert.equal(result.outcome, 'merged-during-restart');
  assert.match(lines[0], /^\[panda\] self_fix finish outcome=merged-during-restart .*pr=31/);
  assert.match(dms[0], /landed while I was restarting/);
  assert.equal(store.read(), null, 'the record is consumed, not replayed on every boot');
});

test('an interrupted run whose pull request never appeared says so', async () => {
  const store = new DevRunStore(dataDir());
  store.begin(RUN);
  const { lines, dms, deps } = harness(null);

  const result = await resolveInterruptedRun({ store, ...deps });

  assert.equal(result.outcome, 'unknown-after-restart');
  assert.match(lines[0], /outcome=unknown-after-restart/);
  assert.deepEqual(dms, [], 'nothing to link to, so nothing to DM');
});

test('an ordinary boot with no run in flight stays silent', async () => {
  const store = new DevRunStore(dataDir());
  const { lines, deps } = harness(null);

  assert.equal(await resolveInterruptedRun({ store, ...deps }), null);
  assert.deepEqual(lines, []);
});

test('a run record survives the process that wrote it', () => {
  const dir = dataDir();
  new DevRunStore(dir).begin(RUN);

  // A different instance, as after a restart.
  assert.deepEqual(new DevRunStore(dir).read(), RUN);
});

test('an unreadable record is treated as no record, never as a crash', () => {
  const dir = dataDir();
  fs.writeFileSync(path.join(dir, 'development-run.json'), '{ not json');

  assert.equal(new DevRunStore(dir).read(), null);
});
