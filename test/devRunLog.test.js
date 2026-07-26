import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatDevRunLine, startDevRunLog } from '../src/devRunLog.js';

function recorder(times = [0, 12_500]) {
  const lines = [];
  let tick = 0;
  return { lines, deps: { write: (line) => lines.push(line), now: () => times[Math.min(tick++, times.length - 1)] } };
}

test('a run logs a start line and a finish line carrying its outcome and duration', () => {
  const { lines, deps } = recorder();
  const finish = startDevRunLog('self_fix', { repo: 'oskip0906/bot', model: 'openai/gpt-5.4-dev', task: 'fix the queue' }, deps);
  finish('merged', { pr: 12, url: 'https://example.test/pr/12' });

  assert.equal(lines.length, 2);
  assert.equal(lines[0], '[panda] self_fix start repo=oskip0906/bot model=openai/gpt-5.4-dev task="fix the queue"');
  assert.match(lines[1], /^\[panda\] self_fix finish outcome=merged seconds=12\.5 /);
  assert.match(lines[1], /repo=oskip0906\/bot/);
  assert.match(lines[1], /pr=12 url=https:\/\/example\.test\/pr\/12/);
});

test('multi-line and empty field values stay on a single log line', () => {
  const line = formatDevRunLine('run_dev', 'finish', { detail: '⚠️ failed\nsee the run', base: '', pr: undefined });
  assert.equal(line, '[panda] run_dev finish detail="⚠️ failed see the run"');
});

test('a finish is reported once even if the caller reports it again', () => {
  const { lines, deps } = recorder();
  const finish = startDevRunLog('run_dev', {}, deps);
  finish('failed', { detail: 'first' });
  finish('crashed', { detail: 'second' });

  assert.equal(lines.length, 2);
  assert.match(lines[1], /outcome=failed/);
});
