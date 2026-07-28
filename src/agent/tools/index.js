import * as discordTools from './discord.js';
import * as searchTools from './search.js';
import * as githubTools from './github.js';
import * as contextTools from './context.js';
import * as sourceTools from './source.js';
import * as musicTools from './music.js';

// Owner-only tools. Gated by the AUTHENTICATED Discord author id
// (invocation.isOwner) — never by anything a message could claim, so no one can
// impersonate Oscar into these. github is here because it acts with Oscar's
// PAT and could otherwise read/modify his private repos on a guest's behalf.
export const OWNER_ONLY_TOOLS = new Set(['self_fix', 'clear_all_context', 'github', 'create_pr']);

const modules = [discordTools, searchTools, githubTools, contextTools, sourceTools, musicTools];

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
  create_pr: githubTools.createPr,
  clear_context: contextTools.clearContext,
  clear_all_context: contextTools.clearAllContext,
  self_fix: sourceTools.selfFix,
  play_music: musicTools.playMusic,
};

export function toolDefs() {
  return allDefs;
}

export async function executeTool(name, args, invocation) {
  const fn = executors[name];
  if (!fn) return `Unknown tool: ${name}`;
  if (OWNER_ONLY_TOOLS.has(name) && !invocation.isOwner) {
    return `⛔ ${name} is restricted to Oscar (the owner). The current sender is not Oscar — politely refuse.`;
  }
  try {
    const result = await fn(args || {}, invocation);
    // Tools may return a { text, embeds } object — feed the model the text
    // portion and stash any embeds on the invocation so the caller (chat path)
    // can send them alongside the reply, matching the slash-command path.
    if (result && typeof result === 'object' && result.text !== undefined) {
      if (result.embeds?.length && Array.isArray(invocation.embeds)) {
        invocation.embeds.push(...result.embeds);
      }
      return String(result.text);
    }
    return typeof result === 'string' ? result : JSON.stringify(result);
  } catch (err) {
    return `Tool ${name} failed: ${String(err.message || err).slice(0, 500)}`;
  }
}
