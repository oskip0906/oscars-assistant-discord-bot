import * as discordTools from './discord.js';
import * as searchTools from './search.js';
import * as githubTools from './github.js';
import * as rulesTools from './rules.js';
import * as uiTools from './ui.js';
import * as sourceTools from './source.js';
import * as musicTools from './music.js';
import * as voiceTools from './voice.js';
import * as historyTools from './history.js';
import * as aboutTools from './about.js';
import * as notesTools from './notes.js';
import * as commandTools from './commands.js';
import * as sandboxTools from './sandbox.js';
import * as modelInfoTools from './modelInfo.js';
import { githubMcpTools, callGithubMcpTool, isGithubMcpTool } from './githubMcp.js';

// Owner-only tools. Gated by the AUTHENTICATED Discord author id
// (invocation.isOwner) — never by anything a message could claim, so no one can
// impersonate Oscar into these. github is here because it acts with Oscar's
// PAT and could otherwise read/modify his private repos on a guest's behalf.
// set_model and private_mode are the tools behind the owner-only /set_model and
// /private, so chat can't do what the command refuses.
export const OWNER_ONLY_TOOLS = new Set(['self_fix', 'set_rule', 'add_rule', 'remove_rule', 'create_thread', 'send_to_thread', 'github', 'set_model', 'private_mode']);

// Tools that only read or look something up. A turn starts without them: the
// model answers from what it has, and calls need_more_info (agent.js) to get
// them only when it can't. Every GitHub MCP tool is a read too. Everything
// else does something (react, poll, reminder, music, self_fix…) and is offered
// as before.
export const LOOKUP_TOOLS = new Set([
  'web_search', 'web_fetch', 'image_search', 'reverse_image_search', 'video_search', 'news_search', 'wiki_search', 'research',
  'fetch_history', 'index_chat', 'search_notes', 'list_notes', 'open_note', 'show_reminders',
  'how_i_work', 'panda_commands', 'current_model', 'model_info', 'usage', 'server_info', 'get_user_id', 'get_message_sender',
]);
export const isLookup = (name) => LOOKUP_TOOLS.has(name) || isGithubMcpTool(name);

const modules = [discordTools, uiTools, searchTools, githubTools, rulesTools, sourceTools, musicTools, voiceTools, historyTools, aboutTools, notesTools, commandTools, modelInfoTools, sandboxTools];

const allDefs = modules.flatMap((m) => m.defs);

const executors = {
  get_user_id: discordTools.getUserId,
  get_message_sender: discordTools.getMessageSender,
  server_info: discordTools.serverInfo,
  react: discordTools.react,
  create_thread: discordTools.createThread,
  send_to_thread: discordTools.sendToThread,
  create_poll: uiTools.createPoll,
  send_card: uiTools.sendCard,
  web_search: searchTools.webSearch,
  web_fetch: searchTools.webFetch,
  image_search: searchTools.imageSearch,
  reverse_image_search: searchTools.reverseImageSearch,
  video_search: searchTools.videoSearch,
  news_search: searchTools.newsSearch,
  wiki_search: searchTools.wikiSearch,
  github: githubTools.githubApi,
  set_rule: rulesTools.setRule,
  add_rule: rulesTools.addRule,
  remove_rule: rulesTools.removeRule,
  self_fix: sourceTools.selfFix,
  play_music: musicTools.playMusic,
  voice: voiceTools.voiceTool,
  fetch_history: historyTools.fetchHistory,
  index_chat: historyTools.indexChat,
  how_i_work: aboutTools.howIWork,
  search_notes: notesTools.searchNotes,
  save_note: notesTools.saveNoteFromChat,
  create_note: notesTools.createNoteFromChat,
  send_note_file: notesTools.sendNoteFile,
  edit_note: notesTools.editNote,
  panda_commands: commandTools.pandaCommands,
  current_model: commandTools.currentModel,
  model_info: modelInfoTools.modelInfo,
  usage: commandTools.usage,
  set_model: commandTools.setModel,
  private_mode: commandTools.privateModeTool,
  research: commandTools.research,
  list_notes: commandTools.listNotes,
  open_note: commandTools.openNoteTool,
  delete_note: commandTools.deleteNoteTool,
  add_reminder: commandTools.addReminderTool,
  show_reminders: commandTools.showReminders,
  delete_reminder: commandTools.deleteReminderTool,
  sandbox: sandboxTools.sandboxTool,
};

