import { configured } from '../../db.js';
import { findNotes, loadTree, folderPath } from '../notes.js';

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
];

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
