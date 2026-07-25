import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SelfFixState, SELF_FIX_MESSAGE } from '../src/selfFixState.js';

// A controllable clock so the force-release timeout is deterministic.
function fakeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

test('starts inactive', () => {
  const s = new SelfFixState();
  assert.equal(s.isActive(), false);
});

test('begin() activates and end() deactivates', () => {
  const s = new SelfFixState();
  s.begin();
  assert.equal(s.isActive(), true);
  s.end();
  assert.equal(s.isActive(), false);
});

test('a user is notified only once per session', () => {
  const s = new SelfFixState();
  s.begin();
  assert.equal(s.shouldNotify('A'), true, 'first trigger notifies');
  assert.equal(s.shouldNotify('A'), false, 'follow-up stays silent');
  assert.equal(s.shouldNotify('A'), false);
});

test('each user gets their own single notification', () => {
  const s = new SelfFixState();
  s.begin();
  assert.equal(s.shouldNotify('A'), true);
  assert.equal(s.shouldNotify('B'), true);
  assert.equal(s.shouldNotify('A'), false);
  assert.equal(s.shouldNotify('B'), false);
});

test('a new session notifies the same user again', () => {
  const s = new SelfFixState();
  s.begin();
  s.shouldNotify('A');
  s.end();
  s.begin();
  assert.equal(s.shouldNotify('A'), true, 'notified set resets per session');
});

test('force-releases once the timeout elapses so the bot can never go permanently deaf', () => {
  const clock = fakeClock();
  const s = new SelfFixState({ timeoutMs: 60_000, now: clock.now });
  s.begin();
  assert.equal(s.isActive(), true);
  clock.advance(59_999);
  assert.equal(s.isActive(), true, 'still locked just before the cap');
  clock.advance(2);
  assert.equal(s.isActive(), false, 'auto-released past the cap');
});

test('the busy reply is a hardcoded string, never model-composed', () => {
  assert.equal(typeof SELF_FIX_MESSAGE, 'string');
  assert.match(SELF_FIX_MESSAGE, /rebuild/i);
});
