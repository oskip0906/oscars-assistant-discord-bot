import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { unresolvedImports } from '../src/agent/tools/verifyEdits.js';

// Build a throwaway project tree: { 'src/a.js': '...' } -> root dir
function scaffold(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'panda-verify-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return root;
}

test('a correct relative import resolves clean', () => {
  const root = scaffold({
    'src/config.js': 'export const config = {};',
    'src/discord/handler.js': "import { config } from '../config.js';",
  });
  assert.deepEqual(unresolvedImports(path.join(root, 'src/discord/handler.js')), []);
});

// This is the exact bug that took the bot down: handler.js lives in src/discord/,
// so '../../config.js' points at the project root, where there is no config.js.
// `node --check` passes this file happily — only resolution catches it.
test('flags a relative import that points at a nonexistent file', () => {
  const root = scaffold({
    'src/config.js': 'export const config = {};',
    'src/discord/handler.js': "import { config } from '../../config.js';",
  });
  assert.deepEqual(unresolvedImports(path.join(root, 'src/discord/handler.js')), ['../../config.js']);
});

test('ignores bare and node: specifiers, which are not ours to resolve', () => {
  const root = scaffold({
    'src/a.js': [
      "import fs from 'node:fs';",
      "import { Client } from 'discord.js';",
      "import dotenv from 'dotenv';",
    ].join('\n'),
  });
  assert.deepEqual(unresolvedImports(path.join(root, 'src/a.js')), []);
});

test('checks re-exports too', () => {
  const root = scaffold({
    'src/a.js': "export { thing } from './missing.js';",
  });
  assert.deepEqual(unresolvedImports(path.join(root, 'src/a.js')), ['./missing.js']);
});

test('checks side-effect imports', () => {
  const root = scaffold({
    'src/a.js': "import './nope.js';",
  });
  assert.deepEqual(unresolvedImports(path.join(root, 'src/a.js')), ['./nope.js']);
});

test('checks dynamic import() with a literal path', () => {
  const root = scaffold({
    'src/a.js': "const m = await import('./gone.js');",
  });
  assert.deepEqual(unresolvedImports(path.join(root, 'src/a.js')), ['./gone.js']);
});

test('reports every broken specifier, not just the first', () => {
  const root = scaffold({
    'src/ok.js': 'export const ok = 1;',
    'src/a.js': [
      "import { ok } from './ok.js';",
      "import { x } from './x.js';",
      "import { y } from './y.js';",
    ].join('\n'),
  });
  assert.deepEqual(unresolvedImports(path.join(root, 'src/a.js')), ['./x.js', './y.js']);
});

test('a commented-out import is not flagged', () => {
  const root = scaffold({
    'src/a.js': "// import { restart } from '../../index.js';\nexport const a = 1;",
  });
  assert.deepEqual(unresolvedImports(path.join(root, 'src/a.js')), []);
});
