import { db, configured } from '../db.js';
import { noteWrite } from '../storage.js';

// Panda's persona lives in db-1, table `prompts` (src/schema.sql): identity.md
// is fixed, soul.md is what set_rule rewrites. The repo holds no prompt text, so
// an edit in the database reaches the bot within TTL_MS, with no deploy.

const TTL_MS = 60_000;
const cache = new Map(); // name -> { text, at }

// Throws when the file can't be read. set_rule uses this: rewriting soul.md from
// a stale or empty copy would silently throw Oscar's earlier rules away.
export async function loadPrompt(config, name) {
  if (!configured(config)) throw new Error('Set DATABASE_URL in .env first.');
  const { rows } = await db.query(config, 'select content from prompts where name = $1', [name]);
  if (!rows.length) throw new Error(`prompt ${name} not found`);
  const text = rows[0].content;
  cache.set(name, { text, at: Date.now() });
  return text;
}

// For the system prompt: never throws. The database down keeps the last good copy
// (and waits a TTL before retrying); never loaded at all means '' and the turn
// runs on the system prompt alone.
export async function readPrompt(config, name) {
  const hit = cache.get(name);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.text;
  if (!configured(config)) return '';
  try {
    return await loadPrompt(config, name);
  } catch (err) {
    console.error(`[prompts] could not load ${name}${hit ? ', keeping the last copy' : ''}:`, String(err.message || err).slice(0, 200));
    if (hit) cache.set(name, { text: hit.text, at: Date.now() });
    return hit?.text ?? '';
  }
}

export async function writePrompt(config, name, text) {
  if (!configured(config)) throw new Error('Set DATABASE_URL in .env first.');
  await db.query(
    config,
    'insert into prompts (name, content) values ($1, $2) on conflict (name) do update set content = excluded.content, updated_at = now()',
    [name, text],
  );
  cache.set(name, { text, at: Date.now() });
  noteWrite(config, 'persona');
}

// Tests only: the cache is per process.
export const clearPromptCache = () => cache.clear();
