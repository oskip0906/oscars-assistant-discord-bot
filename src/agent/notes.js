import { db, configured } from '../db.js';
import { decide } from './jev.js';
import { askJson } from './research/askJson.js';
import { isFull, noteWrite, pruneEmptyFolders } from '../storage.js';
import { pickRelevant, relevantTo, worthRemembering, orQuery } from './historyStore.js';

export { orQuery };
import { readChannelRange } from './tools/history.js';

// Shared notes in db-1: a folder tree the model files each note into, like a
// knowledge graph, plus links between related notes. Everyone sees every note.

const MAX_DEPTH = 6;
const MAX_OPENED = 8; // folders the Jev walk may enter per search
const MAX_KIDS = 20; // shortcut: Jev picks among at most 20 sibling folders; split the choice if a folder grows wider
const DESCEND = 0.25;
const MAX_TRANSCRIPT = 60_000; // characters the note writer is given
const WINDOW = 10; // minutes a note covers by default
const MAX_WINDOW_MESSAGES = 1000; // shortcut: a long, busy window is cut to its newest 1000 messages; page further if notes need more
const COLUMNS = 'n.id, n.folder_id, n.title, n.description, n.body, n.author_id, n.created_at, n.file_name';
// The most text a written note or file keeps; past it the full-text index would be too big.
export const MAX_BODY = 200_000;

export async function loadTree(config) {
  const [folders, notes] = await Promise.all([
    db.query(config, 'select id, parent_id, name, description from note_folders order by lower(name)'),
    db.query(config, 'select id, folder_id, title, description from notes order by lower(title)'),
  ]);
  return { folders: folders.rows.map(norm), notes: notes.rows.map(norm) };
}

// bigint ids come back from pg as strings; compare them as numbers everywhere.
function norm(row) {
  const out = { ...row };
  for (const key of ['id', 'parent_id', 'folder_id']) if (out[key] != null) out[key] = Number(out[key]);
  return out;
}

export function folderPath(folders, id) {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const path = [];
  for (let f = byId.get(id); f && path.length < 50; f = byId.get(f.parent_id)) path.unshift(f.name);
  return path;
}

// The tree as indented text, for the model that files notes.
export function treeOutline(folders) {
  const kids = childrenOf(folders);
  const lines = [];
  const walk = (parent, depth) => {
    for (const f of kids.get(parent) || []) {
      lines.push(`${'  '.repeat(depth)}- ${f.name}: ${f.description}`);
      walk(f.id, depth + 1);
    }
  };
  walk(null, 0);
  return lines.join('\n') || '(empty: no folders yet)';
}

export function childrenOf(folders) {
  const kids = new Map();
  for (const f of folders) {
    const key = f.parent_id ?? null;
    if (!kids.has(key)) kids.set(key, []);
    kids.get(key).push(f);
  }
  return kids;
}

const WRITE = `You turn a Discord conversation into a note. Reply with ONLY JSON: {"title": "...", "description": "...", "body": "..."}.
- title: short and specific, at most 80 characters.
- description: one line saying what the note holds, at most 150 characters.
- body: Markdown that organizes everything discussed (facts, decisions, plans, open questions, links) under headings or bullets, naming who said what where it matters. Leave out nothing of substance; drop greetings and filler.`;

const PLACE = `You file notes into a folder tree that works like a knowledge graph. You get the tree (folders nested by indentation, each with its description), a new note, and existing notes that may be related.
Choose where the note belongs: reuse an existing folder when it covers the same subject, create a sub-folder when the note is a distinct part of an existing subject, and start a new top-level folder only for a new subject. Folder names are short, at most 40 characters.
Reply with ONLY JSON: {"path": ["Top folder", "Sub folder"], "descriptions": {"New folder name": "one line"}, "links": [12]}
- path: folder names from the top level down, spelling existing folders exactly as in the tree.
- descriptions: a one-line description for every folder in path that does not exist yet.
- links: up to 3 ids of related notes, only from the list you were given.`;

const str = (v, max) => typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;

// The last `minutes` (default 10) of a channel before `before` (now when unset), oldest first.
export function windowMessages(channel, before, minutes) {
  const span = Math.max(1, Math.floor(Number(minutes)) || WINDOW);
  return readChannelRange(channel, before, { count: MAX_WINDOW_MESSAGES, since: Date.now() - span * 60_000 });
}

const transcriptOf = (messages) =>
  messages
    .map((m) => `[${m.createdAt.toISOString().slice(0, 16).replace('T', ' ')}] ${m.member?.displayName || m.author.displayName || m.author.username}: ${m.content}`)
    .join('\n');

