import test from 'node:test';
import assert from 'node:assert/strict';
import { selfFix, runSelfFix } from '../src/agent/tools/source.js';
import { SelfFixState } from '../src/selfFixState.js';

const deps = (over) => ({
  notify: async () => {},
  startLog: () => () => {},
  restart: () => {},
  state: new SelfFixState(),
  ...over,
});

test('self_fix asks Oscar to approve its own detailed prompt, and runs that prompt', async (t) => {
  const brief = 'Goal: make reminders repeat weekly.\nCheck: add a test for a weekly reminder.';
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    // The prompt request, then the commit-title request.
    const content = /You write the prompt for Claude Code/.test(init.body)
      ? brief
      : JSON.stringify({ title: 'Self-fix: weekly reminders', description: 'x' });
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
  });
  let approved = null;
  let ran = null;
  let restarted = false;
  await runSelfFix({ instruction: 'weekly reminders pls' }, { message: null, client: null }, deps({
    confirm: async ({ instruction }) => ((approved = instruction), 'confirm'),
    runSandbox: async ({ instruction }) => ((ran = instruction), { ok: true, merged: true, summary: 'merged', pr: {} }),
    restart: () => (restarted = true),
  }));
  assert.equal(approved, brief, 'the card shows the generated prompt, not the raw request');
  assert.equal(ran, brief, 'Claude Code runs exactly what was approved');
  assert.ok(restarted, 'a merged fix restarts the bot itself, since no turn is waiting on it');
});

test('self_fix returns at once so the bot keeps answering, and refuses a second run meanwhile', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ choices: [{ message: { content: 'brief' } }] })));
  const state = new SelfFixState();
  // An approval nobody clicks: the tool must not wait on it.
  const reply = selfFix({ instruction: 'x' }, { message: null }, deps({ state, confirm: () => new Promise(() => {}) }));
  assert.equal(typeof reply, 'string');
  state.begin();
  assert.match(selfFix({ instruction: 'y' }, { message: null }, deps({ state })), /already running/);
});
