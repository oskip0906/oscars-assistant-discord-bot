import { EmbedBuilder } from 'discord.js';
import { randomEmbedColor } from './colors.js';
import { db, configured } from '../db.js';
import { providerFor } from '../agent/openrouter.js';

// Junk such as a newline'd id would leave every reply failing, so only plain ids are saved.
const SAFE_MODEL_ID = /^[A-Za-z0-9._\-/:]+$/;
// OpenRouter provider slugs ("deepinfra", "deepinfra/fp8", "google-vertex").
const SAFE_PROVIDER = /^[A-Za-z0-9][A-Za-z0-9._\-/]*$/;

// The chosen model lives in the database (bot_settings), so it survives restarts
// and redeploys with no commit. Its optional provider goes in the same upsert,
// under 'model_providers' (a JSON map of model id → provider). Never throws.
export async function saveModel(config, model, { query = db.query, provider = '' } = {}) {
  const value = String(model ?? '').trim();
  if (!value || !SAFE_MODEL_ID.test(value)) {
    return { ok: false, error: `\`${value.slice(0, 80) || '(empty)'}\` is not a valid model id.` };
  }
  const slug = String(provider ?? '').trim();
  if (slug && !SAFE_PROVIDER.test(slug)) {
    return { ok: false, error: `\`${slug.slice(0, 80)}\` is not a valid provider name.` };
  }
  if (!configured(config)) return { ok: false, error: 'DATABASE_URL is not set, so the choice cannot be saved.' };
  const providers = withProvider(config.modelProviders, value, slug);
  try {
    await query(
      config,
      `insert into bot_settings (key, value) values ('model', $1), ('model_providers', $2) on conflict (key) do update set value = excluded.value`,
      [value, JSON.stringify(providers)],
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `Could not save the model: ${String(err.message || err).slice(0, 200)}` };
  }
}

// The provider map with one model's entry set, or dropped when the provider is blank.
function withProvider(providers, model, provider) {
  const next = { ...(providers || {}) };
  if (provider) next[model] = provider;
  else delete next[model];
  return next;
}

// A saved map that is missing or unreadable (or has junk entries) means
// OpenRouter's default routing for those models, never a failed boot.
function parseProviders(raw) {
  if (!raw) return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error('[model] saved model_providers is not JSON, using default routing');
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const out = {};
  for (const [model, provider] of Object.entries(parsed)) {
    const slug = typeof provider === 'string' ? provider.trim() : '';
    if (slug && SAFE_PROVIDER.test(slug)) out[model] = slug;
  }
  return out;
}

// At boot: switch to the saved model and providers, if there are any. No
// database or no row keeps the default; a database with only a 'model' row
// (saved before providers existed) keeps working as is.
export async function loadModel(config, { query = db.query } = {}) {
  if (!configured(config)) return;
  const { rows } = await query(config, `select key, value from bot_settings where key in ('model', 'model_providers')`);
  const saved = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  if (saved.model) config.model = saved.model;
  config.modelProviders = parseProviders(saved.model_providers);
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

// The providers OpenRouter routes one model to: each endpoint's slug ("tag",
// e.g. "deepinfra/fp8"), the slug without its variant, and its display name.
export async function listProviders(config, model) {
  const res = await fetch(`https://openrouter.ai/api/v1/models/${model}/endpoints`, {
    headers: { Authorization: `Bearer ${config.openrouterApiKey}` },
  });
  if (!res.ok) throw new Error(`OpenRouter endpoints HTTP ${res.status}`);
  const endpoints = (await res.json()).data?.endpoints || [];
  return endpoints.flatMap((e) => [e.tag, e.tag?.split('/')[0], e.provider_name]).filter(Boolean);
}

// "Google Vertex", "google-vertex" and "GOOGLE-VERTEX" are the same provider.
const providerKey = (name) => String(name).toLowerCase().replace(/[^a-z0-9/]+/g, '-');

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

const describe = (model, provider) => `\`${model}\`${provider ? ` via \`${provider}\`` : ''}`;

// The /set_model flow: validate against OpenRouter's catalog (and, when a
// provider is given, that model's providers), save the choice, then switch the
// running process to it. A blank provider means OpenRouter's default routing.
export async function switchModel(
  { model, provider, config },
  { listModels = listOpenRouterModels, listProviders: providersOf = listProviders, save = saveModel } = {},
) {
  const value = String(model ?? '').trim();
  const slug = String(provider ?? '').trim();
  const running = describe(config.model, providerFor(config, config.model));

  if (value === config.model && slug === providerFor(config, value)) {
    return { ok: true, summary: `🧠 Already running ${running} — nothing to change.` };
  }

  // A typo'd model id would leave every reply failing, so check the catalog
  // first. If OpenRouter itself is unreachable we proceed anyway and say so —
  // refusing would strand Oscar on the old model.
  let caveat = '';
  try {
    const catalog = await listModels(config);
    if (!catalog.includes(value)) {
      return { ok: false, summary: `❌ OpenRouter doesn’t serve \`${value}\`. Still running ${running}.` };
    }
  } catch (err) {
    caveat = `\n⚠️ Couldn’t verify the id with OpenRouter (${String(err.message || err).slice(0, 120)}) — switching anyway.`;
  }

  // A pinned provider that doesn't serve the model fails every reply the same
  // way, so it is refused here with the providers that do. Unreachable: as above.
  if (slug) {
    if (!SAFE_PROVIDER.test(slug)) {
      return { ok: false, summary: `❌ \`${slug.slice(0, 80)}\` is not a valid provider name. Still running ${running}.` };
    }
    try {
      const names = await providersOf(config, value);
      if (names.length && !names.some((n) => providerKey(n) === providerKey(slug))) {
        const offered = [...new Set(names.filter((n) => !n.includes('/') && n === n.toLowerCase()))].slice(0, 15);
        return {
          ok: false,
          summary: `❌ OpenRouter has no \`${slug}\` provider for \`${value}\`${offered.length ? ` (try: ${offered.map((n) => `\`${n}\``).join(', ')})` : ''}. Still running ${running}.`,
        };
      }
    } catch (err) {
      caveat += `\n⚠️ Couldn’t verify the provider with OpenRouter (${String(err.message || err).slice(0, 120)}) — using it anyway.`;
    }
  }

  const saved = await save(config, value, { provider: slug });
  if (!saved.ok) {
    return { ok: false, summary: `❌ ${saved.error} Still running ${running}.` };
  }

  config.modelProviders = withProvider(config.modelProviders, value, slug);
  config.model = value;
  return {
    ok: true,
    summary: `🧠 Model switched: ${running} → ${describe(value, slug)}, live now and saved.${caveat}`,
  };
}

export function buildModelEmbed(client, config) {
  return new EmbedBuilder()
    .setColor(randomEmbedColor())
    .setTitle('🧠 Model')
    .setThumbnail(client.user.displayAvatarURL({ size: 256 }))
    .addFields(
      { name: '🐼 Currently running', value: `\`${config.model}\``, inline: false },
      { name: '🛰️ Provider', value: providerFor(config, config.model) ? `\`${providerFor(config, config.model)}\`` : 'OpenRouter default', inline: false },
    );
}