const schemas = new Map(allDefs.map((d) => [d.function.name, d.function.parameters]));

const TYPE_OK = {
  string: (v) => typeof v === 'string',
  integer: (v) => Number.isInteger(v),
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  boolean: (v) => typeof v === 'boolean',
  array: (v) => Array.isArray(v),
  object: (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
};

// Checks the model's arguments against the tool's own schema before anything
// runs: an object, every required property present and non-empty, each given
// property of its declared type and in its enum. Two slips models often make
// are forgiven: a whole number sent as a string ("10") is taken as the number,
// and a lone string where a list goes as a one-item list. Returns the cleaned arguments, or
// { error } naming what to fix so the model can retry with valid ones.
export function validateArgs(name, args) {
  const schema = schemas.get(name);
  if (args == null) args = {};
  if (!TYPE_OK.object(args)) return { error: `Invalid arguments for ${name}: expected an object of named arguments.` };
  if (!schema) return { args };
  const props = schema.properties || {};
  const out = { ...args };
  const problems = [];
  for (const key of schema.required || []) {
    if (out[key] == null || (typeof out[key] === 'string' && !out[key].trim())) problems.push(`\`${key}\` is required`);
  }
  for (const [key, value] of Object.entries(out)) {
    const spec = props[key];
    if (!spec || value == null) continue;
    if (spec.type === 'integer' && typeof value === 'string' && /^-?\d+$/.test(value.trim())) out[key] = Number(value.trim());
    if (spec.type === 'array' && typeof value === 'string') out[key] = [value];
    if (spec.type && TYPE_OK[spec.type] && !TYPE_OK[spec.type](out[key])) problems.push(`\`${key}\` must be ${/^[aeiou]/.test(spec.type) ? 'an' : 'a'} ${spec.type}`);
    else if (spec.enum && !spec.enum.includes(out[key])) problems.push(`\`${key}\` must be one of ${spec.enum.join(', ')}`);
  }
  return problems.length ? { error: `Invalid arguments for ${name}: ${problems.join('; ')}. Nothing ran; call it again with valid arguments, or ask the person for what is missing.` } : { args: out };
}

// Async because the GitHub MCP tool list is fetched from GitHub's hosted server
// (once, then cached). It resolves to just the built-ins when that is off,
// unreachable, or the sender is not Oscar.
export async function toolDefs(invocation = {}) {
  return [...allDefs, ...(await githubMcpTools({ isOwner: invocation.isOwner, config: invocation.config }))];
}

export async function executeTool(name, args, invocation) {
  const fn = executors[name];
  // MCP tools are discovered at runtime, so they are not in `executors`. They
  // carry their own owner gate; the check below covers the static ones.
  if (!fn && isGithubMcpTool(name)) {
    try {
      return await callGithubMcpTool(name, args || {}, { isOwner: invocation.isOwner, config: invocation.config });
    } catch (err) {
      return `Tool ${name} failed: ${String(err.message || err).slice(0, 500)}`;
    }
  }
  if (!fn) return `Unknown tool: ${name}`;
  if (OWNER_ONLY_TOOLS.has(name) && !invocation.isOwner) {
    return `⛔ ${name} is restricted to Oscar (the owner). The current sender is not Oscar — politely refuse.`;
  }
  const checked = validateArgs(name, args);
  if (checked.error) return checked.error;
  try {
    const result = await fn(checked.args, invocation);
    // Tools may return a { text, embeds } object — feed the model the text
    // portion and stash any embeds on the invocation so the caller (chat path)
    // can send them alongside the reply, matching the slash-command path.
    if (result && typeof result === 'object' && result.text !== undefined) {
      if (result.embeds?.length && Array.isArray(invocation.embeds)) {
        invocation.embeds.push(...result.embeds);
      }
      return String(result.text);
    }
    const text = typeof result === 'string' ? result : JSON.stringify(result);
    // An empty result would let the model invent one.
    return text?.trim() ? text : `${name} returned nothing. Say so; do not make up a result.`;
  } catch (err) {
    return `Tool ${name} failed: ${String(err.message || err).slice(0, 500)}`;
  }
}
