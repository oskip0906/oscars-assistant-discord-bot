import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runClaude, runClaudeFix } from '../src/agent/tools/claudeRunner.js';

// A stand-in for the `claude` binary. It records the argv and stdin it was
// given, then prints whatever the test told it to print. This exercises the
// real subprocess path — argv construction, stdin plumbing, output parsing —
// without going near the actual CLI.
function stubClaude({ output = '', exitCode = 0 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panda-claude-'));
  const bin = path.join(dir, 'claude-stub.sh');
  const argvLog = path.join(dir, 'argv.txt');
  const stdinLog = path.join(dir, 'stdin.txt');
  const outFile = path.join(dir, 'out.txt');
  fs.writeFileSync(outFile, output);
  fs.writeFileSync(
    bin,
    [
      '#!/bin/bash',
      `printf '%s\\n' "$@" > ${JSON.stringify(argvLog)}`,
      `cat > ${JSON.stringify(stdinLog)}`,
      `cat ${JSON.stringify(outFile)}`,
      `exit ${exitCode}`,
    ].join('\n'),
  );
  fs.chmodSync(bin, 0o755);
  return {
    bin,
    cwd: dir,
    argv: () => fs.readFileSync(argvLog, 'utf8').trim().split('\n'),
    stdin: () => fs.readFileSync(stdinLog, 'utf8'),
  };
}

const RESULT_JSON = (result, sessionId) =>
  JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result, session_id: sessionId });

test('the prompt travels on stdin, never in argv', async () => {
  const stub = stubClaude({ output: RESULT_JSON('done', 's1') });
  // Leading '-' would be parsed as a flag, and a huge prompt would blow the OS
  // argv limit — both are why this must go through stdin.
  const prompt = '-not-a-flag ' + 'x'.repeat(300_000);
  await runClaude({ bin: stub.bin, prompt, cwd: stub.cwd });

  assert.equal(stub.stdin(), prompt);
  assert.ok(!stub.argv().some((a) => a.includes('x'.repeat(50))), 'prompt must not appear in argv');
});

test('runs with permissions bypassed and json output', async () => {
  const stub = stubClaude({ output: RESULT_JSON('done', 's1') });
  await runClaude({ bin: stub.bin, prompt: 'hi', cwd: stub.cwd });

  const argv = stub.argv();
  assert.ok(argv.includes('-p'), 'non-interactive print mode');
  assert.ok(argv.includes('--dangerously-skip-permissions'), 'permissions bypassed');
  assert.ok(argv.includes('--output-format'), 'json output requested');
  assert.ok(argv.includes('json'));
});

test('parses the result text and session id out of the json envelope', async () => {
  const stub = stubClaude({ output: RESULT_JSON('I changed foo.js', 'sess-abc') });
  const res = await runClaude({ bin: stub.bin, prompt: 'hi', cwd: stub.cwd });

  assert.equal(res.ok, true);
  assert.equal(res.text, 'I changed foo.js');
  assert.equal(res.sessionId, 'sess-abc');
});

test('falls back to raw output when it is not json', async () => {
  const stub = stubClaude({ output: 'plain text answer' });
  const res = await runClaude({ bin: stub.bin, prompt: 'hi', cwd: stub.cwd });

  assert.equal(res.ok, true);
  assert.equal(res.text, 'plain text answer');
  assert.equal(res.sessionId, null);
});

test('a nonzero exit is reported as not-ok, not thrown', async () => {
  const stub = stubClaude({ output: 'boom', exitCode: 3 });
  const res = await runClaude({ bin: stub.bin, prompt: 'hi', cwd: stub.cwd });

  assert.equal(res.ok, false);
  assert.match(res.text, /boom/);
});

// The real CLI reports logical failures (hit max turns, execution error) in the
// envelope with is_error:true while still exiting 0. Trusting the exit code
// alone would let a failed run be committed and restarted into as a success.
test('is_error in the envelope is a failure even when the process exits 0', async () => {
  const stub = stubClaude({
    output: JSON.stringify({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      result: 'ran out of turns',
      session_id: 'sess-err',
    }),
    exitCode: 0,
  });
  const res = await runClaude({ bin: stub.bin, prompt: 'hi', cwd: stub.cwd });

  assert.equal(res.ok, false, 'must not be treated as a successful run');
  assert.match(res.text, /ran out of turns/);
  assert.equal(res.sessionId, 'sess-err', 'session id is still surfaced');
});

