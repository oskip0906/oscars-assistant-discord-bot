import fs from 'node:fs';
import path from 'node:path';
import { EmbedBuilder } from 'discord.js';

// The model the RUNNING process uses is config.model (loaded from .env at
// startup). Re-read .env live so we can flag an edited-but-not-applied value.
export function readEnvModel(config) {
  try {
    const raw = fs.readFileSync(path.join(config.projectRoot, '.env'), 'utf8');
    const line = raw.split('\n').find((l) => l.trim().startsWith('OPENROUTER_MODEL='));
    if (!line) return null;
    const value = line.slice(line.indexOf('=') + 1).split('#')[0].trim();
    return value || null;
  } catch {
    return null;
  }
}

// A model id is written straight into .env, so it has to be inert: anything
// outside this charset (a newline especially) could smuggle in another
// assignment and quietly rewrite a secret on the next boot.
const SAFE_MODEL_ID = /^[A-Za-z0-9._\-/:]+$/;

// Point OPENROUTER_MODEL at `model`, leaving the rest of .env byte-identical.
// The running process keeps using the old model until it restarts — which is
// exactly what /switch_model does next. Never throws.
export function writeEnvModel(config, model) {
  const value = String(model ?? '').trim();
  if (!value || !SAFE_MODEL_ID.test(value)) {
    return { ok: false, error: `\`${value.slice(0, 80) || '(empty)'}\` is not a valid model id.` };
  }

  const file = path.join(config.projectRoot, '.env');
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const lines = raw.split('\n');
    const index = lines.findIndex((l) => l.trim().startsWith('OPENROUTER_MODEL='));
    if (index === -1) {
      // Keep a trailing newline if the file had one, rather than gluing the new
      // assignment onto the last line.
      if (lines[lines.length - 1] !== '') lines.push('');
      lines[lines.length - 1] = `OPENROUTER_MODEL=${value}`;
      lines.push('');
    } else {
      lines[index] = `OPENROUTER_MODEL=${value}`;
    }
    // Write via a temp file + rename so a crash mid-write can't leave Oscar
    // with a truncated .env and a bot that won't boot.
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, lines.join('\n'), { mode: 0o600 });
    fs.renameSync(tmp, file);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `Could not write .env: ${String(err.message || err).slice(0, 200)}` };
  }
}

// Every model id OpenRouter currently serves.
export async function listOpenRouterModels(config) {
  const res = await fetch('https://openrouter.ai/api/v1/models', {
    headers: { Authorization: `Bearer ${config.openrouterApiKey}` },
  });
  if (!res.ok) throw new Error(`OpenRouter models HTTP ${res.status}`);
  const body = await res.json();
  return (body.data || []).map((m) => m.id).filter(Boolean);
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

// The /switch_model flow: validate against OpenRouter's catalog, persist, and
// tell the caller whether a restart is needed to actually load it.
export async function switchModel({ model, config }, { listModels = listOpenRouterModels, write = writeEnvModel } = {}) {
  const value = String(model ?? '').trim();

  if (value === config.model) {
    return { ok: true, restart: false, summary: `🧠 Already running \`${value}\` — nothing to change.` };
  }

  // A typo'd model id would restart the bot into a state where every reply
  // fails, so check the catalog first. If OpenRouter itself is unreachable we
  // proceed anyway and say so — refusing would strand Oscar on the old model.
  let caveat = '';
  try {
    const catalog = await listModels(config);
    if (!catalog.includes(value)) {
      return {
        ok: false,
        restart: false,
        summary: `❌ OpenRouter doesn’t serve \`${value}\`. Still running \`${config.model}\`.`,
      };
    }
  } catch (err) {
    caveat = `\n⚠️ Couldn’t verify the id with OpenRouter (${String(err.message || err).slice(0, 120)}) — switching anyway.`;
  }

  const written = write(config, value);
  if (!written.ok) {
    return { ok: false, restart: false, summary: `❌ ${written.error} Still running \`${config.model}\`.` };
  }

  return {
    ok: true,
    restart: true,
    summary: `🧠 Model switched: \`${config.model}\` → \`${value}\`.${caveat}\n🔁 Restarting now to load it.`,
  };
}

export function buildModelEmbed(client, config) {
  const envModel = readEnvModel(config);
  const pendingChange = envModel && envModel !== config.model;

  return new EmbedBuilder()
    .setColor(0xb57edc)
    .setTitle('🧠 Model')
    .setThumbnail(client.user.displayAvatarURL({ size: 256 }))
    .addFields({
      name: '🐼 Currently running',
      value: [
        `\`${config.model}\``,
        ...(pendingChange
          ? [`⚠️ \`.env\` now says \`${envModel}\` — restart me to apply it.`]
          : []),
      ].join('\n'),
      inline: false,
    });
}
