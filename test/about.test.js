import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { howIWork, excerpt, resetSourceCache } from '../src/agent/tools/about.js';

const README = '# Bot\nintro\n\n## Memory\nforty messages\n\n## Music\nplays songs\n';
const FILES = {
  'ARCHITECTURE.md': README,
  'src/music/player.js': 'export function play() {}\n',
  'src/agent/historyStore.js': 'export function saveContext() {}\n',
};

// GitHub serving FILES: the tree from the API, contents from raw.githubusercontent.com.
function github(files = FILES) {
  return async (url) => {
    if (url.includes('/git/trees/')) return Response.json({ tree: Object.keys(files).map((p) => ({ path: p, type: 'blob' })) });
    const file = Object.keys(files).find((p) => url.endsWith(`/main/${p}`));
    return file ? new Response(files[file]) : new Response('missing', { status: 404 });
  };
}
const down = async () => {
  throw new Error('offline');
};

function invocationWith(local) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'about-'));
  if (local !== undefined) fs.writeFileSync(path.join(projectRoot, 'ARCHITECTURE.md'), local);
  return { config: { projectRoot, developmentSandboxRepo: 'o/r' } };
}

test('no topic returns the whole manual from GitHub, without code', async () => {
  resetSourceCache();
  assert.equal(await howIWork({}, invocationWith(), { fetchImpl: github() }), README);
});

test('a topic returns the matching manual sections and the code files Jev picks', async () => {
  resetSourceCache();
  const jev = async (_c, state, questions) =>
    Object.fromEntries(Object.keys(questions).map((q) => [q, { noul: state[q.slice(4)] === 'src/music/player.js' ? 0.9 : 0.1 }]));
  const out = await howIWork({ topic: 'music' }, invocationWith(), { fetchImpl: github(), decideImpl: jev });
  assert.match(out, /^## Music\nplays songs/);
  assert.match(out, /--- src\/music\/player\.js \(https:\/\/github\.com\/o\/r\/blob\/main\/src\/music\/player\.js\) ---\nexport function play/);
  assert.ok(!out.includes('saveContext'), 'files Jev did not pick stay out');
});

test('Jev down picks files by path; GitHub down falls back to the local manual', async () => {
  resetSourceCache();
  const out = await howIWork({ topic: 'music' }, invocationWith(), { fetchImpl: github(), decideImpl: async () => null });
  assert.match(out, /src\/music\/player\.js/);
  resetSourceCache();
  assert.equal(await howIWork({}, invocationWith('# local'), { fetchImpl: down }), '# local');
  assert.match(await howIWork({}, invocationWith(), { fetchImpl: down }), /not available/);
});

test('a long file is cut to the lines around the topic', () => {
  const text = Array.from({ length: 200 }, (_, i) => (i === 150 ? 'const jev = 1;' : `line ${i}`)).join('\n');
  const out = excerpt(text, ['jev'], 600);
  assert.ok(out.includes('const jev = 1;'));
  assert.ok(out.includes('(line 139)'));
  assert.ok(!out.includes('line 10\n'));
  assert.ok(out.length <= 610);
});