// messages: Discord messages, oldest first. Returns { note, path } or { error }.
export async function saveNote(config, { messages, authorId, topic = '' }, { ask = askJson, decideImpl = decide } = {}) {
  if (!configured(config)) return { error: 'Notes need DATABASE_URL to be set.' };
  if (isFull('notes')) return { error: 'Storage for notes is full; Oscar has been asked to approve a cleanup.' };
  let lines = messages.filter((m) => m.content);
  // Too long for the writer: Jev keeps the lines that matter first. Jev down (or
  // keeping nothing) falls back to cutting the oldest lines.
  if (transcriptOf(lines).length > MAX_TRANSCRIPT) {
    const kept = await pickRelevant(config, lines, topic ? relevantTo : worthRemembering, topic, decideImpl);
    if (kept.length) lines = kept;
  }
  const transcript = transcriptOf(lines).slice(-MAX_TRANSCRIPT);
  if (!transcript) return { error: 'There is no conversation here to save.' };

  const written = await ask({
    config,
    system: WRITE,
    user: transcript,
    isValid: (v) => str(v?.title, 80) && str(v?.description, 150) && str(v?.body, 20_000),
  });
  if (!written) return { error: 'The model could not write the note. Try again.' };
  const note = { title: str(written.title, 80), description: str(written.description, 150), body: str(written.body, 20_000) };

  return fileNote(config, note, authorId, ask);
}

// A note Panda wrote itself (create_note): text it was asked to write down, or
// a file when `fileName` is set. Filed into the tree like any other note.
// Returns { note, path } or { error }.
export async function createNote(config, { title, description, body, fileName = null, authorId }, { ask = askJson } = {}) {
  if (!configured(config)) return { error: 'Notes need DATABASE_URL to be set.' };
  if (isFull('notes')) return { error: 'Storage for notes is full; Oscar has been asked to approve a cleanup.' };
  const note = {
    title: str(title, 80),
    description: str(description, 150) || str(String(body ?? '').split('\n').find((l) => l.trim()), 150),
    body: typeof body === 'string' && body.trim() ? body.slice(0, MAX_BODY) : null,
  };
  if (!note.title || !note.body) return { error: 'A note needs a title and some content.' };
  return fileNote(config, note, authorId, ask, fileName);
}

// Files `note` into the folder tree, links it to related notes and stores it.
async function fileNote(config, note, authorId, ask, fileName = null) {
  const { folders } = await loadTree(config);
  const related = (
    await db.query(
      config,
      `select n.id, n.title, n.description from notes n, websearch_to_tsquery('english', $1) q
       where n.fts @@ q order by ts_rank(n.fts, q) desc limit 5`,
      [orQuery(`${note.title} ${note.description}`)],
    )
  ).rows.map(norm);
  const placed = await ask({
    config,
    system: PLACE,
    user: [
      `--- folder tree ---\n${treeOutline(folders)}`,
      `--- new note ---\n${note.title}: ${note.description}`,
      `--- related notes ---\n${related.map((r) => `${r.id}: ${r.title}: ${r.description}`).join('\n') || '(none)'}`,
    ].join('\n\n'),
    isValid: (v) => Array.isArray(v?.path) && v.path.length >= 1 && v.path.length <= MAX_DEPTH && v.path.every((p) => str(p, 40)),
  });
  // A model that can't file it still shouldn't lose the note.
  const path = placed ? placed.path.map((p) => str(p, 40)) : ['Unsorted'];
  const descriptions = placed?.descriptions && typeof placed.descriptions === 'object' ? placed.descriptions : {};

  let parent = null;
  for (const name of path) {
    const find = () =>
      db.query(config, 'select id from note_folders where coalesce(parent_id, 0) = coalesce($1::bigint, 0) and lower(name) = lower($2)', [parent, name]);
    let { rows } = await find();
    if (!rows.length) {
      await db.query(config, 'insert into note_folders (parent_id, name, description) values ($1, $2, $3) on conflict do nothing', [
        parent,
        name,
        str(descriptions[name], 150) || '',
      ]);
      ({ rows } = await find());
    }
    parent = Number(rows[0].id);
  }

  const { rows } = await db.query(
    config,
    'insert into notes (folder_id, title, description, body, author_id, file_name) values ($1, $2, $3, $4, $5, $6) returning id',
    [parent, note.title, note.description, note.body, authorId, fileName],
  );
  const id = Number(rows[0].id);
  const allowed = new Set(related.map((r) => r.id));
  const links = (Array.isArray(placed?.links) ? placed.links : []).map(Number).filter((l) => allowed.has(l)).slice(0, 3);
  if (links.length) {
    await db.query(config, 'insert into note_links (from_id, to_id) select $1, unnest($2::bigint[]) on conflict do nothing', [id, links]);
  }
  noteWrite(config, 'notes');
  return { note: { id, ...note, author_id: authorId, file_name: fileName }, path };
}

