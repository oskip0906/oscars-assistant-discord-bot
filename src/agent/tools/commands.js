import { ApplicationCommandOptionType } from 'discord.js';
import { commandDefs, OWNER_ONLY_COMMANDS } from '../../discord/commandDefs.js';
import { switchModel } from '../../discord/model.js';
import { usageLines } from '../../discord/usage.js';
import { deleteNoteConfirm } from '../../discord/notes.js';
import { providerFor } from '../openrouter.js';
import { updatePresence } from '../../presence.js';
import { JEV_MODEL } from '../jev.js';
import { runResearch } from '../research/pipeline.js';
import { renderReport } from '../research/render.js';
import { loadTree, openNote, folderPath, noteChoices, shownBody, MAX_NOTE_BODY } from '../notes.js';
import { addReminder, activeReminders, reminderChoices, deleteReminder, repeatText } from '../../reminders.js';
import { configured } from '../../db.js';

// The slash commands as tools: what each command does, run in chat through the
// same functions the command calls, with the same owner checks. The commands'
// metadata is read from commandDefs, never restated here, so describing a
// command can't drift from what Discord shows.

export const defs = [
  {
    type: 'function',
    function: {
      name: 'panda_commands',
      description:
        "List your slash commands, or explain one: what it does, its options (required or not, allowed values), whether only Oscar may run it, and which tool does the same in chat. Read live from the registered commands. Use it whenever someone asks what commands you have, how to use one (\"how does /add_reminder work?\"), or what an option means — never describe a command from memory.",
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'One command name, with or without the slash, e.g. "add_reminder". Leave empty to list them all.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'current_model',
      description:
        'Report the AI model you are running on right now (the OpenRouter model id and pinned provider, as /model shows) and the Jev model that makes your quick decisions. Use it whenever someone asks which model or LLM you are, run on or use — never answer that from memory.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'usage',
      description: 'How much money you have spent on OpenRouter today, this week, this month and all-time, plus any budget left (the same as /usage).',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_model',
      description:
        'OWNER ONLY. Switch the conversation model you run on to another OpenRouter model id, optionally pinned to one provider (the same as /set_model). It is checked against OpenRouter, saved, and live at once. Only when Oscar explicitly asks to switch models.',
      parameters: {
        type: 'object',
        properties: {
          model: { type: 'string', description: 'Exact OpenRouter model id, e.g. "anthropic/claude-sonnet-5.5".' },
          provider: { type: 'string', description: 'Optional OpenRouter provider slug to pin it to, e.g. "deepinfra". Leave out for the default routing.' },
        },
        required: ['model'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'private_mode',
      description:
        'OWNER ONLY. Private mode, the same as /private: "on" makes you answer only Oscar, "off" answers everyone again, "status" tells which it is. Only when Oscar explicitly asks.',
      parameters: {
        type: 'object',
        properties: { state: { type: 'string', enum: ['on', 'off', 'status'], description: 'Turn it on, off, or check it.' } },
        required: ['state'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'research',
      description:
        'Deep research, the same as /research: plans sub-questions, reads many sources, keeps only claims the pages support, and returns a cited report. Takes one to ten minutes, so use it only when someone asks for research or a thorough, sourced report; a quick fact is web_search.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What to research, as a full question.' },
          depth: { type: 'string', enum: ['quick', 'normal', 'deep'], description: 'How hard to dig (default normal).' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_notes',
      description: 'List every saved note by folder, with each note’s one-line description (what /display_notes browses). Use it when someone asks what notes there are.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'open_note',
      description: 'Open one saved note by its title, or the closest match, and return its full text (the same as /open_note).',
      parameters: {
        type: 'object',
        properties: { title: { type: 'string', description: 'The note title, or words from it.' } },
        required: ['title'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_note',
      description:
        'Ask to delete one of the sender’s notes (Oscar may delete any), like /delete_note: posts a Delete / Keep it confirmation in the channel. Nothing is deleted until the sender clicks Delete, so never say the note is gone.',
      parameters: {
        type: 'object',
        properties: { title: { type: 'string', description: 'The note title, or words from it.' } },
        required: ['title'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_reminder',
      description:
        'Set a reminder for the sender, the same as /add_reminder: Panda pings them in this channel (a DM when set in DMs) once, or every day, week or month. `when` depends on `repeat` — once: "2026-10-20 18:30", daily: "18:30", weekly: "mon 18:30", monthly: "15 18:30" (24-hour time, in their timezone). Work out the exact date for "tomorrow" or "next Friday" from the current date.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'What to remind them about, up to 200 characters.' },
          repeat: { type: 'string', enum: ['once', 'daily', 'weekly', 'monthly'], description: 'Once, or how often.' },
          when: { type: 'string', description: 'The time in the format for `repeat` (see above).' },
          timezone: {
            type: 'string',
            description: 'IANA timezone such as "America/Toronto". Only needed the first time (it is then remembered); leave out unless they said where they are.',
          },
        },
        required: ['name', 'repeat', 'when'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'show_reminders',
      description: 'List every active reminder: what, whose, when next and how often (the same as /show_reminders).',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_reminder',
      description: 'Delete one of the sender’s reminders (Oscar may delete any), the same as /delete_reminder. Give its name; if several match, the tool lists them and deletes nothing.',
      parameters: {
        type: 'object',
        properties: { reminder: { type: 'string', description: 'The reminder’s name, or words from it.' } },
        required: ['reminder'],
      },
    },
  },
];

// Every slash command and how chat reaches it: `tool` is the tool that runs the
// same capability (`also`, a second tool for when an option is given), `gated`
// explains why chat can't. Every command must say one or the other.
export const COMMAND_TOOLS = {
  menu: { tool: 'panda_commands' },
  usage: { tool: 'usage' },
  model: { tool: 'current_model', also: 'model_info' },
  set_model: { tool: 'set_model' },
  play: { tool: 'play_music' },
  skip: { tool: 'play_music' },
  pause: { tool: 'play_music' },
  resume: { tool: 'play_music' },
  stop: { tool: 'play_music' },
  queue: { tool: 'play_music' },
  voice: { tool: 'voice' },
  web_search: { tool: 'web_search' },
  web_fetch: { tool: 'web_fetch' },
  image_search: { tool: 'image_search' },
  reverse_image_search: { tool: 'reverse_image_search' },
  video_search: { tool: 'video_search' },
  news_search: { tool: 'news_search' },
  wiki_search: { tool: 'wiki_search' },
  research: { tool: 'research' },
  self_fix: { tool: 'self_fix' },
  private: { tool: 'private_mode' },
  save_note: { tool: 'save_note' },
  display_notes: { tool: 'list_notes' },
  open_note: { tool: 'open_note' },
  delete_note: { tool: 'delete_note' },
  add_reminder: { tool: 'add_reminder' },
  show_reminders: { tool: 'show_reminders' },
  delete_reminder: { tool: 'delete_reminder' },
  set_rule: { tool: 'set_rule' },
  create_poll: { tool: 'create_poll' },
  create_card: { tool: 'send_card' },
  sandbox: { tool: 'sandbox' },
  clear: {
    gated:
      'It deletes messages for good and only Oscar may run it, so it is never run from chat: Oscar runs /clear himself, with a number or "all".',
  },
  index_channel: {
    gated:
      'It reads a whole channel (up to 10,000 messages) and only Oscar may start it, so it is never run from chat: Oscar runs /index_channel himself. To read around one old message, index_chat does that in chat.',
  },
};

const OPTION_TYPES = Object.fromEntries(Object.entries(ApplicationCommandOptionType).filter(([, v]) => typeof v === 'number').map(([k, v]) => [v, k.toLowerCase()]));
const bare = (name) => String(name ?? '').trim().replace(/^\//, '').toLowerCase();

function usageLine(cmd) {
  const opts = (cmd.options || []).map((o) => (o.required ? `<${o.name}>` : `[${o.name}]`));
  return `/${[cmd.name, ...opts].join(' ')}`;
}

function describeCommand(cmd) {
  const route = COMMAND_TOOLS[cmd.name];
  const lines = [`${usageLine(cmd)} — ${cmd.description}`];
  if (OWNER_ONLY_COMMANDS.has(cmd.name)) lines.push('Who: Oscar (the owner) only.');
  for (const o of cmd.options || []) {
    const limits = [
      o.required ? 'required' : 'optional',
      OPTION_TYPES[o.type] ?? 'value',
      o.choices?.length ? `one of: ${o.choices.map((c) => (c.name === c.value ? c.value : `${c.value} (${c.name})`)).join(', ')}` : null,
      o.min_value != null ? `min ${o.min_value}` : null,
      o.max_length != null ? `up to ${o.max_length} characters` : null,
      o.autocomplete ? 'suggestions appear as you type' : null,
    ].filter(Boolean);
    lines.push(`• ${o.name} (${limits.join(', ')}): ${o.description}`);
  }
  if (route?.tool) lines.push(`In chat: you can do this yourself with the \`${route.tool}\` tool when asked${route.also ? ` (and with the \`${route.also}\` tool when an option is given)` : ''}.`);
  else if (route?.gated) lines.push(`In chat: not available — ${route.gated}`);
  return lines.join('\n');
}

export function pandaCommands({ command = '' } = {}, _invocation, { defsList = commandDefs } = {}) {
  const want = bare(command);
  if (want) {
    const cmd = defsList.find((c) => c.name === want);
    if (cmd) return describeCommand(cmd);
    return `There is no /${want} command. The commands are: ${defsList.map((c) => `/${c.name}`).join(', ')}.`;
  }
  return [
    `[SLASH COMMANDS — ${defsList.length}, read from the registered commands. Options in <> are required, [] optional.]`,
    ...defsList.map((c) => `${usageLine(c)} — ${c.description}${OWNER_ONLY_COMMANDS.has(c.name) ? ' [Oscar only]' : ''}`),
  ].join('\n');
}

export function currentModel(_args, invocation) {
  const { config } = invocation;
  const provider = providerFor(config, config.model);
  return [
    `Conversation model (runtime setting): ${config.model}`,
    `Provider: ${provider || 'OpenRouter default routing'}`,
    `Decision model (Jev): ${JEV_MODEL}`,
    'Oscar changes the conversation model with /set_model.',
  ].join('\n');
}

export async function usage(_args, invocation, { lines = usageLines } = {}) {
  const found = await lines(invocation.config);
  if (!found) return 'OpenRouter did not answer, so the spend is unknown right now. Say so; do not guess numbers.';
  return `[SPEND, from OpenRouter]\n${found.join('\n').replace(/\*\*/g, '')}`;
}

export async function setModel({ model, provider = '' } = {}, invocation, { switchImpl = switchModel } = {}) {
  const result = await switchImpl({ model, provider, config: invocation.config });
  return result.ok ? result.summary : `${result.summary}\n(The switch did not happen; say so.)`;
}

export async function privateModeTool({ state } = {}, invocation) {
  const mode = invocation.privateMode;
  if (!mode) return 'Private mode is unavailable here.';
  if (state === 'status') return `Private mode is ${mode.isOn() ? 'ON' : 'OFF'}.`;
  const saved = await mode.set(state === 'on');
  if (!saved.ok) return `${saved.error}\nPrivate mode is still ${saved.on ? 'ON' : 'OFF'}. (The switch did not happen; say so.)`;
  updatePresence(invocation.client, mode);
  return state === 'on'
    ? 'Private mode is now ON: from the next message on, only Oscar gets answers.'
    : 'Private mode is now OFF: everyone gets answers again.';
}

export async function research({ query, depth = 'normal' } = {}, invocation, { run = runResearch, render = renderReport } = {}) {
  const report = await run({ query: String(query), depth, config: invocation.config });
  return render(report);
}

const notesDown = 'Notes are not set up (no database), so there are none to show.';

export async function listNotes(_args, invocation) {
  const { config } = invocation;
  if (!configured(config)) return notesDown;
  const { folders, notes } = await loadTree(config);
  if (!notes.length) return 'There are no saved notes yet. They can save one with /save_note, or by asking you to.';
  const lines = notes.map((n) => `📁 ${folderPath(folders, n.folder_id).join(' / ') || 'Unsorted'} › ${n.title} — ${n.description}`);
  return `[SAVED NOTES — ${notes.length}]\n${lines.join('\n')}`;
}

export async function openNoteTool({ title } = {}, invocation) {
  const { config } = invocation;
  if (!configured(config)) return notesDown;
  const note = await openNote(config, String(title));
  if (!note) return `No note matches "${title}". Say so; do not make one up.`;
  const { folders } = await loadTree(config);
  return `[NOTE — "${note.title}" in 📁 ${folderPath(folders, note.folder_id).join(' / ') || 'Unsorted'}, by user id:${note.author_id}${note.file_name ? `, a file: ${note.file_name} (send_note_file sends it)` : ''}]\n${note.description}\n\n${shownBody(note.body, MAX_NOTE_BODY)}`;
}

// The same confirmation /delete_note shows: the click handler checks again that
// whoever presses Delete wrote the note (or is Oscar), so posting it is safe.
export async function deleteNoteTool({ title } = {}, invocation) {
  const { config, message } = invocation;
  if (!configured(config)) return notesDown;
  if (!message?.channel?.send) return 'Notes can only be deleted from chat.';
  const userId = message.author.id;
  const wanted = String(title).trim();
  // Only among the sender's own notes (all of them for Oscar), so a guest can't
  // even get a card for someone else's note.
  const mine = await noteChoices(config, wanted, invocation.isOwner ? null : userId);
  const exact = mine.find((n) => n.title.toLowerCase() === wanted.toLowerCase());
  const note = exact ?? (mine.length === 1 ? mine[0] : null);
  if (!note) {
    return mine.length
      ? `Several of their notes match "${wanted}": ${mine.slice(0, 10).map((n) => `"${n.title}"`).join(', ')}. Ask which one; nothing was deleted.`
      : `They have no note matching "${wanted}" (only the author or Oscar can delete a note). Nothing was deleted.`;
  }
  await message.channel.send({ ...deleteNoteConfirm(note), allowedMentions: { parse: [] } });
  invocation.posted = true;
  return `Posted a Delete / Keep it confirmation for "${note.title}". It is NOT deleted yet: it goes only when they click Delete.`;
}

export async function addReminderTool({ name, repeat, when, timezone } = {}, invocation) {
  const { config, message, guild } = invocation;
  if (!message?.author) return 'Reminders can only be set from chat.';
  const added = await addReminder(config, {
    userId: message.author.id,
    channelId: guild ? message.channel?.id ?? null : null,
    name,
    repeat,
    when,
    timezone: timezone || null,
  });
  if (added.error) {
    return `Not set: ${added.error.replace('Run the command again with the `timezone` option (start typing your city)', 'Ask them for their timezone or city')}`;
  }
  return `Reminder set: "${added.name}", ${repeatText(added)}. First one ${new Date(added.next_at).toISOString().slice(0, 16).replace('T', ' ')} UTC; ${guild ? 'Panda will ping them in this channel' : 'Panda will DM them'}.`;
}

export async function showReminders(_args, invocation) {
  const { config } = invocation;
  if (!configured(config)) return 'Reminders are not set up (no database), so there are none.';
  const rows = await activeReminders(config);
  if (!rows.length) return 'There are no active reminders.';
  return [
    `[ACTIVE REMINDERS — ${rows.length}]`,
    ...rows.slice(0, 25).map((r) => `- "${r.name}" for user id:${r.user_id} — next ${new Date(r.next_at).toISOString().slice(0, 16).replace('T', ' ')} UTC, ${repeatText(r)}`),
  ].join('\n');
}

export async function deleteReminderTool({ reminder } = {}, invocation) {
  const { config, message, isOwner } = invocation;
  if (!configured(config)) return 'Reminders are not set up (no database).';
  const userId = message?.author?.id;
  if (!userId) return 'Reminders can only be deleted from chat.';
  const wanted = String(reminder).trim();
  const mine = (await reminderChoices(config, wanted, userId, isOwner)).filter((r) => r.active);
  const exact = mine.filter((r) => r.name.toLowerCase() === wanted.toLowerCase());
  const pick = exact.length === 1 ? exact[0] : mine.length === 1 ? mine[0] : null;
  if (!pick) {
    return mine.length
      ? `Several of their reminders match "${wanted}": ${mine.slice(0, 10).map((r) => `"${r.name}"`).join(', ')}. Ask which one; nothing was deleted.`
      : `They have no active reminder matching "${wanted}" (only its creator or Oscar can delete one). Nothing was deleted.`;
  }
  const removed = await deleteReminder(config, Number(pick.id), userId, isOwner);
  return removed ? `Deleted the reminder "${removed}".` : 'That reminder is already gone, or it is not theirs to delete. Nothing was deleted.';
}
