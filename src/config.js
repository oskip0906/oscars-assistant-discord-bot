import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(projectRoot, '.env'), quiet: true });

// Oscar's Discord user id, pinned as a hardcoded constant so owner-gating can
// never be weakened by a missing/edited .env. The env var may only NARROW to
// this exact value; anything else is ignored and we fall back to the constant.
export const OWNER_ID = '767525911695851550';

function bool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(value);
}

export const config = {
  projectRoot,
  dataDir: path.join(projectRoot, 'data'),
  contextDir: path.join(projectRoot, 'data', 'context'),
  contextFilesDir: path.join(projectRoot, 'context'),

  discordToken: process.env.DISCORD_TOKEN || '',
  openrouterApiKey: process.env.OPENROUTER_API_KEY || '',
  model: process.env.OPENROUTER_MODEL || 'google/gemini-2.5-flash',
  ownerId: OWNER_ID,
  githubPat: process.env.GITHUB_PAT || '',
  vaultRepo: process.env.VAULT_REPO || 'oskip0906/oskip-vault',
  botName: process.env.BOT_NAME || 'Panda',
  allowBots: bool(process.env.ALLOW_BOTS, true),
  // DM functionality is disabled: the bot ignores direct messages regardless of
  // the DM_ENABLED env var. See messageHandler's `isDM && !config.dmEnabled` guard.
  dmEnabled: false,
  maxToolIterations: Math.max(1, parseInt(process.env.MAX_TOOL_ITERATIONS || '12', 10) || 12),
  braveApiKey: process.env.BRAVE_API_KEY || '',
  jinaApiKey: process.env.JINA_API_KEY || '',
  // YouTube now bot-walls unauthenticated stream extraction under load; a cookies
  // file (or browser) lets yt-dlp authenticate and play reliably.
  ytCookiesFile: process.env.YT_COOKIES_FILE || '',
  ytCookiesFromBrowser: process.env.YT_COOKIES_FROM_BROWSER || '',
  searxngUrl: (process.env.SEARXNG_URL || 'http://127.0.0.1:8888').replace(/\/$/, ''),
};

export function validateConfig() {
  const missing = [];
  if (!config.discordToken) missing.push('DISCORD_TOKEN');
  if (!config.openrouterApiKey) missing.push('OPENROUTER_API_KEY');
  if (missing.length) {
    throw new Error(`Missing required env vars: ${missing.join(', ')} — fill them in ${path.join(projectRoot, '.env')}`);
  }
}