// Starting at the top, Jev picks which folders to go into, level by level.
// Returns the folder ids reached, or null when Jev is off or failed.
export async function walkFolders(config, folders, query, decideImpl = decide) {
  const kids = childrenOf(folders);
  const reached = new Set();
  let level = [null];
  for (let depth = 0; depth < MAX_DEPTH && level.length && reached.size < MAX_OPENED; depth++) {
    const next = [];
    for (const parent of level) {
      const options = (kids.get(parent) || []).slice(0, MAX_KIDS);
      if (!options.length) continue;
      let chosen = options;
      if (options.length > 1) {
        const answers = await decideImpl(config, { query }, {
          folder: {
            type: 'choice',
            instructions: 'Which folder most likely holds notes about `query`?',
            criteria: Object.fromEntries(options.map((f) => [`f${f.id}`, `${f.name}: ${f.description}`.slice(0, 300)])),
          },
        });
        const pick = answers?.folder;
        if (!pick?.probabilities) return null;
        chosen = options.filter((f) => pick.probabilities[`f${f.id}`] >= DESCEND);
        if (!chosen.length) chosen = options.filter((f) => `f${f.id}` === pick.choice);
      }
      for (const f of chosen) {
        if (reached.size >= MAX_OPENED) break;
        reached.add(f.id);
        next.push(f.id);
      }
    }
    level = next;
  }
  return reached;
}

// The best notes for `query`: the Jev walk first, then plain search over every
// note when Jev is off or the walk found nothing that matches.
export async function findNotes(config, query, { limit = 5, decideImpl = decide } = {}) {
  const { folders } = await loadTree(config);
  const reached = await walkFolders(config, folders, query, decideImpl);
  if (reached?.size) {
    const { rows } = await db.query(
      config,
      `with picked as (
         select id from notes where folder_id = any($1::bigint[])
         union select l.to_id from note_links l join notes n on n.id = l.from_id where n.folder_id = any($1::bigint[])
         union select l.from_id from note_links l join notes n on n.id = l.to_id where n.folder_id = any($1::bigint[])
       )
       select ${COLUMNS} from notes n, websearch_to_tsquery('english', $2) q
       where n.id in (select id from picked) and (n.fts @@ q or similarity(n.title, $3) > 0.2)
       order by ts_rank(n.fts, q) + similarity(n.title, $3) desc limit $4`,
      [[...reached], orQuery(query), query, limit],
    );
    if (rows.length) return rows.map(norm);
  }
  const { rows } = await db.query(
    config,
    `select ${COLUMNS} from notes n, websearch_to_tsquery('english', $1) q
     where n.fts @@ q or similarity(n.title, $2) > 0.2
     order by ts_rank(n.fts, q) + similarity(n.title, $2) desc limit $3`,
    [orQuery(query), query, limit],
  );
  return rows.map(norm);
}

// Exact title, then the most similar title, then the smart search.
export async function openNote(config, title, opts = {}) {
  const exact = await db.query(config, `select ${COLUMNS} from notes n where lower(n.title) = lower($1) order by n.created_at desc limit 1`, [title]);
  if (exact.rows.length) return norm(exact.rows[0]);
  const similar = await db.query(
    config,
    `select ${COLUMNS} from notes n where similarity(n.title, $1) >= 0.3 order by similarity(n.title, $1) desc limit 1`,
    [title],
  );
  if (similar.rows.length) return norm(similar.rows[0]);
  return (await findNotes(config, title, { limit: 1, ...opts }))[0] || null;
}

export async function getNote(config, id) {
  const { rows } = await db.query(config, `select ${COLUMNS} from notes n where n.id = $1`, [id]);
  return rows.length ? norm(rows[0]) : null;
}

export async function relatedNotes(config, id) {
  const { rows } = await db.query(
    config,
    `select n.id, n.title from notes n where n.id in (
       select to_id from note_links where from_id = $1 union select from_id from note_links where to_id = $1
     ) order by n.title`,
    [id],
  );
  return rows.map(norm);
}

// For autocomplete: titles matching what was typed; `authorId` limits to that author's notes.
export async function noteChoices(config, typed, authorId = null) {
  const { rows } = await db.query(
    config,
    `select n.id, n.title from notes n
     where ($2::text is null or n.author_id = $2) and ($1 = '' or n.title ilike '%' || $1 || '%' or similarity(n.title, $1) > 0.2)
     order by similarity(n.title, $1) desc, n.created_at desc limit 25`,
    [String(typed || ''), authorId],
  );
  return rows.map(norm);
}

// Only the author or Oscar. Folders left empty go too.
export async function deleteNote(config, id, userId, isOwner) {
  const { rows } = await db.query(config, 'delete from notes where id = $1 and (author_id = $2 or $3) returning title', [id, userId, Boolean(isOwner)]);
  if (rows.length) await pruneEmptyFolders(config);
  return rows[0]?.title ?? null;
}
