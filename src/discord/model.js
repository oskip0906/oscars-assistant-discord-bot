import { EmbedBuilder } from 'discord.js';
import { randomEmbedColor } from './colors.js';
import { setDefaultModel } from '../configManager.js';
import { githubRead } from '../agent/tools/githubMcp.js';

// A model id is committed into src/models.json, so it has to be inert: nothing
// outside this charset gets into the file.
const SAFE_MODEL_ID = /^[A-Za-z0-9._\-/:]+$/;

// Save `key` ('conversation' or 'development') as `model` by committing
// src/models.json to the bot's repo. The host has no disk to write to; the commit
// triggers CI, whose deploy boots the bot with the new file. The read goes
// through the GitHub MCP server, the commit through REST. Never throws.
export async function saveModel(
  config,
  key,
  model,
  { fetchImpl = fetch, read = (name, args) => githubRead(name, args, { config }) } = {},
) {
  const value = String(model ?? '').trim();
  if (!value || !SAFE_MODEL_ID.test(value)) {
    return { ok: false, error: `\`${value.slice(0, 80) || '(empty)'}\` is not a valid model id.` };
  }
  if (!config.githubPat) return { ok: false, error: 'GITHUB_PAT is not set, so src/models.json cannot be committed.' };

  const url = `https://api.github.com/repos/${config.developmentSandboxRepo}/contents/src/models.json`;
  const headers = {
    Authorization: `Bearer ${config.githubPat}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'panda-bot',
  };
  try {
    const [owner, repo] = String(config.developmentSandboxRepo).split('/');
    const { result, text } = await read('get_file_contents', { owner, repo, path: 'src/models.json', ref: 'refs/heads/main' });
    // The blob sha comes back in the text part ("... (SHA: <sha>)"), the file in a resource part.
    const sha = text.match(/SHA: ([0-9a-f]{40})/)?.[1];
    const content = result?.content?.find((part) => part.type === 'resource')?.resource?.text;
    if (!sha || content == null) throw new Error('GitHub MCP returned no sha or content for src/models.json');
    const models = { ...JSON.parse(content), [key]: value };
    const res = await fetchImpl(url, {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: `Set the ${key} model to ${value}`,
        content: Buffer.from(`${JSON.stringify(models, null, 2)}\n`).toString('base64'),
        sha,
        branch: 'main',
      }),
    });
    if (!res.ok) throw new Error(`GitHub HTTP ${res.status} committing src/models.json`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `Could not save src/models.json: ${String(err.message || err).slice(0, 200)}` };
  }
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

// The /set_model flow: validate against OpenRouter's catalog, commit the choice,
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

  const saved = await save(config, 'conversation', value);
  if (!saved.ok) {
    return { ok: false, summary: `❌ ${saved.error} Still running \`${config.model}\`.` };
  }

  const previous = config.model;
  config.model = value;
  setDefaultModel(value);
  return {
    ok: true,
    summary: `🧠 Model switched: \`${previous}\` → \`${value}\`, live now and saved to src/models.json.${caveat}`,
  };
}

export function buildModelEmbed(client, config) {
  return new EmbedBuilder()
    .setColor(randomEmbedColor())
    .setTitle('🧠 Model')
    .setThumbnail(client.user.displayAvatarURL({ size: 256 }))
    .addFields({ name: '🐼 Currently running', value: `\`${config.model}\``, inline: false });
}
