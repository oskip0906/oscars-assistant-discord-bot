import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildSnapshot } from '../src/agent/tools/repoSnapshot.js';

function scaffold(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'panda-snapshot-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return root;
}

const paths = (snapshot) => snapshot.files.map((file) => file.path);

test('source is snapshotted before docs and tests', () => {
  const files = {
    'README.md': 'r'.repeat(100),
    'context/notes.md': 'c'.repeat(100),
    'src/discord/usage.js': 'u'.repeat(100),
    'src/index.js': 'i'.repeat(100),
    'test/usage.test.js': 't'.repeat(100),
  };
  const root = scaffold(files);

  const snapshot = buildSnapshot(root, Object.keys(files).sort());

  // Alphabetical order spent the budget on README and context/ before reaching
  // src/, so a self-fix could not see the code it was asked to change.
  assert.deepEqual(paths(snapshot).slice(0, 2), ['src/discord/usage.js', 'src/index.js']);
  assert.equal(paths(snapshot).at(-1), 'test/usage.test.js');
});

test('a file that does not fit is omitted whole, never truncated', () => {
  const files = { 'src/a.js': 'a'.repeat(60), 'src/b.js': 'b'.repeat(60), 'src/c.js': 'c'.repeat(10) };
  const root = scaffold(files);

  const snapshot = buildSnapshot(root, ['src/a.js', 'src/b.js', 'src/c.js'], { budget: 100 });

  // The model is asked for complete file contents; it cannot produce them for a
  // file it was shown half of.
  assert.deepEqual(paths(snapshot), ['src/a.js', 'src/c.js']);
  assert.deepEqual(snapshot.omitted, ['src/b.js']);
  for (const file of snapshot.files) {
    assert.equal(file.content, fs.readFileSync(path.join(root, file.path), 'utf8'));
  }
});

test('every source file of this repository fits in one snapshot', () => {
  const root = path.resolve(import.meta.dirname, '..');
  const tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);

  const snapshot = buildSnapshot(root, tracked);
  const included = new Set(paths(snapshot));
  const missingSource = tracked.filter((file) => file.startsWith('src/') && !included.has(file));

  // The regression: src/ alone was larger than the whole 140,000-char budget, so
  // files late in the alphabet silently never reached the model — including the
  // ones a self-fix had just been asked to change.
  assert.deepEqual(missingSource, []);
});

test('secrets, dependencies, runtime data, and the workflow itself stay out', () => {
  const tracked = ['.env', '.env.local', 'data/context/x.json', 'node_modules/pkg/index.js', '.github/workflows/development-sandbox.yml', 'src/a.js'];
  const root = scaffold({ 'src/a.js': 'ok' });

  const snapshot = buildSnapshot(root, tracked);

  assert.deepEqual(paths(snapshot), ['src/a.js']);
  assert.deepEqual(snapshot.omitted, []);
});

test('binary blobs are skipped without being reported as missing source', () => {
  const root = scaffold({ 'assets/logo.png': 'PNG\0\0binary', 'src/a.js': 'ok' });

  const snapshot = buildSnapshot(root, ['assets/logo.png', 'src/a.js']);

  assert.deepEqual(paths(snapshot), ['src/a.js']);
  assert.deepEqual(snapshot.omitted, []);
});

test('an oversized file is reported as omitted rather than silently dropped', () => {
  const root = scaffold({ 'package-lock.json': 'x'.repeat(80_000), 'src/a.js': 'ok' });

  const snapshot = buildSnapshot(root, ['package-lock.json', 'src/a.js']);

  assert.deepEqual(paths(snapshot), ['src/a.js']);
  // Handed to the model so it can say what it needs instead of guessing.
  assert.deepEqual(snapshot.omitted, ['package-lock.json']);
});
