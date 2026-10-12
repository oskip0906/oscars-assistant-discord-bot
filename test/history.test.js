import test from 'node:test';
import assert from 'node:assert/strict';
import { formatContext, saveContext } from '../src/agent/historyStore.js';
import { fetchHistory, indexChat } from '../src/agent/tools/history.js';
import { db } from '../src/db.js';
import { check, isFull, resetStorageState } from '../src/storage.js';

const config = { databaseUrl: 'postgres://test', openrouterApiKey: 'k', jevEnabled: true };

// A fake context_messages table. Inserts keep only ids not stored yet (ON
// CONFLICT DO NOTHING) and record each new row's [server, channel]; searches
// answer `found` when given, else stored lines of that channel with any query
// word, and record their parameters. context_channels keeps indexing progress.
function database({ stored = new Set(), found = null, down = false, used = 0 } = {}) {
  const log = { inserted: [], where: [], searches: [], rows: [], progress: new Map() };
  db.query = async (_config, text, params) => {
    if (down) throw new Error('connect ECONNREFUSED');
    if (text.includes('as used')) return { rows: [{ used }] };
    if (text.includes('insert into context_messages')) {
      const fresh = params[0].map((id, i) => i).filter((i) => !stored.has(params[0][i]));
      fresh.forEach((i) => {
        stored.add(params[0][i]);
        log.inserted.push(params[0][i]);
        log.where.push([params[1][i], params[2][i]]);
        log.rows.push({ channel_id: params[2][i], author_id: params[3][i], content: params[4][i], created_at: params[5][i] });
      });
      return { rowCount: fresh.length, rows: [] };
    }
    if (text.includes('from context_channels')) return { rows: log.progress.has(params[0]) ? [log.progress.get(params[0])] : [] };
    if (text.includes('insert into context_channels')) {
      log.progress.set(params[0], { newest_id: params[1], oldest_id: params[2], complete: params[3] });
      return { rows: [] };
    }
    if (text.includes('from context_messages')) {
      log.searches.push(params);
      if (found) return { rows: found };
      const [query, authorId, channelId] = params;
      const words = query.toLowerCase().split(/\W+/).filter(Boolean);
      return {
        rows: log.rows.filter((r) => r.channel_id === channelId && (!authorId || r.author_id === authorId) && (!words.length || words.some((w) => r.content.toLowerCase().includes(w)))),
      };
    }
    throw new Error(`unexpected query: ${text}`);
  };
  return log;
}

// A fake Jev: keeps a line when `keep(text)` says so; `down` answers like an outage.
async function withJev(keep, fn, { down = false } = {}) {
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.match(url, /decisions/);
    if (down) return new Response('boom', { status: 503 });
    const { state, questions } = JSON.parse(init.body);
    const answers = Object.fromEntries(Object.keys(questions).map((q) => [q, { noul: keep(state[q.slice(5)], state.focus) ? 0.9 : 0.1 }]));
    return new Response(JSON.stringify({ answers }));
  };
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

const ID = (n) => String(1300000000000000000n + BigInt(n)); // snowflake-sized ids
const G = '900000000000000001';
const C1 = '900000000000000011';
const C2 = '900000000000000022';
const msg = (n, { channelId = C1, guildId = G, content = `m${n}` } = {}) => ({
  id: ID(n),
  guildId,
  channelId,
  content,
  author: { id: `u${n % 3}`, username: `user${n % 3}` },
  createdTimestamp: n * 1000,
  createdAt: new Date(Date.UTC(2026, 0, 1, 12, n)),
});

