import test from 'node:test';
import assert from 'node:assert/strict';
import { selfFix } from '../src/agent/tools/source.js';

test('self_fix asks Oscar to approve its own detailed prompt, and runs that prompt', async (t) => {
  const brief = 'Goal: make reminders repeat weekly.\nCheck: add a test for a weekly reminder.';
  t.mock.method(globalThis, 'fetch', async (url) => {
    // The prompt request, then the commit-title request.
    const content = /Claude Code/.test(globalThis.fetch.mock.calls.at(-1).arguments[1].body)
      ? brief
      : JSON.stringify({ title: 'Self-fix: weekly reminders', description: 'x' });
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
  });
  let approved = null;
  let ran = null;
  await selfFix({ instruction: 'weekly reminders pls' }, { message: null, client: null }, {
    confirm: async ({ instruction }) => ((approved = instruction), 'confirm'),
    runSandbox: async ({ instruction }) => ((ran = instruction), { ok: false, summary: 'stopped' }),
    notify: async () => {},
    startLog: () => () => {},
    state: { begin() {}, end() {} },
  });
  assert.equal(approved, brief, 'the card shows the generated prompt, not the raw request');
  assert.equal(ran, brief, 'Claude Code runs exactly what was approved');
});
