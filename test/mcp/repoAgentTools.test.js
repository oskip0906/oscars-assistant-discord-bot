import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { failureExcerpt, runRepoAgent } from '../../src/agent/tools/repoAgent.js';

function repo() {
  const root = mkdtempSync(path.join(tmpdir(), 'panda-sandbox-'));
  writeFileSync(path.join(root, 'a.js'), 'export const a = 1;\n');
  return root;
}

// Replays a fixed script of model turns, ignoring the conversation.
const scripted = (turns) => {
  let i = 0;
  return async () => turns[Math.min(i++, turns.length - 1)];
};

const call = (id, name, args) => ({ id, function: { name, arguments: JSON.stringify(args) } });

const EXTRA = [{ type: 'function', function: { name: 'search_code', description: 'Search code', parameters: { type: 'object' } } }];

test('offers the extra MCP tools to the model alongside the file tools', async () => {
  let offered = [];
  await runRepoAgent({
    instruction: 'x',
    root: repo(),
    tracked: ['a.js'],
    extraTools: EXTRA,
    callExtraTool: async () => 'hit',
    log: () => {},
    callModel: async (_messages, tools) => {
      offered = tools.map((t) => t.function.name);
      return { tool_calls: [call('1', 'write_file', { path: 'a.js', content: 'export const a = 2;\n' }), call('2', 'finish', { summary: 's', description: 'd' })] };
    },
  });

  assert.ok(offered.includes('search_code'), 'MCP tools must reach the model');
  assert.ok(offered.includes('write_file'), 'file tools must survive alongside them');
});

test('routes an unknown tool name to the extra dispatcher', async () => {
  const seen = [];
  await runRepoAgent({
    instruction: 'x',
    root: repo(),
    tracked: ['a.js'],
    extraTools: EXTRA,
    callExtraTool: async (name, args) => { seen.push([name, args]); return 'three hits'; },
    log: () => {},
    callModel: scripted([
      { tool_calls: [call('1', 'search_code', { q: 'runAgent' })] },
      { tool_calls: [call('2', 'write_file', { path: 'a.js', content: 'export const a = 2;\n' })] },
      { tool_calls: [call('3', 'finish', { summary: 's', description: 'd' })] },
    ]),
  });

  assert.deepEqual(seen, [['search_code', { q: 'runAgent' }]]);
});

test('an MCP call alone never satisfies finish — only a local file write does', async () => {
  await assert.rejects(
    () =>
      runRepoAgent({
        instruction: 'x',
        root: repo(),
        tracked: ['a.js'],
        extraTools: EXTRA,
        // A write that happened remotely is invisible to verify() and to git add.
        callExtraTool: async () => 'created file on the remote branch',
        log: () => {},
        callModel: scripted([
          { tool_calls: [call('1', 'search_code', { q: 'x' })] },
          { tool_calls: [call('2', 'finish', { summary: 's', description: 'd' })] },
        ]),
      }),
    /never wrote a file|without changing anything/,
    'edits made outside the checkout bypass verification and must not count',
  );
});

test('a finish that fails verification goes back to the model, which can fix it and finish again', async () => {
  let conversation = [];
  let checks = 0;
  const plan = await runRepoAgent({
    instruction: 'x',
    root: repo(),
    tracked: ['a.js'],
    log: () => {},
    check: async () => (++checks === 1 ? 'npm test failed:\nnot ok 3 - names are unique' : null),
    callModel: async (messages) => {
      conversation = messages;
      return { tool_calls: [call(String(messages.length), 'write_file', { path: 'a.js', content: 'export const a = 2;\n' }), call(`f${messages.length}`, 'finish', { summary: 's', description: 'd' })] };
    },
  });

  assert.equal(checks, 2);
  const toolReplies = conversation.filter((m) => m.role === 'tool').map((m) => m.content);
  assert.ok(toolReplies.some((r) => r.startsWith('Verification failed') && r.includes('names are unique')), 'the failure must reach the model');
  assert.equal(plan.completed, true);
});

test('a failed test run reaches the model from its first failure, not a tail of passing tests', () => {
  const passing = Array.from({ length: 500 }, (_, i) => `ok ${i + 3} - fine`);
  const tap = ['ok 1 - a', 'not ok 2 - names are unique', "  error: 'duplicate'", ...passing, '# fail 1'].join('\n');
  const excerpt = failureExcerpt(tap);
  assert.ok(excerpt.startsWith('not ok 2 - names are unique') && excerpt.includes('duplicate'));
  assert.ok(excerpt.length <= 4000);
  assert.equal(failureExcerpt('SyntaxError: Unexpected token'), 'SyntaxError: Unexpected token');
  const spec = [...passing.map((l) => `✔ ${l}`), '✖ names are unique (1ms)', '✖ failing tests:', '', "✖ names are unique (1ms)\n  AssertionError: 'duplicate'"].join('\n');
  assert.ok(failureExcerpt(spec).startsWith('✖ failing tests:') && failureExcerpt(spec).includes('duplicate'));
});
