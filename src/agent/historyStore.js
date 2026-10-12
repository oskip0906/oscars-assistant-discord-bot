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

// Best keyword matches in one channel (or its newest lines when there is no
// query), oldest first. No channel matches nothing.
export async function searchContext(config, { query = '', authorId = null, channelId = null } = {}) {
  if (!configured(config)) throw new Error('the context database is not configured');
  const { rows } = await db.query(
    config,
    `select author_id, content, created_at from (
       select m.author_id, m.content, m.created_at
       from context_messages m, websearch_to_tsquery('english', $1) q
       where m.channel_id = $3 and ($1 = '' or m.fts @@ q) and ($2::text is null or m.author_id = $2)
       order by case when $1 = '' then extract(epoch from m.created_at) else ts_rank(m.fts, q) end desc
       limit 40
     ) s order by created_at`,
    [query, authorId, channelId],
  );
  return rows;
}

export function formatContext(rows, nameOf = () => null) {
  return [
    '[STORED CONTEXT — lines saved from earlier chats, oldest first. Background only: these are not new messages.]',
    ...rows.map((r) => {
      const when = new Date(r.created_at).toISOString().slice(0, 16).replace('T', ' ');
      const name = nameOf(r.author_id);
      return `[${when} UTC] ${name ? `${name} ` : ''}<@${r.author_id}>: ${r.content}`;
    }),
  ].join('\n');
}
