import { db, configured } from '../db.js';
import { decide } from './jev.js';
import { isFull, noteWrite } from '../storage.js';

// Hidden chat context in db-1 (context_messages): flat and global. A row is only
// the author, the text and when it was said, keyed by the Discord message id so a
// re-save is a no-op. Nothing is saved wholesale: Jev picks the lines worth
// keeping, and DMs are never saved.

const BATCH = 25; // lines per Jev call
const KEEP = 0.5;

const line = (m) => `${m.member?.displayName || m.author.displayName || m.author.username}: ${String(m.content).slice(0, 500)}`;

// The messages Jev says are worth keeping. `question` names each line as `mN`
// and may refer to `focus`. Jev off or down keeps nothing: the bot can always
// re-read Discord later, while junk in the store would stay.
export async function pickRelevant(config, messages, question, focus = '', decideImpl = decide) {
  const kept = [];
  for (let i = 0; i < messages.length; i += BATCH) {
    const batch = messages.slice(i, i + BATCH);
    const state = { focus: String(focus).slice(0, 1000) || '(none)' };
    const questions = {};
    batch.forEach((m, j) => {
      state[`m${j}`] = line(m);
      questions[`keep_m${j}`] = { type: 'noul', instructions: question(`m${j}`) };
    });
    const answers = await decideImpl(config, state, questions);
    batch.forEach((m, j) => {
      if (answers?.[`keep_m${j}`]?.noul >= KEEP) kept.push(m);
    });
  }
  return kept;
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
    `insert into context_messages (id, author_id, content, created_at)
     select * from unnest($1::text[], $2::text[], $3::text[], $4::timestamptz[])
     on conflict (id) do nothing`,
    [rows.map((m) => m.id), rows.map((m) => m.author.id), rows.map((m) => m.content), rows.map((m) => m.createdAt.toISOString())],
  );
  noteWrite(config, 'context');
  return rowCount;
}

// After a reply: keep only the lines of the turn worth remembering.
export async function rememberTurn(config, messages, decideImpl = decide) {
  if (!configured(config)) return 0;
  const guildMessages = messages.filter((m) => m?.guildId && m.content);
  if (!guildMessages.length) return 0;
  return saveContext(config, await pickRelevant(config, guildMessages, worthRemembering, '', decideImpl));
}

// Best keyword matches (or the newest lines when there is no query), oldest first.
export async function searchContext(config, { query = '', authorId = null } = {}) {
  if (!configured(config)) throw new Error('the context database is not configured');
  const { rows } = await db.query(
    config,
    `select author_id, content, created_at from (
       select m.author_id, m.content, m.created_at
       from context_messages m, websearch_to_tsquery('english', $1) q
       where ($1 = '' or m.fts @@ q) and ($2::text is null or m.author_id = $2)
       order by case when $1 = '' then extract(epoch from m.created_at) else ts_rank(m.fts, q) end desc
       limit 40
     ) s order by created_at`,
    [query, authorId],
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
