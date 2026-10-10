import test from 'node:test';
import assert from 'node:assert/strict';
import { formatHistory, indexChannel } from '../src/agent/historyStore.js';
import { fetchHistory, indexChat } from '../src/agent/tools/history.js';

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

// --- index_chat and /index_chat ------------------------------------------------

// Records each Supabase insert, and answers like PostgREST with ignore-duplicates:
// only the rows not already in `stored` come back.
async function withDatabase(stored, fn) {
  const real = globalThis.fetch;
  const inserts = [];
  globalThis.fetch = async (url, init) => {
    const rows = JSON.parse(init.body);
    inserts.push({ url, prefer: init.headers.Prefer, ids: rows.map((r) => r.id) });
    const fresh = rows.filter((r) => !stored.has(r.id));
    fresh.forEach((r) => stored.add(r.id));
    return new Response(JSON.stringify(fresh.map((r) => ({ id: r.id }))));
  };
  try {
    return await fn(inserts);
  } finally {
    globalThis.fetch = real;
  }
}

const ID = (n) => String(1300000000000000000n + BigInt(n)); // snowflake-sized ids
const G = '900000000000000001';
const C1 = '900000000000000011';
const C2 = '900000000000000022';
const msg = (n, channelId = C1) => ({
  id: ID(n),
  channelId,
  content: `m${n}`,
  author: { id: 'u', username: 'someone' },
  createdTimestamp: n * 1000,
  createdAt: new Date(Date.UTC(2026, 0, 1, 12, n)),
});
// A Discord channel holding messages 1..`count`; `around` returns the 5 nearest, newest first.
function channel(id, count, { canRead = true } = {}) {
  const all = Array.from({ length: count }, (_, i) => msg(i + 1, id));
  const fetched = [];
  return {
    id,
    name: id === C1 ? 'general' : 'secret',
    guildId: G,
    fetched,
    permissionsFor: () => ({ has: () => canRead }),
    messages: {
      fetch: async (opts) => {
        fetched.push(opts);
        const page = opts.around
          ? all.filter((m) => Math.abs(Number(BigInt(m.id) - BigInt(opts.around))) <= 2).reverse()
          : all.filter((m) => !opts.before || BigInt(m.id) < BigInt(opts.before)).reverse().slice(0, opts.limit);
        return Object.assign(new Map(page.map((m) => [m.id, m])), { last: () => page.at(-1) });
      },
    },
  };
}
const invocationIn = (here, others = {}) => ({
  config,
  client: { user: { id: 'me' }, channels: { fetch: async (id) => others[id] ?? null } },
  message: { id: ID(999), guildId: G, channelId: here.id, channel: here, member: {}, author: { id: 'u' } },
});

test('index_chat shows the messages around one message, oldest first, and saves only new ones', async () => {
  const general = channel(C1, 20);
  const stored = new Set([ID(9)]);
  const out = await withDatabase(stored, async (inserts) => {
    const text = await indexChat({ message: ID(10) }, invocationIn(general));
    assert.equal(inserts[0].prefer, 'resolution=ignore-duplicates,return=representation');
    assert.match(inserts[0].url, /discord_messages\?select=id$/);
    return text;
  });
  const lines = out.split('\n');
  assert.match(lines[0], new RegExp(`AROUND ${ID(10)} in #general — 5, oldest first; → marks that message; 4 newly saved`));
  assert.deepEqual(lines.slice(1).map((l) => l.match(/: (m\d+)$/)[1]), ['m8', 'm9', 'm10', 'm11', 'm12']);
  assert.match(lines[3], /^→ \[2026-01-01 12:10 UTC\]/);
  assert.equal(general.fetched[0].around, ID(10));
});

test('index_chat follows a message link to another channel of this server', async () => {
  const general = channel(C1, 3);
  const other = channel(C2, 20);
  const link = `https://discord.com/channels/${G}/${C2}/${ID(15)}`;
  const out = await withDatabase(new Set(), () => indexChat({ message: link }, invocationIn(general, { [C2]: other })));
  assert.match(out, /in #secret/);
  assert.equal(other.fetched[0].around, ID(15));
});

test('index_chat refuses other servers, unreadable channels and things that are not messages', async () => {
  const general = channel(C1, 3);
  const hidden = channel(C2, 20, { canRead: false });
  const noDb = async () => assert.fail('nothing should be saved');
  const real = globalThis.fetch;
  globalThis.fetch = noDb;
  try {
    const inv = invocationIn(general, { [C2]: hidden });
    assert.match(await indexChat({ message: `https://discord.com/channels/900000000000000009/${C2}/${ID(15)}` }, inv), /another server/);
    assert.match(await indexChat({ message: `https://discord.com/channels/@me/${C2}/${ID(15)}` }, inv), /another server/);
    assert.match(await indexChat({ message: `https://discord.com/channels/${G}/${C2}/${ID(15)}` }, inv), /can't read/);
    assert.equal(hidden.fetched.length, 0, 'an unreadable channel is never fetched');
    assert.match(await indexChat({ message: 'that one' }, inv), /link or a message id/);
  } finally {
    globalThis.fetch = real;
  }
});

test('index_chat still shows the messages when the database is down', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async () => new Response('down', { status: 503 });
  try {
    const out = await indexChat({ message: ID(2) }, invocationIn(channel(C1, 5)));
    assert.match(out, /not saved: the history database is unavailable/);
    assert.match(out, /→ .*: m2$/m);
  } finally {
    globalThis.fetch = real;
  }
});

test('/index_chat adds only new messages and leaves saved ones as they are', async () => {
  const stored = new Set([ID(1), ID(2), ID(150)]);
  const added = await withDatabase(stored, async (inserts) => {
    const n = await indexChannel(config, channel(C1, 250));
    assert.ok(inserts.every((i) => i.prefer === 'resolution=ignore-duplicates,return=representation'));
    assert.deepEqual(inserts.map((i) => i.ids.length), [100, 100, 50]);
    return n;
  });
  assert.equal(added, 247);
});
