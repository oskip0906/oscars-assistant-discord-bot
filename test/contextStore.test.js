import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ContextStore, trimToBoundary } from '../src/agent/contextStore.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'panda-ctx-'));

test('append + get roundtrip persists across store instances', () => {
  const dir = tmp();
  const store = new ContextStore(dir);
  store.append('guild1', [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
  ]);
  const fresh = new ContextStore(dir);
  assert.equal(fresh.get('guild1').length, 2);
  assert.equal(fresh.get('guild1')[0].content, 'hi');
});

test('contexts are isolated per key', () => {
  const dir = tmp();
  const store = new ContextStore(dir);
  store.append('guildA', [{ role: 'user', content: 'a' }]);
  store.append('guildB', [{ role: 'user', content: 'b' }]);
  assert.equal(store.get('guildA').length, 1);
  assert.equal(store.get('guildB').length, 1);
  assert.equal(store.get('guildA')[0].content, 'a');
});

test('clear wipes one key only; clearAll wipes everything', () => {
  const dir = tmp();
  const store = new ContextStore(dir);
  store.append('guildA', [{ role: 'user', content: 'a' }]);
  store.append('guildB', [{ role: 'user', content: 'b' }]);
  store.clear('guildA');
  assert.equal(store.get('guildA').length, 0);
  assert.equal(store.get('guildB').length, 1);
  store.clearAll();
  assert.equal(store.get('guildB').length, 0);
  assert.equal(fs.readdirSync(dir).filter((f) => f.endsWith('.json')).length, 0);
});

test('trimToBoundary keeps length <= max and starts on a user message', () => {
  const messages = [];
  for (let i = 0; i < 50; i++) {
    messages.push({ role: 'user', content: `u${i}` });
    messages.push({ role: 'assistant', content: `a${i}`, tool_calls: [{ id: `t${i}` }] });
    messages.push({ role: 'tool', tool_call_id: `t${i}`, content: 'result' });
    messages.push({ role: 'assistant', content: `final${i}` });
  }
  const out = trimToBoundary(messages, 10);
  assert.ok(out.length <= 10);
  assert.equal(out[0].role, 'user');
});

test('trimToBoundary is a no-op under the cap', () => {
  const messages = [
    { role: 'user', content: 'u' },
    { role: 'assistant', content: 'a' },
  ];
  assert.deepEqual(trimToBoundary(messages, 10), messages);
});

test('append trims long histories at a user boundary', () => {
  const dir = tmp();
  const store = new ContextStore(dir);
  for (let i = 0; i < 100; i++) {
    store.append('g', [
      { role: 'user', content: `u${i}` },
      { role: 'assistant', content: `a${i}` },
    ]);
  }
  const result = store.get('g');
  assert.ok(result.length <= 60);
  assert.equal(result[0].role, 'user');
});
