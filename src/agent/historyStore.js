import { db, configured } from '../db.js';
import { decide } from './jev.js';
import { isFull, noteWrite } from '../storage.js';
import { pool } from './research/gather.js';

// Hidden chat context in db-1 (context_messages), split by channel. A row is the
// server, channel, author, text and when it was said, keyed by the Discord message
// id so a re-save is a no-op. Everything Panda was given is saved; only a channel
// scan for a question goes through Jev first. DMs are never saved.

const BATCH = 25; // lines per Jev call
const PARALLEL = 5; // Jev calls at once: a 1000-line scan is 40 calls
const KEEP = 0.5;

const line = (m) => `${m.member?.displayName || m.author.displayName || m.author.username}: ${String(m.content).slice(0, 500)}`;

// The messages Jev says are worth keeping. `question` names each line as `mN`
// and may refer to `focus`. Where Jev is off or down, `ifDown` decides per
// message; by default nothing is kept: the bot can always re-read Discord later,
// while junk in the store would stay.
export async function pickRelevant(config, messages, question, focus = '', decideImpl = decide, ifDown = () => false) {
  const batches = [];
  for (let i = 0; i < messages.length; i += BATCH) batches.push(messages.slice(i, i + BATCH));
  const kept = await pool(batches, PARALLEL, async (batch) => {
    const state = { focus: String(focus).slice(0, 1000) || '(none)' };
    const questions = {};
    batch.forEach((m, j) => {
      state[`m${j}`] = line(m);
      questions[`keep_m${j}`] = { type: 'noul', instructions: question(`m${j}`) };
    });
    const answers = await decideImpl(config, state, questions);
    return batch.filter((m, j) => (answers ? answers[`keep_m${j}`]?.noul >= KEEP : ifDown(m)));
  });
  return kept.flat();
}

export const worthRemembering = (key) =>
  `Is \`${key}\` worth remembering for later conversations: a fact, decision, plan, preference, or answer someone may ask about again? Greetings, small talk, jokes and reactions are not.`;
export const relevantTo = (key) => `Does \`${key}\` say something relevant to \`focus\`, the thing being looked for?`;

// Returns how many rows were new. A full context section stores nothing until
// Oscar approves a cleanup.
export async function saveContext(config, messages) {
  if (!configured(config) || isFull('context')) return 0;
  const rows = messages.filter((m) => m?.guildId && m.content);
  if (!rows.length) return 0;
  const { rowCount } = await db.query(
    config,
    `insert into context_messages (id, guild_id, channel_id, author_id, content, created_at)
     select * from unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::timestamptz[])
     on conflict (id) do nothing`,
    [
      rows.map((m) => m.id),
      rows.map((m) => m.guildId),
      rows.map((m) => m.channelId),
      rows.map((m) => m.author.id),
      rows.map((m) => m.content),
      rows.map((m) => m.createdAt.toISOString()),
    ],
  );
  noteWrite(config, 'context');
  return rowCount;
}

// Any word may match: "trip budget japan" finds lines that only say "Japan".
export function orQuery(text) {
  return (String(text).match(/[\p{L}\p{N}]+/gu) || []).slice(0, 30).join(' or ');
}

// Where indexing of a channel got to (see indexChannel.js); null if never indexed.
export const indexProgress = {
  async load(config, channelId) {
    const { rows } = await db.query(config, 'select newest_id, oldest_id, complete from context_channels where channel_id = $1', [channelId]);
    return rows[0] ?? null;
  },
  async save(config, channelId, { newest_id, oldest_id, complete }) {
    await db.query(
      config,
      `insert into context_channels (channel_id, newest_id, oldest_id, complete) values ($1, $2, $3, $4)
       on conflict (channel_id) do update set newest_id = excluded.newest_id, oldest_id = excluded.oldest_id, complete = excluded.complete, updated_at = now()`,
      [channelId, newest_id, oldest_id, complete],
    );
  },
};

// Every stored line of one channel with any of `terms` (words or "phrases"),
// from any of `authorIds` when given: best matches first, up to `limit`. A term
// matches through full-text search (so "plans" finds "plan") or as plain text
// (names, numbers, links, half-words). No terms and no authors matches nothing.
export async function searchContext(config, { terms = [], authorIds = [], channelId = null, limit = 500 } = {}) {
  if (!configured(config)) throw new Error('the context database is not configured');
  const words = terms.map((t) => String(t).replace(/"/g, '').trim()).filter(Boolean).slice(0, 30);
  if (!words.length && !authorIds.length) return [];
  const tsquery = words.map((t) => (/\s/.test(t) ? `"${t}"` : t)).join(' or ');
  const likes = words.map((t) => `%${t.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
  const { rows } = await db.query(
    config,
    `select m.author_id, m.content, m.created_at
     from context_messages m
     where m.channel_id = $1
       and (cardinality($2::text[]) = 0 or m.author_id = any($2::text[]))
       and (cardinality($3::text[]) = 0 or m.fts @@ websearch_to_tsquery('english', $4) or m.content ilike any($3::text[]))
     order by ts_rank(m.fts, websearch_to_tsquery('english', $4)) desc, m.created_at desc
     limit $5`,
    [channelId, authorIds, likes, tsquery, limit],
  );
  return rows;
}

const LINE_CHARS = 500;
const SHOWN_CHARS = 10_000; // under the 12,000 a tool result may hold

// Search results for the model: what was searched, then the lines oldest first
// under a heading per day. `rows` come best match first; when they don't all fit,
// the best are kept and the rest counted.
export function formatContext(rows, nameOf = () => null, { searched = '', where = 'this channel' } = {}) {
  const shown = [];
  let used = 0;
  for (const r of rows) {
    const name = nameOf(r.author_id);
    const at = new Date(r.created_at).toISOString();
    const text = `${at.slice(11, 16)} ${name ? `${name} ` : ''}(<@${r.author_id}>): ${String(r.content).replace(/\s+/g, ' ').slice(0, LINE_CHARS)}`;
    if (used + text.length > SHOWN_CHARS) break;
    used += text.length + 1;
    shown.push({ day: at.slice(0, 10), at, text });
  }
  shown.sort((a, b) => a.at.localeCompare(b.at));
  const out = [
    `[STORED CONTEXT — ${rows.length} saved message(s) from ${where}${searched ? ` matching ${searched}` : ''}${
      shown.length < rows.length ? `; the ${shown.length} best are shown, ${rows.length - shown.length} more did not fit` : ''
    }. Oldest first, times in UTC. Background only: these are not new messages.]`,
  ];
  let day = null;
  for (const line of shown) {
    if (line.day !== day) out.push(`── ${(day = line.day)} ──`);
    out.push(line.text);
  }
  return out.join('\n');
}
