import { db, configured } from '../../db.js';

const MAX_ROWS = 50;
const MAX_CELL = 1000;
const MAX_CHARS = 11_000; // under the 12,000 a tool result may hold

export const defs = [
  {
    type: 'function',
    function: {
      name: 'query_db',
      description: `OWNER ONLY. Oscar's SQL access to your own database (db-1): run one read-only Postgres query and get the rows back. Use it to find anything saved — notes and their folders, every channel's saved messages, reminders — when the other lookups don't find it or Oscar refers to something saved. Tables: notes(id, folder_id, title, description, body, author_id, created_at, file_name), note_folders(id, parent_id, name, description, created_at), note_links(from_id, to_id), context_messages(id = Discord message id, guild_id, channel_id, author_id, content, created_at), context_channels(channel_id, newest_id, oldest_id, complete, updated_at), reminders(id, user_id, channel_id, name, next_at, repeat, local_time, timezone, active, last_error, created_at), user_settings(user_id, timezone), prompts(name, content, updated_at), bot_settings(key, value). Full text: fts @@ websearch_to_tsquery('english', 'words') on notes and context_messages. Fuzzy titles: similarity(title, 'x') > 0.2. <#id> and <@id> in a message are channel and user ids. At most ${MAX_ROWS} rows come back.`,
      parameters: {
        type: 'object',
        properties: { sql: { type: 'string', description: 'One SELECT (or WITH … SELECT) statement, no semicolons.' } },
        required: ['sql'],
      },
    },
  },
];

// JSON.stringify already turns a Date into its ISO string. The full-text index
// column is noise, and a long text is cut so a few rows can't fill the result.
const cell = (key, v) => {
  if (key === 'fts') return undefined;
  return typeof v === 'string' && v.length > MAX_CELL ? `${v.slice(0, MAX_CELL)}…(${v.length} chars)` : v;
};

// Never throws: a refusal or a Postgres error is text the model can act on.
export async function queryDb({ sql = '' } = {}, invocation) {
  const { config } = invocation;
  if (!configured(config)) return 'The database is not set up (no DATABASE_URL), so there is nothing to query.';
  const text = String(sql).trim().replace(/;$/, '');
  if (!/^(select|with|values|table)\b/i.test(text)) return 'query_db runs one read-only SELECT (or WITH … SELECT). Nothing ran.';
  try {
    // The newline keeps a trailing `--` comment from swallowing the `)`.
    const { rows } = await db.readOnly(config, `select * from (${text}\n) as q limit ${MAX_ROWS + 1}`);
    if (!rows.length) return '[DB — 0 rows. Nothing matched: say so plainly, and do not guess what it might have held.]';
    const lines = [];
    let used = 0;
    for (const row of rows.slice(0, MAX_ROWS)) {
      const line = JSON.stringify(row, cell);
      if (lines.length && used + line.length > MAX_CHARS) break;
      used += line.length + 1;
      lines.push(line);
    }
    const left = Math.min(rows.length, MAX_ROWS) - lines.length;
    const notes = [
      rows.length > MAX_ROWS ? `more than ${MAX_ROWS} rows matched and only the first ${MAX_ROWS} can come back` : '',
      left ? `${left} of those did not fit, so only the first ${lines.length} are shown` : '',
    ].filter(Boolean);
    return `[DB — ${lines.length} row(s), one JSON object each${notes.length ? `; ${notes.join('; ')}; narrow the query to see the rest` : ''}]\n${lines.join('\n')}`;
  } catch (err) {
    return `The query failed: ${String(err.message || err).slice(0, 300)} — fix the SQL and try again. Nothing was changed.`;
  }
}