test('a missing binary resolves to not-ok instead of crashing the bot', async () => {
  const res = await runClaude({ bin: '/nonexistent/claude', prompt: 'hi', cwd: os.tmpdir() });
  assert.equal(res.ok, false);
  assert.ok(res.text.length > 0);
});

test('resuming passes --resume with the session id', async () => {
  const stub = stubClaude({ output: RESULT_JSON('ok', 's2') });
  await runClaude({ bin: stub.bin, prompt: 'answer', cwd: stub.cwd, sessionId: 'sess-abc' });

  const argv = stub.argv();
  assert.ok(argv.includes('--resume'));
  assert.equal(argv[argv.indexOf('--resume') + 1], 'sess-abc');
});

// --- the answer loop ----------------------------------------------------

test('a task Claude completes in one round runs Claude exactly once', async () => {
  const runs = [];
  const res = await runClaudeFix({
    bin: 'x',
    cwd: '/tmp',
    instruction: 'do the thing',
    run: async (opts) => {
      runs.push(opts);
      return { ok: true, text: 'all done', sessionId: 's1' };
    },
    judge: async () => ({ status: 'complete' }),
  });

  assert.equal(runs.length, 1);
  assert.equal(res.completed, true);
  assert.match(res.text, /all done/);
});

test("Claude's question is answered by the judge and fed back into the same session", async () => {
  const runs = [];
  let round = 0;
  const res = await runClaudeFix({
    bin: 'x',
    cwd: '/tmp',
    instruction: 'do the thing',
    run: async (opts) => {
      runs.push(opts);
      round++;
      return round === 1
        ? { ok: true, text: 'Which file should I edit?', sessionId: 'sess-1' }
        : { ok: true, text: 'finished', sessionId: 'sess-1' };
    },
    judge: async (text) =>
      /\?/.test(text) ? { status: 'needs_input', answer: 'Edit src/config.js' } : { status: 'complete' },
  });

  assert.equal(runs.length, 2, 'one initial run plus one resumed run');
  assert.equal(runs[1].sessionId, 'sess-1', 'continues the same session');
  assert.equal(runs[1].prompt, 'Edit src/config.js', "the judge's answer is the resume prompt");
  assert.equal(res.completed, true);
});

test('an endlessly-questioning Claude stops at the round cap and is not reported as success', async () => {
  let runCount = 0;
  const res = await runClaudeFix({
    bin: 'x',
    cwd: '/tmp',
    instruction: 'do the thing',
    maxRounds: 3,
    run: async () => {
      runCount++;
      return { ok: true, text: 'but what about X?', sessionId: 'sess-1' };
    },
    judge: async () => ({ status: 'needs_input', answer: 'just proceed' }),
  });

  assert.equal(runCount, 3, 'capped');
  assert.equal(res.completed, false);
});

test('a failed Claude run stops the loop immediately', async () => {
  let runCount = 0;
  const res = await runClaudeFix({
    bin: 'x',
    cwd: '/tmp',
    instruction: 'do the thing',
    run: async () => {
      runCount++;
      return { ok: false, text: 'claude: command not found', sessionId: null };
    },
    judge: async () => {
      throw new Error('judge must not be consulted after a failed run');
    },
  });

  assert.equal(runCount, 1);
  assert.equal(res.completed, false);
  assert.match(res.text, /command not found/);
});

test('a judge that itself blows up does not take the fix down', async () => {
  const res = await runClaudeFix({
    bin: 'x',
    cwd: '/tmp',
    instruction: 'do the thing',
    run: async () => ({ ok: true, text: 'maybe a question?', sessionId: 's1' }),
    judge: async () => {
      throw new Error('openrouter 500');
    },
  });

  assert.equal(res.completed, false);
  assert.equal(typeof res.text, 'string');
});
