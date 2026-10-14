import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(projectRoot, '.env'), quiet: true });

// Oscar's Discord user id comes only from OWNER_DISCORD_ID (.env, or the host's
// env vars). A missing or malformed value stops the boot in validateConfig rather
// than leaving junk as the owner.
const envOwnerId = process.env.OWNER_DISCORD_ID?.trim() || '';

// Containers have no file mounts, so the cookies can also come base64-encoded in
// YT_COOKIES_B64. yt-dlp only reads a file, so they are written to one.
function cookiesFile() {
  const b64 = process.env.YT_COOKIES_B64;
  if (!b64) return process.env.YT_COOKIES_FILE || '';
  const file = path.join(os.tmpdir(), 'panda-yt-cookies.txt');
  fs.writeFileSync(file, Buffer.from(b64, 'base64'), { mode: 0o600 });
  return file;
}

function bool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(value);
}

export const config = {
  projectRoot,
  dataDir: path.join(projectRoot, 'data'),

  discordToken: process.env.DISCORD_TOKEN || '',
  openrouterApiKey: process.env.OPENROUTER_API_KEY || '',
  // The default chat model. /set_model saves a new one in the database
  // (bot_settings), and loadModel swaps it in at boot.
  model: 'deepseek/deepseek-v4.1-flash',
  // Optional OpenRouter provider per model id ({ 'model/id': 'provider-slug' }),
  // also set by /set_model. A model with no entry uses OpenRouter's default routing.
  modelProviders: {},
  ownerId: /^\d{17,20}$/.test(envOwnerId) ? envOwnerId : '',
  githubPat: process.env.GITHUB_PAT || '',
  // GitHub's hosted MCP server, read-only path. Owner-gated at the tool list, so
  // a guest never sees these and never spends tokens on them. Off automatically
  // when GITHUB_PAT is unset; GITHUB_MCP_ENABLED=false turns it off explicitly.
  githubMcpEnabled: bool(process.env.GITHUB_MCP_ENABLED, true),
  githubMcpReadOnlyUrl: process.env.GITHUB_MCP_URL || 'https://api.githubcopilot.com/mcp/readonly',
  // The sandbox workflow lives in this control repository. It is deliberately
  // separate from the bot's checkout: development work never edits the live
  // deployment filesystem.
  developmentSandboxRepo: process.env.DEVELOPMENT_SANDBOX_REPO || 'oskip0906/oscars-assistant-discord-bot',
  developmentSandboxWorkflow: process.env.DEVELOPMENT_SANDBOX_WORKFLOW || 'development-sandbox.yml',
  developmentSandboxRef: process.env.DEVELOPMENT_SANDBOX_REF || 'main',
  // Jev (TypeSafe's decision model, via the same OpenRouter key) makes Panda's
  // quick yes/no and pick-one calls. JEV_ENABLED=false sends nothing to it and
  // every call site falls back to its pre-Jev behaviour.
  jevEnabled: bool(process.env.JEV_ENABLED, true),
  botName: process.env.BOT_NAME || 'Panda',
  // How long a sender's first message waits for their follow-ups before they are
  // all answered as one turn (BATCH_WINDOW_MS, 250–10000 ms). Shorter answers
  // sooner; longer keeps a slow multi-message typer in one turn.
  batchWindowMs: Math.min(10_000, Math.max(250, Number(process.env.BATCH_WINDOW_MS) || 1500)),
  allowBots: bool(process.env.ALLOW_BOTS, true),
  // DM functionality is disabled and has no env switch: the bot ignores direct
  // messages. See messageHandler's `isDM && !config.dmEnabled` guard.
  dmEnabled: false,
  // YouTube now bot-walls unauthenticated stream extraction under load; a cookies
  // file (or browser) lets yt-dlp authenticate and play reliably.
  ytCookiesFile: cookiesFile(),
  ytCookiesFromBrowser: process.env.YT_COOKIES_FROM_BROWSER || '',
  searxngUrl: (process.env.SEARXNG_URL || 'http://127.0.0.1:8888').replace(/\/$/, ''),
  // The PMS Postgres (db-1): persona prompts, hidden chat context, notes and
  // reminders (src/schema.sql). Unset = none of those work, but chat still does.
  databaseUrl: process.env.DATABASE_URL || '',
  // Oscar's standing rules (add_rule / remove_rule), read into every system
  // prompt. Defaults to RULES.md in the repo; RULES_FILE moves it (e.g. into
  // data/ so a container keeps it across redeploys).
  rulesFile: process.env.RULES_FILE || path.join(projectRoot, 'RULES.md'),
  // The scripting sandbox (/sandbox and the sandbox tool) runs on PMS Cloud with
  // a PMS project token (pms_…). No token = it says it isn't set up.
  pmsSandboxToken: process.env.PMS_SANDBOX_TOKEN || '',
  // The template its sandboxes start from; scripts/build-sandbox-template.mjs builds it.
  sandboxTemplate: process.env.PMS_SANDBOX_TEMPLATE || 'panda-sandbox',
};

// The bot's secrets only ever go into auth headers; none is put in front of the
// model or into a message. redactSecrets guarantees it at both boundaries anyway,
// so no bug, error message or tool output can hand one to whoever asks.
const dbPassword = () => {
  try {
    return decodeURIComponent(new URL(config.databaseUrl).password);
  } catch {
    return '';
  }
};

export function redactSecrets(text) {
  let out = String(text ?? '');
  for (const secret of [config.discordToken, config.openrouterApiKey, config.githubPat, config.databaseUrl, dbPassword(), process.env.YT_COOKIES_B64, config.pmsSandboxToken]) {
    if (secret && secret.length >= 8) out = out.split(secret).join('[redacted]');
  }
  return out;
}

export function validateConfig() {
  const missing = [];
  if (!config.discordToken) missing.push('DISCORD_TOKEN');
  if (!config.openrouterApiKey) missing.push('OPENROUTER_API_KEY');
  if (!config.ownerId) missing.push('OWNER_DISCORD_ID (a Discord user id)');
  if (missing.length) {
    throw new Error(`Missing required env vars: ${missing.join(', ')} — fill them in ${path.join(projectRoot, '.env')}`);
  }
  if (!config.databaseUrl) {
    console.warn('[panda] DATABASE_URL is not set: running without the prompts (identity.md, soul.md), context, notes and reminders.');
  }
}
