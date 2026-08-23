import { McpClient, toOpenRouterTools } from '../mcp.js';
import { config as botConfig } from '../../config.js';

// GitHub's hosted MCP server, read-only path. The chat agent answers questions
// about repositories; it has no business writing to them, and /readonly is a
// server-side guarantee rather than a promise made in a prompt.
export const GITHUB_MCP_READONLY_URL = 'https://api.githubcopilot.com/mcp/readonly';

// Built-ins win a name clash. An MCP tool called web_search would otherwise
// shadow ours in the executor lookup and silently break a working tool.
const RESERVED = new Set([
  'get_user_id', 'get_message_sender', 'react', 'web_search', 'web_fetch', 'image_search',
  'vault_fetch', 'github', 'create_pr', 'clear_context', 'clear_all_context', 'self_fix', 'play_music',
]);

// ponytail: one cached promise for the process lifetime. A server that is down
// at boot stays off until restart; add a cooldown-and-retry if that bites.
let loading = null;
let names = new Set();

export function resetGithubMcp() {
  loading = null;
  names = new Set();
}

function makeClient(config) {
  return new McpClient({
    url: config.githubMcpReadOnlyUrl || GITHUB_MCP_READONLY_URL,
    headers: { Authorization: `Bearer ${config.githubPat}` },
    name: 'panda-bot',
  });
}

function enabled(config) {
  return Boolean(config?.githubPat) && config?.githubMcpEnabled !== false;
}

// Owner-only, for the same reason the `github` tool is: it acts with Oscar's
// PAT and would otherwise read his private repositories for a guest.
export async function githubMcpTools({ isOwner, config = botConfig, client } = {}) {
  if (!isOwner || !enabled(config)) return [];

  loading ??= (async () => {
    const tools = await (client || makeClient(config)).listTools();
    const usable = tools.filter((tool) => tool?.name && !RESERVED.has(tool.name));
    names = new Set(usable.map((tool) => tool.name));
    return toOpenRouterTools(usable);
  })().catch((err) => {
    // GitHub being unreachable is not a reason for Panda to stop answering.
    console.error('[github-mcp] tool list unavailable:', String(err.message || err).slice(0, 200));
    return [];
  });

  return loading;
}

export function isGithubMcpTool(name) {
  return names.has(name);
}

export async function callGithubMcpTool(name, args, { isOwner, config = botConfig, client } = {}) {
  if (!isOwner) return `⛔ ${name} is restricted to Oscar (the owner). The current sender is not Oscar — politely refuse.`;
  if (!enabled(config)) return `${name} is unavailable: GitHub access is not configured.`;
  return (client || makeClient(config)).callTool(name, args);
}
