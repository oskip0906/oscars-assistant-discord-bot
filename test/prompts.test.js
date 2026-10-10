import test from 'node:test';
import assert from 'node:assert/strict';
import { readPrompt, loadPrompt, writePrompt, clearPromptCache } from '../src/agent/prompts.js';
import { setRule } from '../src/agent/tools/rules.js';
import { getAIConfig } from '../src/configManager.js';

const config = { supabaseUrl: 'https://x.supabase.co', supabaseKey: 'sb_secret_test', openrouterApiKey: 'k' };

// A fake `prompts` bucket: GET reads `files`, POST writes them; a missing file
// answers like Supabase does (HTTP 400, "not_found").
function bucket(files = {}, { down = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const name = url.split('/storage/v1/object/prompts/')[1];
    calls.push(`${init.method} ${name}`);
    if (down) return new Response('boom', { status: 503 });
    if (init.method === 'GET') return name in files ? new Response(files[name]) : new Response('{"error":"not_found"}', { status: 400 });
    assert.equal(init.headers['x-upsert'], 'true');
    files[name] = init.body;
    return new Response('{}');
  };
  return { files, calls, fetchImpl };
}

test('readPrompt fetches once per minute, and runs without Supabase', async () => {
  clearPromptCache();
  assert.equal(await readPrompt({}, 'identity.md', { fetchImpl: () => assert.fail('fetched without Supabase') }), '');
  const b = bucket({ 'identity.md': 'I am Panda' });
  assert.equal(await readPrompt(config, 'identity.md', b), 'I am Panda');
  assert.equal(await readPrompt(config, 'identity.md', b), 'I am Panda');
  assert.deepEqual(b.calls, ['GET identity.md']);
});

test('readPrompt keeps the last copy when Supabase goes down, and is empty if it never loaded', async () => {
  clearPromptCache();
  assert.equal(await readPrompt(config, 'soul.md', bucket({}, { down: true })), '');
  await readPrompt(config, 'soul.md', bucket({ 'soul.md': 'warm' }));
  const realNow = Date.now;
  Date.now = () => realNow() + 61_000;
  try {
    assert.equal(await readPrompt(config, 'soul.md', bucket({}, { down: true })), 'warm');
  } finally {
    Date.now = realNow;
  }
});

test('loadPrompt throws instead of returning a stale or empty copy', async () => {
  clearPromptCache();
  await assert.rejects(loadPrompt(config, 'soul.md', bucket({})), /HTTP 400/);
  await assert.rejects(loadPrompt({}, 'soul.md', bucket({ 'soul.md': 'x' })), /SUPABASE_URL/);
});

test('writePrompt upserts the file and refreshes the cache', async () => {
  clearPromptCache();
  const b = bucket({ 'soul.md': 'old' });
  await writePrompt(config, 'soul.md', 'new', b);
  assert.equal(b.files['soul.md'], 'new');
  assert.equal(await readPrompt(config, 'soul.md', b), 'new');
  assert.deepEqual(b.calls, ['POST soul.md']);
});

// --- set_rule ------------------------------------------------------------------

const rewrite = (content) => {
  const seen = [];
  const chat = async (req) => (seen.push(req), { content });
  return { chat, seen };
};

test('set_rule rewrites soul.md with the development model and keeps the old one first', async () => {
  clearPromptCache();
  const b = bucket({ 'identity.md': 'I am Panda', 'soul.md': '# soul\n- be warm\n' });
  const { chat, seen } = rewrite('```markdown\n# soul\n- be warm\n- be sarcastic\n```');
  const out = await setRule({ instruction: 'be sarcastic' }, { config }, { chat, fetchImpl: b.fetchImpl });

  assert.equal(seen[0].model, getAIConfig('development').model);
  assert.match(seen[0].messages[1].content, /I am Panda[\s\S]*- be warm[\s\S]*be sarcastic/);
  assert.equal(b.files['soul.md'], '# soul\n- be warm\n- be sarcastic\n');
  const backup = b.calls.find((c) => c.startsWith('POST history/'));
  assert.ok(backup, 'the old soul.md is saved');
  assert.equal(b.files[backup.slice(5)], '# soul\n- be warm\n');
  assert.ok(b.calls.indexOf(backup) < b.calls.indexOf('POST soul.md'), 'backup is written before soul.md');
  assert.match(out, /soul\.md updated[\s\S]*- be sarcastic/);
});

test('set_rule changes nothing when soul.md cannot be read or the model gives nothing back', async () => {
  clearPromptCache();
  const unreadable = bucket({ 'identity.md': 'I am Panda' });
  const never = { chat: () => assert.fail('the model must not run without the current soul.md') };
  assert.match(await setRule({ instruction: 'x' }, { config }, { ...never, fetchImpl: unreadable.fetchImpl }), /nothing changed/);
  assert.ok(!unreadable.calls.some((c) => c.startsWith('POST')));

  for (const content of ['', '   ', '- be warm']) {
    clearPromptCache();
    const b = bucket({ 'identity.md': 'I am Panda', 'soul.md': '- be warm\n' });
    await setRule({ instruction: 'x' }, { config }, { chat: rewrite(content).chat, fetchImpl: b.fetchImpl });
    assert.ok(!b.calls.some((c) => c.startsWith('POST')), `nothing written for ${JSON.stringify(content)}`);
  }
  assert.match(await setRule({ instruction: ' ' }, { config }, never), /what to change/);
});
