import * as discordTools from './discord.js';
import * as searchTools from './search.js';
import * as githubTools from './github.js';
import * as contextTools from './context.js';
import * as claudeTools from './claude.js';
import * as musicTools from './music.js';

// Owner-only tools. Gated by the AUTHENTICATED Discord author id
// (invocation.isOwner) — never by anything a message could claim, so no one can
// impersonate Oscar into these. github is here because it acts with Oscar's
// PAT and could otherwise read/modify his private repos on a guest's behalf.
const OWNER_ONLY = new Set(['prompt_claude', 'self_fix', 'git_push', 'clear_all_context', 'github']);

const modules = [discordTools, searchTools, githubTools, contextTools, claudeTools, musicTools];

const allDefs = modules.flatMap((m) => m.defs);

const executors = {
  get_user_id: discordTools.getUserId,
  get_message_sender: discordTools.getMessageSender,
  react: discordTools.react,
  web_search: searchTools.webSearch,
  web_fetch: searchTools.webFetch,
  image_search: searchTools.imageSearch,
  vault_fetch: githubTools.vaultFetch,
  github: githubTools.githubApi,
  clear_context: contextTools.clearContext,
  clear_all_context: contextTools.clearAllContext,
  prompt_claude: claudeTools.promptClaude,
  self_fix: claudeTools.selfFix,
  git_push: claudeTools.gitPush,
  play_music: musicTools.playMusic,
};

export function toolDefs() {
  return allDefs;
}

export async function executeTool(name, args, invocation) {
  const fn = executors[name];
  if (!fn) return `Unknown tool: ${name}`;
  if (OWNER_ONLY.has(name) && !invocation.isOwner) {
    return `⛔ ${name} is restricted to Oscar (the owner). The current sender is not Oscar — politely refuse.`;
  }
  try {
    const result = await fn(args || {}, invocation);
    return typeof result === 'string' ? result : JSON.stringify(result);
  } catch (err) {
    return `Tool ${name} failed: ${String(err.message || err).slice(0, 500)}`;
  }
}
