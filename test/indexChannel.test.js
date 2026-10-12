import test from 'node:test';
import assert from 'node:assert/strict';
import { createInteractionHandler, commandDefs } from '../src/discord/commands.js';
import { indexChannel, INDEX_OWNER_ID } from '../src/discord/indexChannel.js';
import { db } from '../src/db.js';
import { resetStorageState } from '../src/storage.js';

const config = { databaseUrl: 'postgres://test', ownerId: INDEX_OWNER_ID };

function store() {
  const stored = new Set();
  const progress = new Map();
  db.query = async (_c, text, params) => {
    if (text.includes('as used')) return { rows: [{ used: 0 }] };
    if (text.includes('from context_channels')) return { rows: progress.has(params[0]) ? [progress.get(params[0])] : [] };
    if (text.includes('insert into context_channels')) {
      progress.set(params[0], { newest_id: params[1], oldest_id: params[2], complete: params[3] });
      return { rows: [] };
    }
    if (text.includes('insert into context_messages')) {
      const fresh = params[0].filter((id) => !stored.has(id));
      fresh.forEach((id) => stored.add(id));
      return { rowCount: fresh.length, rows: [] };
    }
    throw new Error(`unexpected query: ${text}`);
  };
  return stored;
}

// A channel with `n` messages, ids 1..n, served newest first like Discord.
function channel(n, { limitOnce = false } = {}) {
  const calls = [];
  let limited = !limitOnce;
  const all = Array.from({ length: n }, (_, i) => ({
    id: String(n - i), guildId: 'g', channelId: 'c', content: `m${n - i}`, author: { id: 'a' }, createdAt: new Date(),
  }));
  return {
    id: 'c',
    name: 'general',
    calls,
    messages: {
      fetch: async ({ limit, before }) => {
        calls.push({ limit, before });
        if (!limited) {
          limited = true;
          throw Object.assign(new Error('rate limited'), { status: 429, retryAfter: 2 });
        }
        const rest = before ? all.filter((m) => BigInt(m.id) < BigInt(before)) : all;
        return new Map(rest.slice(0, limit).map((m) => [m.id, m]));
      },
    },
  };
}

test('paginates past 100 messages, honours retry-after, and a second run skips everything', async () => {
  resetStorageState();
  store();
  const ch = channel(250, { limitOnce: true });
  const waits = [];
  const sleep = async (ms) => waits.push(ms);
  const first = await indexChannel(config, ch, { sleep });
  assert.deepEqual([first.indexed, first.skipped, first.fetched], [250, 0, 250]);
  assert.deepEqual(waits, [2000]);
  assert.ok(ch.calls.filter((c) => c.before).length >= 2);
  assert.equal(first.complete, true);
  const again = channel(250);
  const second = await indexChannel(config, again, { sleep });
  assert.deepEqual([second.indexed, second.fetched], [0, 100], 'a second run reads one page and stops at what it already has');
  assert.equal(again.calls.length, 1);
});

test('a run cut short carries on from where it stopped, and picks up new messages', async () => {
  resetStorageState();
  store();
  const first = await indexChannel(config, channel(500), { max: 300 });
  assert.deepEqual([first.indexed, first.capped, first.complete], [300, true, false]);
  // 50 new messages since, and 200 old ones still to go.
  const later = channel(550);
  const second = await indexChannel(config, later);
  assert.deepEqual([second.indexed, second.complete, second.capped], [250, true, false]);
  assert.equal(later.calls[0].before, undefined, 'new messages first');
  assert.ok(later.calls.some((c) => c.before === '201'), 'then on back from the oldest one saved');
});

test('stops at the safety cap', async () => {
  resetStorageState();
  store();
  const done = await indexChannel(config, channel(500), { max: 300 });
  assert.equal(done.fetched, 300);
  assert.ok(done.capped);
});

function slash(userId, channelObj) {
  const calls = [];
  return {
    calls,
    commandName: 'index_channel',
    user: { id: userId },
    channel: channelObj,
    createdTimestamp: Date.now(),
    isButton: () => false,
    isStringSelectMenu: () => false,
    isAutocomplete: () => false,
    isChatInputCommand: () => true,
    reply: async (p) => calls.push(['reply', p]),
    editReply: async (p) => calls.push(['editReply', p]),
  };
}

test('/index_channel is registered and owner-only', async () => {
  assert.ok(commandDefs.some((c) => c.name === 'index_channel'));
  resetStorageState();
  store();
  const handler = createInteractionHandler({ client: {}, config, privateMode: { isOn: () => false } });
  const intruder = slash('999', channel(5));
  await handler(intruder);
  assert.equal(intruder.calls.length, 1);
  assert.match(intruder.calls[0][1].content, /Only Oscar/);
  assert.ok(intruder.calls[0][1].flags);

  const owner = slash(INDEX_OWNER_ID, channel(5));
  await handler(owner);
  assert.equal(owner.calls[0][0], 'reply');
  assert.ok(owner.calls[0][1].flags);
  assert.match(owner.calls.at(-1)[1], /Indexed \*\*5\*\* messages from #general; \*\*0\*\*/);
});
