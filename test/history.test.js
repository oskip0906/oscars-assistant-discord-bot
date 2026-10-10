import test from 'node:test';
import assert from 'node:assert/strict';
import { formatHistory } from '../src/agent/historyStore.js';
import { fetchHistory } from '../src/agent/tools/history.js';

const config = { supabaseUrl: 'https://x.supabase.co', supabaseKey: 'sb_secret_test' };
const row = (conversation, author_name, content, minute) => ({
  channel_id: 'c1',
  channel_name: 'general',
  conversation,
  author_name,
  is_bot: author_name === 'Panda',
  content,
  created_at: `2026-10-01T14:${String(minute).padStart(2, '0')}:00+00:00`,
});

// Swap global fetch for one test, recording request bodies.
async function withFetch(impl, fn) {
  const real = globalThis.fetch;
  const bodies = [];
  globalThis.fetch = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    return impl(url, init);
  };
  try {
    return await fn(bodies);
  } finally {
    globalThis.fetch = real;
  }
}

test('formats one block per conversation, in order', () => {
  const text = formatHistory([row(1, 'Alex', 'trip budget?', 1), row(1, 'Panda', '$400 each', 2), row(2, 'Sam', 'movie friday', 50)]);
  const blocks = text.split('--- conversation in #general ---');
  assert.equal(blocks.length, 3);
  assert.match(blocks[1], /\[2026-10-01 14:01 UTC\] Alex: trip budget\?\n\[2026-10-01 14:02 UTC\] Panda \(bot\): \$400 each/);
  assert.match(blocks[2], /Sam: movie friday/);
});

test('server scope in a DM stays on that DM channel', async () => {
  await withFetch(
    async () => new Response(JSON.stringify([row(1, 'Alex', 'hi', 1)])),
    async (bodies) => {
      const out = await fetchHistory({ query: 'hi', scope: 'server' }, { config, message: { guildId: null, channelId: 'dm1' } });
      assert.match(out, /Alex: hi/);
      assert.deepEqual(bodies[0], { p_guild_id: null, p_channel_id: 'dm1', p_query: 'hi', p_author: null });
    },
  );
});

test('server scope in a guild searches every channel', async () => {
  await withFetch(
    async () => new Response('[]'),
    async (bodies) => {
      const out = await fetchHistory({ scope: 'server' }, { config, message: { guildId: 'g1', channelId: 'c1' } });
      assert.match(out, /No earlier conversations matched/);
      assert.deepEqual(bodies[0], { p_guild_id: 'g1', p_channel_id: null, p_query: null, p_author: null });
    },
  );
});

test('author is sent separately from the text query', async () => {
  await withFetch(
    async () => new Response('[]'),
    async (bodies) => {
      await fetchHistory({ query: 'trip', author: 'DerpZ' }, { config, message: { guildId: 'g1', channelId: 'c1' } });
      assert.deepEqual(bodies[0], { p_guild_id: 'g1', p_channel_id: 'c1', p_query: 'trip', p_author: 'DerpZ' });
    },
  );
});

test('a failed lookup tells the model to carry on instead of throwing', async () => {
  await withFetch(
    async () => new Response('boom', { status: 500 }),
    async () => {
      const out = await fetchHistory({ query: 'x' }, { config, message: { guildId: 'g1', channelId: 'c1' } });
      assert.match(out, /unavailable right now — answer without it/);
    },
  );
  const unconfigured = await fetchHistory({ query: 'x' }, { config: {}, message: { guildId: 'g1', channelId: 'c1' } });
  assert.match(unconfigured, /unavailable/);
});

test('no query reads a range of the channel from Discord, oldest first, own replies marked', async () => {
  // 250 messages, newest first like Discord; ids count down from 250.
  const all = Array.from({ length: 250 }, (_, i) => {
    const n = 250 - i;
    return { id: String(n), content: `m${n}`, author: { id: n % 2 ? 'me' : 'u', username: 'x' } };
  });
  const channel = {
    messages: {
      fetch: async ({ limit, before }) => {
        const page = all.filter((m) => Number(m.id) < Number(before)).slice(0, limit);
        return Object.assign(new Map(page.map((m) => [m.id, m])), { last: () => page.at(-1) });
      },
    },
  };
  const message = { id: '251', guildId: 'g1', channelId: 'c1', channel };
  const out = await fetchHistory({ skip: 95, count: 10 }, { config: {}, message, client: { user: { id: 'me' } } });
  const lines = out.split('\n').slice(1);
  assert.equal(lines.length, 10);
  assert.match(lines[0], /: m146$/);
  assert.match(lines[9], /^\(you\) .*: m155$/);
});