test('formats stored lines oldest first, with names when known', () => {
  const text = formatContext(
    [
      { author_id: '1', content: 'trip budget?', created_at: '2026-10-01T14:01:00Z' },
      { author_id: '2', content: '$400 each', created_at: new Date('2026-10-01T14:02:00Z') },
    ],
    (id) => (id === '1' ? 'Alex' : null),
  );
  const lines = text.split('\n');
  assert.match(lines[0], /^\[STORED CONTEXT/);
  assert.equal(lines[1], '[2026-10-01 14:01 UTC] Alex <@1>: trip budget?');
  assert.equal(lines[2], '[2026-10-01 14:02 UTC] <@2>: $400 each');
});

test('a turn is saved whole, each line with its server and channel, never DMs', async () => {
  const turn = [msg(1, { content: 'we leave friday at 9' }), msg(2, { content: 'lol', channelId: C2 }), msg(3, { content: 'my birthday is may 3', guildId: null })];
  const log = database();
  assert.equal(await saveContext(config, turn), 2);
  assert.deepEqual(log.inserted, [ID(1), ID(2)]);
  assert.deepEqual(log.where, [[G, C1], [G, C2]]);
});

test('a full context section stores nothing until a cleanup', async () => {
  resetStorageState();
  try {
    database({ used: 10 * 1024 ** 3 });
    await check(config, 'context');
    assert.ok(isFull('context'));
    assert.equal(await saveContext(config, [msg(1)]), 0);
  } finally {
    resetStorageState();
  }
});

test('search goes to the store first, with the author resolved to an id', async () => {
  const log = database({ found: [{ author_id: '42', content: 'flights are $900', created_at: '2026-10-01T14:01:00Z' }] });
  const out = await fetchHistory({ query: 'flights', author: '<@42>' }, { config, message: { guildId: G, channelId: C1 } });
  assert.deepEqual(log.searches[0].slice(0, 3), ['flights', '42', C1], 'only this channel is searched');
  assert.match(out, /<@42>: flights are \$900/);
});

// A Discord channel holding messages 1..`count`; `around` returns the 5 nearest, newest first.
function channel(id, count, { canRead = true, content } = {}) {
  const all = Array.from({ length: count }, (_, i) => msg(i + 1, { channelId: id, content: content?.(i + 1) }));
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
const invocationIn = (here, others = {}, content = 'what was the plan') => ({
  config,
  client: { user: { id: 'me' }, channels: { fetch: async (id) => others[id] ?? null } },
  message: { id: ID(999), guildId: G, channelId: here.id, channel: here, member: {}, author: { id: 'u' }, content },
});

test('nothing remembered: the whole channel is saved, then searched again, and only lines Jev keeps are shown', async () => {
  const general = channel(C1, 250, { content: (n) => (n === 7 ? 'the plan is the lake house' : n === 9 ? 'no plan yet lol' : `chat ${n}`) });
  const log = database();
  const out = await withJev(
    (line, focus) => focus === 'plan' && /lake/.test(line),
    () => fetchHistory({ query: 'plan' }, invocationIn(general)),
  );
  assert.equal(log.inserted.length, 250, 'every message in the channel is saved');
  assert.equal(log.searches.length, 2, 'searched, indexed, searched again');
  assert.match(out, /<@u1>: the plan is the lake house/);
  assert.ok(!/no plan yet/.test(out), 'a keyword hit Jev says does not answer it stays out');
  assert.deepEqual(log.progress.get(C1), { newest_id: ID(250), oldest_id: ID(1), complete: true });

  // The next miss only reads what is new since.
  general.fetched.length = 0;
  await withJev(() => false, () => fetchHistory({ query: 'boat' }, invocationIn(general)));
  assert.equal(general.fetched.length, 1);
});

test('a failed lookup tells the model to carry on instead of throwing', async () => {
  database({ down: true });
  const out = await fetchHistory({ query: 'x' }, { config, message: { guildId: G, channelId: C1 } });
  assert.match(out, /unavailable right now — answer without it/);
});

test('no query reads a range of the channel from Discord, oldest first, own replies marked', async () => {
  // 250 messages, newest first like Discord; ids count down from 250.
  const all = Array.from({ length: 250 }, (_, i) => {
    const n = 250 - i;
    return { id: String(n), content: `m${n}`, author: { id: n % 2 ? 'me' : 'u', username: 'x' } };
  });
  const ch = {
    messages: {
      fetch: async ({ limit, before }) => {
        const page = all.filter((m) => Number(m.id) < Number(before)).slice(0, limit);
        return Object.assign(new Map(page.map((m) => [m.id, m])), { last: () => page.at(-1) });
      },
    },
  };
  const message = { id: '251', guildId: 'g1', channelId: 'c1', channel: ch };
  const out = await fetchHistory({ skip: 95, count: 10 }, { config: {}, message, client: { user: { id: 'me' } } });
  const lines = out.split('\n').slice(1);
  assert.equal(lines.length, 10);
  assert.match(lines[0], /: m146$/);
  assert.match(lines[9], /^\(you\) .*: m155$/);
});

// --- index_chat ------------------------------------------------------------------

test('index_chat shows and remembers every message around one message, once', async () => {
  const general = channel(C1, 20);
  const log = database({ stored: new Set([ID(9)]) });
  const out = await indexChat({ message: ID(10) }, invocationIn(general));
  assert.deepEqual(log.inserted, [ID(8), ID(10), ID(11), ID(12)]);
  const lines = out.split('\n');
  assert.match(lines[0], new RegExp(`AROUND ${ID(10)} in #general — 5, oldest first; → marks that message; 4 newly remembered`));
  assert.deepEqual(lines.slice(1).map((l) => l.match(/: (m\d+)$/)[1]), ['m8', 'm9', 'm10', 'm11', 'm12']);
  assert.match(lines[3], /^→ \[2026-01-01 12:10 UTC\]/);
  assert.deepEqual(general.fetched[0], { around: ID(10), limit: 100 }, 'about 50 before and 50 after');
});

test('index_chat follows a message link to another channel of this server', async () => {
  const general = channel(C1, 3);
  const other = channel(C2, 20);
  database();
  const link = `https://discord.com/channels/${G}/${C2}/${ID(15)}`;
  const out = await indexChat({ message: link }, invocationIn(general, { [C2]: other }));
  assert.match(out, /in #secret/);
  assert.equal(other.fetched[0].around, ID(15));
});

test('index_chat refuses other servers, unreadable channels and things that are not messages', async () => {
  const general = channel(C1, 3);
  const hidden = channel(C2, 20, { canRead: false });
  db.query = async () => assert.fail('nothing should be saved');
  const inv = invocationIn(general, { [C2]: hidden });
  assert.match(await indexChat({ message: `https://discord.com/channels/900000000000000009/${C2}/${ID(15)}` }, inv), /another server/);
  assert.match(await indexChat({ message: `https://discord.com/channels/@me/${C2}/${ID(15)}` }, inv), /another server/);
  assert.match(await indexChat({ message: `https://discord.com/channels/${G}/${C2}/${ID(15)}` }, inv), /can't read/);
  assert.equal(hidden.fetched.length, 0, 'an unreadable channel is never fetched');
  assert.match(await indexChat({ message: 'that one' }, inv), /link or a message id/);
});

test('index_chat still shows the messages when the database is down', async () => {
  database({ down: true });
  const out = await indexChat({ message: ID(2) }, invocationIn(channel(C1, 5)));
  assert.match(out, /not remembered: the context database is unavailable/);
  assert.match(out, /→ .*: m2$/m);
});
