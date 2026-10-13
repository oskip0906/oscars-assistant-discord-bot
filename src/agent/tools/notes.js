import { configured } from '../../db.js';
import { redactSecrets } from '../../config.js';
import { findNotes, loadTree, folderPath, saveNote, createNote, openNote, windowMessages, MAX_BODY } from '../notes.js';
import { fileNameFor, noteFile, noteMessage } from '../../discord/notes.js';

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
  {
    type: 'function',
    function: {
      name: 'create_note',
      description:
        'Write something new and keep it in the shared notes, then post it here: as a file (.txt, .md, .csv, .json or any other text file) when a file is wanted or the text is long, or as a note card. Use it when someone asks you to make, write or export a file or document, or to write something down that is not just a summary of the chat (that is save_note). Everyone can find it later with search_notes or /open_note.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short, specific title, up to 80 characters.' },
          content: { type: 'string', description: 'The full text of the note or file, written out completely (Markdown for .md).' },
          description: { type: 'string', description: 'Optional: one line saying what it holds, up to 150 characters.' },
          file_name: { type: 'string', description: 'Optional: makes it a file sent as an attachment, e.g. "trip-plan.md", "todo.txt", "scores.csv". Leave it out for a plain note.' },
          show: { type: 'string', enum: ['file', 'card', 'both'], description: 'How to post it: the file, a note card, or both. Default: file when file_name is given, otherwise card.' },
        },
        required: ['title', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_note_file',
      description:
        'Send a saved note (or a file saved with create_note) back as a file attachment, by its title. Use it when someone asks for a note or saved file "as a file", "as .txt/.md", or to download or export it.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'The note title, or words from it.' },
          file_name: { type: 'string', description: 'Optional: the name to send it as, e.g. "notes.txt"; its extension sets the type. Default: its saved file name, or the title as .md.' },
        },
        required: ['title'],
      },
    },
  },
];

// Sent from the tool, so it skips the reply path: scrub it the same way.
const scrub = (note) => ({ ...note, body: redactSecrets(note.body) });

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

// Never throws: saves the note (when there is a database) and posts it as a
// file, a card or both. Not saved is said, but what was written is still posted.
export async function createNoteFromChat({ title = '', content = '', description = '', file_name: fileName = '', show } = {}, invocation) {
  const here = invocation.message;
  if (!here?.channel?.send) return 'I can only create notes and files in chat.';
  const text = String(content);
  if (!String(title).trim() || !text.trim()) return 'A note needs a title and its content.';
  const name = String(fileName).trim() ? fileNameFor(fileName, title) : null;
  const how = ['file', 'card', 'both'].includes(show) ? show : name ? 'file' : 'card';
  try {
    const firstLine = text.split('\n').find((l) => l.trim()).trim();
    let note = {
      title: String(title).trim().slice(0, 80),
      description: (String(description).trim() || firstLine).slice(0, 150),
      body: text.slice(0, MAX_BODY),
      author_id: here.author.id,
      file_name: name,
      created_at: new Date(),
    };
    let path = null;
    let problem = 'Notes are not set up (no database), so it was not saved.';
    if (configured(invocation.config)) {
      const saved = await createNote(invocation.config, { ...note, fileName: name, authorId: here.author.id });
      problem = saved.error ?? null;
      if (!saved.error) {
        path = saved.path;
        note = { ...note, ...saved.note };
      }
    }

    note = scrub(note);
    const files = how !== 'card' ? [noteFile(note, name)] : [];
    if (how === 'file') {
      await here.channel.send({ content: `📎 **${note.title}**`, files, allowedMentions: { parse: [] } });
    } else {
      const folders = path ? (await loadTree(invocation.config)).folders : [];
      const { embeds, rest } = noteMessage({ ...note, file_name: how === 'both' ? note.file_name || fileNameFor(null, note.title) : null }, folders);
      await here.channel.send({ embeds, files, allowedMentions: { parse: [] } });
      for (const part of rest) await here.channel.send({ content: part, allowedMentions: { parse: [] } });
    }
    invocation.posted = true;
    const posted = how === 'file' ? `the file ${files[0].name}` : how === 'both' ? `a card with the file ${files[0].name}` : 'a note card';
    return path
      ? `[NOTE CREATED — "${note.title}" saved in 📁 ${path.join(' / ')} and posted as ${posted}. Say it was made and saved (they can get it again with /open_note); do not repeat its content.]`
      : `[POSTED ${posted} — "${note.title}", but NOT saved: ${problem} Say so; do not repeat its content.]`;
  } catch (err) {
    console.error('[notes] create failed:', String(err.message || err).slice(0, 200));
    return `I couldn't create that note: ${String(err.message || err).slice(0, 150)}`;
  }
}

// Never throws: a saved note's text, sent back as a file.
export async function sendNoteFile({ title = '', file_name: fileName = '' } = {}, invocation) {
  const here = invocation.message;
  if (!here?.channel?.send) return 'I can only send files in chat.';
  if (!configured(invocation.config)) return 'Notes are not set up (no database), so there is no saved note to send.';
  try {
    const note = await openNote(invocation.config, String(title));
    if (!note) return `No note matches "${title}". Say so; do not make one up.`;
    const file = noteFile(scrub(note), String(fileName).trim() || null);
    await here.channel.send({ content: `📎 **${note.title}**`, files: [file], allowedMentions: { parse: [] } });
    invocation.posted = true;
    return `[FILE SENT — "${note.title}" as ${file.name}. Say it is attached; do not repeat its content.]`;
  } catch (err) {
    console.error('[notes] send file failed:', String(err.message || err).slice(0, 200));
    return `I couldn't send that file: ${String(err.message || err).slice(0, 150)}`;
  }
}
