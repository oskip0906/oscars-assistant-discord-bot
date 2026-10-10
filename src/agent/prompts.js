// Panda's persona lives in Supabase Storage, bucket `prompts` (schema in
// supabase/prompts.sql): identity.md is fixed, soul.md is what set_rule rewrites.
// The repo holds no prompt text, so editing a file in the Supabase dashboard
// reaches the bot within TTL_MS, with no deploy.

const BUCKET = 'prompts';
const TTL_MS = 60_000;
const cache = new Map(); // name -> { text, at }

const configured = (config) => Boolean(config?.supabaseUrl && config?.supabaseKey);

async function storage(config, method, name, body, fetchImpl) {
  const res = await fetchImpl(`${config.supabaseUrl}/storage/v1/object/${BUCKET}/${name}`, {
    method,
    headers: {
      apikey: config.supabaseKey,
      Authorization: `Bearer ${config.supabaseKey}`,
      ...(body !== undefined && { 'Content-Type': 'text/markdown; charset=utf-8', 'x-upsert': 'true' }),
    },
    body,
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`Supabase storage ${method} ${BUCKET}/${name}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res;
}

// Throws when the file can't be read. set_rule uses this: rewriting soul.md from
// a stale or empty copy would silently throw Oscar's earlier rules away.
export async function loadPrompt(config, name, { fetchImpl = fetch } = {}) {
  if (!configured(config)) throw new Error('Set SUPABASE_URL and SUPABASE_SECRET_KEY in .env first.');
  const text = await (await storage(config, 'GET', name, undefined, fetchImpl)).text();
  cache.set(name, { text, at: Date.now() });
  return text;
}

// For the system prompt: never throws. Supabase down keeps the last good copy
// (and waits a TTL before retrying); never loaded at all means '' and the turn
// runs on the system prompt alone.
export async function readPrompt(config, name, { fetchImpl = fetch } = {}) {
  const hit = cache.get(name);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.text;
  if (!configured(config)) return '';
  try {
    return await loadPrompt(config, name, { fetchImpl });
  } catch (err) {
    console.error(`[prompts] could not load ${name}${hit ? ', keeping the last copy' : ''}:`, String(err.message || err).slice(0, 200));
    if (hit) cache.set(name, { text: hit.text, at: Date.now() });
    return hit?.text ?? '';
  }
}

export async function writePrompt(config, name, text, { fetchImpl = fetch } = {}) {
  if (!configured(config)) throw new Error('Set SUPABASE_URL and SUPABASE_SECRET_KEY in .env first.');
  await storage(config, 'POST', name, text, fetchImpl);
  cache.set(name, { text, at: Date.now() });
}

// Tests only: the cache is per process.
export const clearPromptCache = () => cache.clear();
