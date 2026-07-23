import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PrivateMode, PRIVATE_MESSAGE } from '../src/privateMode.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'panda-priv-'));

test('defaults to off with no flag file', () => {
  const pm = new PrivateMode(tmp());
  assert.equal(pm.isOn(), false);
});

test('set(true)/set(false) toggles and persists to disk', () => {
  const dir = tmp();
  const pm = new PrivateMode(dir);
  pm.set(true);
  assert.equal(pm.isOn(), true);
  assert.equal(fs.readFileSync(path.join(dir, 'private-mode.flag'), 'utf8').trim(), 'ON');
  pm.set(false);
  assert.equal(pm.isOn(), false);
});

test('state survives a restart (new instance reads the flag)', () => {
  const dir = tmp();
  new PrivateMode(dir).set(true);
  const restarted = new PrivateMode(dir);
  assert.equal(restarted.isOn(), true);
});

test('the refusal string is the exact hardcoded message', () => {
  assert.equal(PRIVATE_MESSAGE, 'I am in a private conversation with Oscar right now.');
});
