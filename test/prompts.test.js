import test from 'node:test';
import assert from 'node:assert/strict';
import { readPrompt, loadPrompt, writePrompt, clearPromptCache } from '../src/agent/prompts.js';
import { setRule } from '../src/agent/tools/rules.js';
import { db } from '../src/db.js';

const config = { databaseUrl: 'postgres://test', openrouterApiKey: 'k', model: 'a/chat' };

// A fake `prompts` table: selects read `files`, upserts write them. `down`
// fails every query, like an unreachable database.
function table(files = {}, { down = false } = {}) {
  const calls = [];
  db.query = async (_config, text, params) => {
    if (down) throw new Error('connect ECONNREFUSED');
    if (text.startsWith('select content from prompts')) {
      calls.push(`GET ${params[0]}`);
      return { rows: params[0] in files ? [{ content: files[params[0]] }] : [] };
    }
    if (text.startsWith('insert into prompts')) {
      calls.push(`PUT ${params[0]}`);
      files[params[0]] = params[1];
      return { rows: [], rowCount: 1 };
    }
    if (text.includes('as used')) return { rows: [{ used: 0 }] }; // the storage check after a write
    throw new Error(`unexpected query: ${text}`);
  };
  return { files, calls };
}

test('readPrompt reads once per minute, and runs without a database', async () => {
  clearPromptCache();
  db.query = () => assert.fail('queried without a database');
  assert.equal(await readPrompt({}, 'identity.md'), '');
  const t = table({ 'identity.md': 'I am Panda' });
  assert.equal(await readPrompt(config, 'identity.md'), 'I am Panda');
  assert.equal(await readPrompt(config, 'identity.md'), 'I am Panda');
  assert.deepEqual(t.calls, ['GET identity.md']);
});

test('readPrompt keeps the last copy when the database goes down, and is empty if it never loaded', async () => {
  clearPromptCache();
  table({}, { down: true });
  assert.equal(await readPrompt(config, 'soul.md'), '');
  table({ 'soul.md': 'warm' });
  await readPrompt(config, 'soul.md');
  const realNow = Date.now;
  Date.now = () => realNow() + 61_000;
  try {
    table({}, { down: true });
    assert.equal(await readPrompt(config, 'soul.md'), 'warm');
  } finally {
    Date.now = realNow;
  }
});

test('loadPrompt throws instead of returning a stale or empty copy', async () => {
  clearPromptCache();
  table({});
  await assert.rejects(loadPrompt(config, 'soul.md'), /not found/);
  await assert.rejects(loadPrompt({}, 'soul.md'), /DATABASE_URL/);
});

test('writePrompt upserts the file and refreshes the cache', async () => {
  clearPromptCache();
  const t = table({ 'soul.md': 'old' });
  await writePrompt(config, 'soul.md', 'new');
  assert.equal(t.files['soul.md'], 'new');
  assert.equal(await readPrompt(config, 'soul.md'), 'new');
  assert.deepEqual(t.calls, ['PUT soul.md']);
});

// --- set_rule ------------------------------------------------------------------

const rewrite = (content) => {
  const seen = [];
  const chat = async (req) => (seen.push(req), { content });
  return { chat, seen };
};

test('set_rule rewrites soul.md with the conversation model and keeps the old one first', async () => {
  clearPromptCache();
  const t = table({ 'identity.md': 'I am Panda', 'soul.md': '# soul\n- be warm\n' });
  const { chat, seen } = rewrite('```markdown\n# soul\n- be warm\n- be sarcastic\n```');
  const out = await setRule({ instruction: 'be sarcastic' }, { config }, { chat });

  assert.equal(seen[0].model, config.model);
  assert.match(seen[0].messages[1].content, /I am Panda[\s\S]*- be warm[\s\S]*be sarcastic/);
  assert.equal(t.files['soul.md'], '# soul\n- be warm\n- be sarcastic\n');
  const backup = t.calls.find((c) => c.startsWith('PUT history/'));
  assert.ok(backup, 'the old soul.md is saved');
  assert.equal(t.files[backup.slice(4)], '# soul\n- be warm\n');
  assert.ok(t.calls.indexOf(backup) < t.calls.indexOf('PUT soul.md'), 'backup is written before soul.md');
  assert.match(out, /soul\.md updated[\s\S]*- be sarcastic/);
});

test('set_rule changes nothing when soul.md cannot be read or the model gives nothing back', async () => {
  clearPromptCache();
  const unreadable = table({ 'identity.md': 'I am Panda' });
  const never = { chat: () => assert.fail('the model must not run without the current soul.md') };
  assert.match(await setRule({ instruction: 'x' }, { config }, never), /nothing changed/);
  assert.ok(!unreadable.calls.some((c) => c.startsWith('PUT')));

  for (const content of ['', '   ', '- be warm']) {
    clearPromptCache();
    const t = table({ 'identity.md': 'I am Panda', 'soul.md': '- be warm\n' });
    await setRule({ instruction: 'x' }, { config }, { chat: rewrite(content).chat });
    assert.ok(!t.calls.some((c) => c.startsWith('PUT')), `nothing written for ${JSON.stringify(content)}`);
  }
  assert.match(await setRule({ instruction: ' ' }, { config }, never), /what to change/);
});
