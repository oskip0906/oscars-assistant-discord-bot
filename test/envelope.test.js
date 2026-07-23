import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatEnvelope } from '../src/discord/envelope.js';

function fakeMessage(overrides = {}) {
  return {
    author: { id: '111', username: 'oskip123', displayName: 'oskip123', bot: false },
    member: { displayName: 'Oscar' },
    content: 'hello there',
    mentions: { users: new Map() },
    attachments: new Map(),
    ...overrides,
  };
}

test('basic envelope carries display name, username, and id inline', () => {
  const out = formatEnvelope(fakeMessage());
  assert.equal(out, 'Oscar (@oskip123, id:111): hello there');
});

test('inbound mentions keep their numeric id', () => {
  const msg = fakeMessage({
    content: 'say hi to <@222> please',
    mentions: { users: new Map([['222', { username: 'eggman' }]]) },
  });
  const out = formatEnvelope(msg);
  assert.ok(out.includes('@eggman (id:222)'), out);
});

test('unknown mention ids are left as raw tags', () => {
  const msg = fakeMessage({ content: 'ping <@999>' });
  assert.ok(formatEnvelope(msg).includes('<@999>'));
});

test('bot senders are tagged [BOT]', () => {
  const msg = fakeMessage({ author: { id: '333', username: 'eggbot', bot: true } });
  assert.ok(formatEnvelope(msg).includes('[BOT]'));
});

test('replies quote the referenced message with sender id', () => {
  const refMsg = { author: { id: '444', username: 'chase' }, content: 'original   text here' };
  const out = formatEnvelope(fakeMessage(), refMsg);
  assert.ok(out.includes('replying to @chase (id:444)'), out);
  assert.ok(out.includes('"original text here"'), out);
});

test('attachments are appended with urls', () => {
  const msg = fakeMessage({
    attachments: new Map([['1', { name: 'cat.png', url: 'https://cdn.example/cat.png' }]]),
  });
  const out = formatEnvelope(msg);
  assert.ok(out.includes('[attachment: cat.png https://cdn.example/cat.png]'));
});
