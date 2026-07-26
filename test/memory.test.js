import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ContextStore, splitAtBoundary } from '../src/agent/contextStore.js';
import { foldIntoSummary, rememberEvicted } from '../src/agent/memory.js';

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'panda-memory-'));
const turn = (n) => [
  { role: 'user', content: `question ${n}` },
  { role: 'assistant', content: `answer ${n}` },
];

test('messages that age out are handed back, not silently deleted', () => {
  const messages = Array.from({ length: 50 }, (_, i) => (i % 2 ? { role: 'assistant', content: `a${i}` } : { role: 'user', content: `u${i}` }));

  const { kept, evicted } = splitAtBoundary(messages, 40);

  assert.equal(kept.length + evicted.length, messages.length, 'nothing may vanish');
  assert.equal(kept[0].role, 'user', 'the kept transcript still starts on a user boundary');
  assert.deepEqual(evicted, messages.slice(0, messages.length - kept.length));
});

test('the store keeps a summary alongside the transcript, across processes', () => {
  const d = dir();
  const store = new ContextStore(d);
  store.append('guild1', turn(1));
  store.setSummary('guild1', 'Oscar is building a Discord bot called Panda.');

  const reopened = new ContextStore(d);
  assert.equal(reopened.summary('guild1'), 'Oscar is building a Discord bot called Panda.');
  assert.equal(reopened.get('guild1').length, 2);
});

test('a transcript written before summaries existed still loads', () => {
  const d = dir();
  fs.writeFileSync(path.join(d, 'guild1.json'), JSON.stringify([{ role: 'user', content: 'from the old format' }]));

  const store = new ContextStore(d);
  assert.equal(store.get('guild1')[0].content, 'from the old format');
  assert.equal(store.summary('guild1'), '');
});

test('a transcript already polluted with history blocks heals itself on load', () => {
  const d = dir();
  fs.writeFileSync(
    path.join(d, 'guild1.json'),
    JSON.stringify([
      {
        role: 'user',
        content: '[HISTORY CONTEXT — the 2 message(s) before you were pinged]\nslopbot: Have a great day!\nPanda: Will do!\n[END HISTORY CONTEXT]\n\n[RESPOND TO THIS — A pinged you.]\nA: what is klaus about',
      },
      { role: 'assistant', content: 'A 2019 animated film.' },
    ]),
  );

  const messages = new ContextStore(d).get('guild1');

  assert.doesNotMatch(messages[0].content, /HISTORY CONTEXT/);
  assert.doesNotMatch(messages[0].content, /Have a great day/);
  assert.match(messages[0].content, /what is klaus about/, 'the real turn survives');
  assert.equal(messages[1].content, 'A 2019 animated film.');
});

test('appending past the window returns the overflow to be summarised', () => {
  const store = new ContextStore(dir());
  const evicted = [];
  // Each append reports only what that call pushed out, so collect them all.
  for (let i = 0; i < 30; i++) evicted.push(...store.append('guild1', turn(i)));

  assert.equal(store.get('guild1').length, 40, 'the verbatim window holds steady');
  assert.equal(evicted.length, 20, 'everything past the window is handed back');
  assert.equal(evicted[0].content, 'question 0', 'the oldest turn is the first to age out');
  assert.equal(store.get('guild1')[0].content, 'question 10', 'and the window starts where the evictions stopped');
});

test('a summary folds the old memory and the aged-out messages together', async () => {
  let seen = null;
  const chat = async ({ messages }) => {
    seen = messages[1].content;
    return { content: 'Oscar runs Panda. He wants logs for every self-fix.' };
  };

  const summary = await foldIntoSummary({
    previous: 'Oscar runs Panda.',
    evicted: [
      { role: 'user', content: 'oscar: i want logs for every self fix' },
      { role: 'assistant', content: 'Got it — start and finish lines.' },
    ],
    apiKey: 'k',
    model: 'm',
    chat,
  });

  assert.match(seen, /Current memory:\nOscar runs Panda\./);
  assert.match(seen, /THEM: oscar: i want logs/);
  assert.match(seen, /PANDA: Got it/);
  assert.match(summary, /logs for every self-fix/);
});

test('nothing worth remembering leaves the memory untouched', async () => {
  let called = false;
  const summary = await foldIntoSummary({
    previous: 'Oscar runs Panda.',
    evicted: [{ role: 'tool', tool_call_id: 'x', content: 'HTTP 200' }],
    chat: async () => {
      called = true;
      return { content: 'should not happen' };
    },
  });

  assert.equal(called, false, 'tool traffic alone is not worth a model call');
  assert.equal(summary, 'Oscar runs Panda.');
});

test('a failed summarisation never takes the turn down with it', async () => {
  const store = new ContextStore(dir());
  store.append('guild1', turn(1));

  await rememberEvicted({
    store,
    key: 'guild1',
    evicted: [{ role: 'user', content: 'something worth keeping' }],
    config: { openrouterApiKey: 'k', model: 'm' },
    chat: async () => {
      throw new Error('OpenRouter is down');
    },
  });

  assert.equal(store.summary('guild1'), '', 'the summary is simply not updated');
});
