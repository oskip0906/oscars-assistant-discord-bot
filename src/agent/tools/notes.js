import { configured } from '../../db.js';
import { findNotes, loadTree, folderPath, saveNote, windowMessages } from '../notes.js';

const MAX_TOOL_BODY = 3000;

export const defs = [
  {
    type: 'function',
    function: {
      name: 'search_notes',
      description:
        "Look something up in the shared notes people saved with /save_note: summaries of earlier conversations, organized in folders. Use it when someone asks about something that may have been written down (\"what did we note about…\", \"check the notes\"). Returns the best matching notes with their folder and full text.",
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'What to look for, in plain words.' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'save_note',
      description:
        'Summarize the recent conversation in this channel and save it as a shared note, the same as /save_note. Use it whenever someone asks you to summarize, note down, write up, jot down or keep track of what was said. It covers the last `minutes` (default 10): "the last hour" is 60; for "today" or "since 9am" count the minutes from then to now. Returns the note to share.',
      parameters: {
        type: 'object',
        properties: {
          minutes: { type: 'integer', description: 'How far back to cover, in minutes (default 10).' },
          topic: { type: 'string', description: 'Optional: what to focus on when there is a lot to cover, e.g. "the trip budget".' },
        },
      },
    },
  },
];

// Never throws: a refusal or failure is text the model can pass on.
export async function saveNoteFromChat({ minutes, topic = '' } = {}, invocation) {
  const here = invocation.message;
  if (!here?.channel?.messages) return 'I can only save a note from chat.';
  try {
    const messages = await windowMessages(here.channel, here.id, minutes);
    const saved = await saveNote(invocation.config, { messages, authorId: here.author.id, topic: String(topic) });
    if (saved.error) return saved.error;
    const { note } = saved;
    return `[NOTE SAVED — "${note.title}" in 📁 ${saved.path.join(' / ')}. Say it was saved (they can open it with /open_note) and share the summary.]\n${note.description}\n\n${note.body.slice(0, MAX_TOOL_BODY)}`;
  } catch (err) {
    console.error('[notes] save from chat failed:', String(err.message || err).slice(0, 200));
    return `I couldn't save that note: ${String(err.message || err).slice(0, 150)}`;
  }
}

// Never throws: a refusal or failure is text the model can pass on.
export async function searchNotes({ query = '' } = {}, invocation) {
  const { config } = invocation;
  if (!configured(config)) return 'Notes are not set up — answer without them.';
  if (!String(query).trim()) return 'Say what to look for in the notes.';
  try {
    const [found, { folders }] = await Promise.all([findNotes(config, query), loadTree(config)]);
    if (!found.length) return 'No saved note matches — answer without notes.';
    return [
      `[SAVED NOTES — ${found.length} best match(es) for "${query}"]`,
      ...found.map((n) => `--- 📁 ${folderPath(folders, n.folder_id).join(' / ')} › ${n.title} ---\n${n.description}\n${n.body.slice(0, MAX_TOOL_BODY)}`),
    ].join('\n\n');
  } catch (err) {
    console.error('[notes] search failed:', String(err.message || err).slice(0, 200));
    return 'The notes are unavailable right now — answer without them.';
  }
}
