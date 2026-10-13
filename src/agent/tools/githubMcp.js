import { McpClient, toOpenRouterTools } from '../mcp.js';
import { config as botConfig } from '../../config.js';

// GitHub's hosted MCP server, read-only path. The chat agent answers questions
// about repositories; it has no business writing to them, and /readonly is a
// server-side guarantee rather than a promise made in a prompt.
export const GITHUB_MCP_READONLY_URL = 'https://api.githubcopilot.com/mcp/readonly';

// Built-ins win a name clash. An MCP tool called web_search would otherwise
// shadow ours in the executor lookup and silently break a working tool.
const RESERVED = new Set([
  'get_user_id', 'get_message_sender', 'react', 'create_poll', 'send_card', 'web_search', 'web_fetch', 'image_search',
  'video_search', 'news_search', 'wiki_search',
  'github', 'set_rule', 'self_fix', 'play_music',
  'fetch_history', 'index_chat', 'how_i_work', 'search_notes', 'create_note', 'send_note_file',
]);

// ponytail: one cached promise for the process lifetime. A server that is down
// at boot stays off until restart; add a cooldown-and-retry if that bites.
let loading = null;
let names = new Set();

export function resetGithubMcp() {
  loading = null;
  names = new Set();
}

// The default toolsets plus actions, which the self-fix monitor reads runs from.
export const GITHUB_MCP_TOOLSETS = 'default,actions';

function makeClient(config) {
  return new McpClient({
    url: config.githubMcpReadOnlyUrl || GITHUB_MCP_READONLY_URL,
    headers: { Authorization: `Bearer ${config.githubPat}`, 'X-MCP-Toolsets': GITHUB_MCP_TOOLSETS },
    name: 'panda-bot',
  });
}

// Every GitHub read the bot makes in code goes through here, so reads share the
// read-only server's guarantee; only writes (commits, dispatches) use REST.
// Resolves to the raw tools/call result; a tool error rejects.
export async function githubRead(name, args, { config = botConfig, client } = {}) {
  if (!config?.githubPat) throw new Error('GITHUB_PAT is not set');
  const result = await (client || makeClient(config)).callToolResult(name, args);
  const text = (result?.content || []).filter((part) => part.type === 'text').map((part) => part.text).join('\n');
  if (result?.isError) throw new Error(`GitHub MCP ${name}: ${text.slice(0, 200) || 'failed'}`);
  return { result, text };
}

// For the tools that answer with one JSON document in a text part.
export async function githubReadJson(name, args, options) {
  return JSON.parse((await githubRead(name, args, options)).text);
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
