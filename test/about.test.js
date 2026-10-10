import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { howIWork } from '../src/agent/tools/about.js';

const README = '# Bot\nintro\n\n## Memory\nforty messages\n\n## Music\nplays songs\n';

function invocationWith(readme) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'about-'));
  if (readme !== undefined) fs.writeFileSync(path.join(projectRoot, 'ARCHITECTURE.md'), readme);
  return { config: { projectRoot } };
}

test('a topic returns only the sections that mention it', () => {
  assert.equal(howIWork({ topic: 'memory' }, invocationWith(README)), '## Memory\nforty messages\n\n');
});

test('no topic, or no match, returns the whole manual', () => {
  const inv = invocationWith(README);
  assert.equal(howIWork({}, inv), README);
  assert.equal(howIWork({ topic: 'quantum' }, inv), README);
});

test('a missing README says so instead of throwing', () => {
  assert.match(howIWork({}, invocationWith()), /not available/);
});
