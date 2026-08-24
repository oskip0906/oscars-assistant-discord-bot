import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ContextStore, splitAtBoundary } from '../src/agent/contextStore.js';
import { collectExchanges, foldIntoSummary, rememberEvicted } from '../src/agent/memory.js';
import { runAgent } from '../src/agent/agent.js';

const store = () => new ContextStore(mkdtempSync(path.join(tmpdir(), 'panda-ctx-')));

// --- what long-term memory keeps -----------------------------------------

test('remembers what Panda answered, not only what was asked', () => {
  const evicted = [
    { role: 'user', content: 'where does the deploy config live?' },
    { role: 'assistant', content: '', tool_calls: [{ id: '1', function: { name: 'vault_fetch', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: '1', content: 'a big blob of page text' },
    { role: 'assistant', content: 'It is docker-compose.deploy.yml at the repo root.' },
  ];

  assert.deepEqual(collectExchanges(evicted), [
    'Q: where does the deploy config live?\nA: It is docker-compose.deploy.yml at the repo root.',
  ]);
});

test('keeps a question that never got an answer rather than dropping the turn', () => {
  assert.deepEqual(collectExchanges([{ role: 'user', content: 'still there?' }]), ['Q: still there?']);
});

test('pairs each question with the final reply, not the intermediate tool narration', () => {
  const [only] = collectExchanges([
    { role: 'user', content: 'who won?' },
    { role: 'assistant', content: 'Let me look that up.' },
    { role: 'tool', tool_call_id: '1', content: 'raw results' },
    { role: 'assistant', content: 'Argentina won in 2022.' },
  ]);
  assert.match(only, /A: Argentina won in 2022\./);
});

// --- the verbatim window --------------------------------------------------

test('never wipes the transcript when the tail has no user message to cut on', () => {
  const messages = [
    { role: 'user', content: 'go' },
    ...Array.from({ length: 60 }, (_, i) =>
      i % 2 ? { role: 'tool', tool_call_id: 't', content: 'r' } : { role: 'assistant', content: 'a' },
    ),
  ];

  const { kept, evicted } = splitAtBoundary(messages, 40);
  assert.ok(kept.length > 0, 'the whole conversation must not vanish because no clean boundary was in range');
  assert.equal(evicted.length, 0);
});

test('carries over what an older file accumulated under the previous field name', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'panda-ctx-'));
  writeFileSync(
    path.join(dir, 'g.json'),
    JSON.stringify({ summary: 'known things', messages: [], pendingPrompts: ['Q: old one'] }),
  );

  const s = new ContextStore(dir);
  assert.equal(s.pendingCount('g'), 1, 'an upgrade must not silently discard accumulated memory');
  assert.equal(s.summary('g'), 'known things');
});

// --- compaction -----------------------------------------------------------

test('does not lose exchanges when two compactions overlap', async () => {
  const s = store();
  const config = { openrouterApiKey: 'k', model: 'm' };
  // Report how many numbered exchanges the fold actually saw, so a batch that
  // gets clobbered by a concurrent write is visible in the stored summary.
  const chat = async ({ messages }) => {
    const saw = (messages[1].content.match(/^\d+\. /gm) || []).length;
    await new Promise((r) => setTimeout(r, 30));
    return { content: `saw:${saw}` };
  };

  const turn = (n) =>
    Array.from({ length: 10 }, (_, i) => [
      { role: 'user', content: `q${n}-${i}` },
      { role: 'assistant', content: `a${n}-${i}` },
    ]).flat();

  await Promise.all([
    rememberEvicted({ store: s, key: 'g', evicted: turn(1), config, chat }),
    rememberEvicted({ store: s, key: 'g', evicted: turn(2), config, chat }),
  ]);

  assert.equal(s.summary('g'), 'saw:20', 'every exchange must reach a fold; a racing write drops a whole batch');
  assert.equal(s.pendingCount('g'), 0, 'nothing may be left stranded in the pending list');
});

test('trims an over-long summary at a sentence end instead of mid-word', async () => {
  const long = `${'Panda established a fact about the deploy. '.repeat(80)}`;
  const out = await foldIntoSummary({
    previous: '',
    pending: ['Q: x\nA: y'],
    apiKey: 'k',
    model: 'm',
    chat: async () => ({ content: long }),
  });

  assert.ok(out.length <= 1500);
  assert.ok(/[.!?…]$/.test(out.trim()), `summary should end on a sentence, got: ${JSON.stringify(out.slice(-40))}`);
});

// --- the turn survives a failure -----------------------------------------

test('still remembers the question when the model call fails mid-turn', async () => {
  const s = store();
  const invocation = {
    contextStore: s,
    contextKey: 'g',
    config: { openrouterApiKey: 'k', model: 'm', maxToolIterations: 4, botName: 'Panda', ownerId: '1', contextFilesDir: 'context' },
    isOwner: false,
    guild: null,
    message: { channel: { name: 'general' }, author: { id: '2', username: 'someone', displayName: 'Someone' } },
  };

  await assert.rejects(() =>
    runAgent(invocation, 'sent to the model', 'what the user actually said', {
      chat: async () => { throw new Error('openrouter exploded'); },
    }),
  );

  const kept = s.get('g');
  assert.equal(kept.length, 1, 'the user turn must survive a failed reply');
  assert.equal(kept[0].content, 'what the user actually said');
});
