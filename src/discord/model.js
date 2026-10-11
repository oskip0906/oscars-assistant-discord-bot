import { EmbedBuilder } from 'discord.js';
import { randomEmbedColor } from './colors.js';
import { db, configured } from '../db.js';

// Junk such as a newline'd id would leave every reply failing, so only plain ids are saved.
const SAFE_MODEL_ID = /^[A-Za-z0-9._\-/:]+$/;

// The chosen model lives in the database (bot_settings), so it survives restarts
// and redeploys with no commit. Never throws.
export async function saveModel(config, model, { query = db.query } = {}) {
  const value = String(model ?? '').trim();
  if (!value || !SAFE_MODEL_ID.test(value)) {
    return { ok: false, error: `\`${value.slice(0, 80) || '(empty)'}\` is not a valid model id.` };
  }
  if (!configured(config)) return { ok: false, error: 'DATABASE_URL is not set, so the choice cannot be saved.' };
  try {
    await query(config, `insert into bot_settings (key, value) values ('model', $1) on conflict (key) do update set value = excluded.value`, [value]);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `Could not save the model: ${String(err.message || err).slice(0, 200)}` };
  }
}

// At boot: switch to the saved model, if there is one. No database or no row keeps the default.
export async function loadModel(config, { query = db.query } = {}) {
  if (!configured(config)) return;
  const { rows } = await query(config, `select value from bot_settings where key = 'model'`);
  if (rows[0]?.value) config.model = rows[0].value;
}

async function fetchCatalog(config) {
  const res = await fetch('https://openrouter.ai/api/v1/models', {
    headers: { Authorization: `Bearer ${config.openrouterApiKey}` },
  });
  if (!res.ok) throw new Error(`OpenRouter models HTTP ${res.status}`);
  return (await res.json()).data || [];
}

// Every model id OpenRouter currently serves.
export async function listOpenRouterModels(config) {
  return (await fetchCatalog(config)).map((m) => m.id).filter(Boolean);
}

// What the chat model takes as input ("text", "image", "file", …), per
// OpenRouter's catalog. Looked up once per model; a failed lookup means text
// only, because sending an image to a text-only model fails the whole turn.
const inputsCache = new Map();
export async function modelInputs(config, catalog = fetchCatalog) {
  if (!inputsCache.has(config.model)) {
    try {
      const model = (await catalog(config)).find((m) => m.id === config.model);
      inputsCache.set(config.model, model?.architecture?.input_modalities ?? ['text']);
    } catch (err) {
      console.error('[model] could not read model input types:', err.message);
      return ['text'];
    }
  }
  return inputsCache.get(config.model);
}

// Discord fires autocomplete on every keystroke and gives 3 seconds to answer,
// so the catalog (hundreds of ids) is fetched once and reused.
const CATALOG_TTL_MS = 10 * 60 * 1000;
const catalogCache = {};

export async function modelChoices(
  config,
  focused,
  { listModels = listOpenRouterModels, cache = catalogCache, now = Date.now } = {},
) {
  try {
    if (!cache.ids || now() - cache.at > CATALOG_TTL_MS) {
      cache.ids = await listModels(config);
      cache.at = now();
    }
  } catch (err) {
    console.error('[model] could not list OpenRouter models:', err.message);
    return [];
  }

  const q = String(focused ?? '').toLowerCase();
  return cache.ids
    .filter((id) => id.toLowerCase().includes(q))
    .slice(0, 25) // Discord's hard cap
    .map((id) => ({ name: id.slice(0, 100), value: id.slice(0, 100) }));
}

// The /set_model flow: validate against OpenRouter's catalog, save the choice,
// then switch the running process to it.
export async function switchModel({ model, config }, { listModels = listOpenRouterModels, save = saveModel } = {}) {
  const value = String(model ?? '').trim();

  if (value === config.model) {
    return { ok: true, summary: `🧠 Already running \`${value}\` — nothing to change.` };
  }

  // A typo'd model id would leave every reply failing, so check the catalog
  // first. If OpenRouter itself is unreachable we proceed anyway and say so —
  // refusing would strand Oscar on the old model.
  let caveat = '';
  try {
    const catalog = await listModels(config);
    if (!catalog.includes(value)) {
      return { ok: false, summary: `❌ OpenRouter doesn’t serve \`${value}\`. Still running \`${config.model}\`.` };
    }
  } catch (err) {
    caveat = `\n⚠️ Couldn’t verify the id with OpenRouter (${String(err.message || err).slice(0, 120)}) — switching anyway.`;
  }

  const saved = await save(config, value);
  if (!saved.ok) {
    return { ok: false, summary: `❌ ${saved.error} Still running \`${config.model}\`.` };
  }

  const previous = config.model;
  config.model = value;
  return {
    ok: true,
    summary: `🧠 Model switched: \`${previous}\` → \`${value}\`, live now and saved.${caveat}`,
  };
}

export function buildModelEmbed(client, config) {
  return new EmbedBuilder()
    .setColor(randomEmbedColor())
    .setTitle('🧠 Model')
    .setThumbnail(client.user.displayAvatarURL({ size: 256 }))
    .addFields({ name: '🐼 Currently running', value: `\`${config.model}\``, inline: false });
}
