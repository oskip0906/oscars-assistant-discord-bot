import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// Paths the sandbox may never read or write: git internals, dependencies,
// runtime data, secrets, and the workflow that runs the sandbox itself.
export const FORBIDDEN = /(^|\/)(\.git|node_modules|data)(\/|$)|(^|\/)\.env(?:\.|$)|^\.github\//i;

// A single read has to fit in a message. Anything larger is a lockfile or a
// blob, and reading it whole is never what the task needed.
const MAX_READ_CHARS = 60_000;

// Enough turns to look around, change several files, and check its work. The
// cap exists so a model that loops on read_file cannot burn the whole job.
const DEFAULT_MAX_STEPS = 40;

export const SYSTEM_PROMPT = [
  'You are an autonomous software engineer working directly in an isolated CI checkout of a repository.',
  '',
  'Work by calling tools. You cannot ask questions and nobody will answer you — decide for yourself which files to open and what to change.',
  'A normal task looks like: list_files or read_file to find the code, read every file you intend to change, write_file with its complete new contents, then finish.',
  '',
  'Rules:',
  '- ALWAYS read a file before writing it. Writing replaces the whole file, so guessing at contents you have not read destroys code.',
  '- write_file takes the COMPLETE new contents of the file, not a patch or a fragment.',
  '- Make the smallest correct change the task asks for. No unrelated edits, no drive-by refactors, no reformatting.',
  '- Match the surrounding code: its style, its naming, and its comment density.',
  '- Never touch secrets, .env files, data/, node_modules, .git, or .github.',
  '- Call finish only once the change is complete. Describing a change instead of writing it ships nothing.',
  '- If the task genuinely cannot be done safely, call finish and explain why in the description.',
].join('\n');

export const REPO_AGENT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'List the repository files you are allowed to work with. Optionally filter to paths containing a substring.',
      parameters: {
        type: 'object',
        properties: { contains: { type: 'string', description: "Only return paths containing this text, e.g. 'discord' or '.test.js'" } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read one file in full. Always read a file before writing it.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: "Repository-relative path, e.g. 'src/discord/menu.js'" } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create or replace a file with its COMPLETE new contents. Read it first unless you are creating it.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Repository-relative path' },
          content: { type: 'string', description: 'The entire new contents of the file' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_file',
      description: 'Delete a file from the repository.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Repository-relative path' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'finish',
      description: 'End the session once every edit is written. Do not call this before making the change.',
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: 'One line describing what changed' },
          description: { type: 'string', description: 'A detailed explanation of what changed and why' },
        },
        required: ['summary', 'description'],
      },
    },
  },
];

function validPath(file) {
  return typeof file === 'string' && file.length > 0 && file.length <= 300 && !file.startsWith('/') && !file.includes('..') && !FORBIDDEN.test(file);
}

// Every tool that touches disk goes through here, so the path rules are stated
// once and cannot be skipped by a new tool forgetting to call them.
export function createWorkspace(root, tracked = []) {
  const known = new Set(tracked.filter((file) => !FORBIDDEN.test(file)));
  const changed = [];

  const resolve = (file) => {
    if (!validPath(file)) return null;
    const destination = path.resolve(root, file);
    return destination === root || destination.startsWith(`${root}${path.sep}`) ? destination : null;
  };

  const record = (file) => {
    if (!changed.includes(file)) changed.push(file);
  };

  return {
    changed,
    list(contains) {
      const query = String(contains || '').toLowerCase();
      const paths = [...known].filter((file) => !query || file.toLowerCase().includes(query)).sort();
      if (!paths.length) return query ? `No files match "${contains}". Call list_files with no filter to see everything.` : 'The repository has no readable files.';
      return paths.join('\n');
    },
    read(file) {
      const destination = resolve(file);
      if (!destination) return `Refused: "${file}" is outside the files you may work with.`;
      let content;
      try {
        content = readFileSync(destination, 'utf8');
      } catch {
        return `No such file: ${file}. Call list_files to see what exists.`;
      }
      if (content.includes('\0')) return `${file} is a binary file and cannot be edited as text.`;
      return content.length > MAX_READ_CHARS
        ? `${content.slice(0, MAX_READ_CHARS)}\n\n[truncated at ${MAX_READ_CHARS} characters — this file is too large to rewrite whole; do not write_file it]`
        : content;
    },
    write(file, content) {
      const destination = resolve(file);
      if (!destination) return `Refused: "${file}" is outside the files you may work with.`;
      if (typeof content !== 'string') return `Refused: content for ${file} must be a string holding the complete file.`;
      // Rewriting a file whole, models routinely drop the trailing newline. Left
      // alone that puts "\ No newline at end of file" in the diff of every edit,
      // which is noise in a review and a change nobody asked for.
      let text = content;
      try {
        if (readFileSync(destination, 'utf8').endsWith('\n') && !text.endsWith('\n')) text += '\n';
      } catch {
        /* new file — take it exactly as written */
      }
      mkdirSync(path.dirname(destination), { recursive: true });
      writeFileSync(destination, text);
      known.add(file);
      record(file);
      return `Wrote ${file} (${text.length} characters).`;
    },
    remove(file) {
      const destination = resolve(file);
      if (!destination) return `Refused: "${file}" is outside the files you may work with.`;
      if (!existsSync(destination)) return `No such file: ${file}.`;
      rmSync(destination);
      known.delete(file);
      record(file);
      return `Deleted ${file}.`;
    },
  };
}

// Tool arguments arrive as a JSON string the model wrote by hand, so a stray
// fence or a trailing comma is a recoverable mistake, not a dead run.
function parseArgs(raw) {
  const text = String(raw || '{}').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(text || '{}');
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        /* reported to the model below */
      }
    }
    return null;
  }
}

const preview = (value, limit = 80) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);

// Drives the model through the checkout: it reads what it wants, writes what it
// decides to change, and says when it is done. Replaces asking for the whole
// repository up front and hoping one reply contains every finished file.
export async function runRepoAgent({ instruction, root, tracked = [], callModel, log = console.log, maxSteps = DEFAULT_MAX_STEPS }) {
  const workspace = createWorkspace(path.resolve(root), tracked);
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: [
        `Task: ${instruction}`,
        '',
        `The repository has ${tracked.length} file(s). Use list_files and read_file to find your way around — the contents are not included here, you fetch what you need.`,
      ].join('\n'),
    },
  ];

  let done = null;
  let idleReplies = 0;

  for (let step = 0; step < maxSteps && !done; step++) {
    const message = await callModel(messages, REPO_AGENT_TOOLS);
    const assistant = { role: 'assistant', content: message?.content ?? '' };
    if (message?.tool_calls?.length) assistant.tool_calls = message.tool_calls;
    messages.push(assistant);

    if (!message?.tool_calls?.length) {
      // Prose instead of a tool call. Say so once or twice; a model that will
      // not use the tools is not going to start on the fifth ask.
      if (++idleReplies > 2) break;
      log(`[sandbox] step ${step + 1}: no tool call — nudging (${preview(message?.content)})`);
      messages.push({ role: 'user', content: 'That changed nothing. Reply with tool calls only: read_file / write_file / delete_file, then finish when the edit is written.' });
      continue;
    }
    idleReplies = 0;

    for (const call of message.tool_calls) {
      const name = call.function?.name;
      const args = parseArgs(call.function?.arguments);
      let result;

      if (!args) {
        result = 'Your arguments were not valid JSON. Send the same call again with well-formed JSON.';
        log(`[sandbox] step ${step + 1}: ${name} — unparseable arguments`);
      } else if (name === 'list_files') {
        result = workspace.list(args.contains);
        log(`[sandbox] step ${step + 1}: list_files${args.contains ? ` contains="${preview(args.contains, 40)}"` : ''}`);
      } else if (name === 'read_file') {
        result = workspace.read(args.path);
        log(`[sandbox] step ${step + 1}: read ${args.path} (${result.length} chars)`);
      } else if (name === 'write_file') {
        result = workspace.write(args.path, args.content);
        log(`[sandbox] step ${step + 1}: write ${args.path} (${String(args.content ?? '').length} chars)`);
      } else if (name === 'delete_file') {
        result = workspace.remove(args.path);
        log(`[sandbox] step ${step + 1}: delete ${args.path}`);
      } else if (name === 'finish') {
        if (!workspace.changed.length) {
          // The old failure mode, now recoverable: it described the change
          // instead of writing it, and there is still time to do the work.
          result = 'You have not written any file yet, so nothing would change. Make the edit with write_file, then call finish.';
          log(`[sandbox] step ${step + 1}: finish rejected — no edits written yet`);
        } else {
          done = { summary: args.summary || 'Automated development change.', description: args.description || '' };
          result = 'Finished.';
          log(`[sandbox] step ${step + 1}: finish — ${preview(done.summary)}`);
        }
      } else {
        result = `Unknown tool "${name}". Available: list_files, read_file, write_file, delete_file, finish.`;
        log(`[sandbox] step ${step + 1}: unknown tool ${name}`);
      }

      messages.push({ role: 'tool', tool_call_id: call.id, content: String(result) });
    }
  }

  if (!workspace.changed.length) {
    throw new Error(
      done
        ? `The development model finished without changing anything. It said: ${done.description || done.summary}`
        : 'The development model never wrote a file. It read the repository but produced no edit.',
    );
  }

  return {
    summary: done?.summary || `Applied ${workspace.changed.length} file change(s).`,
    // A run that hit the step cap still has real edits on disk; say so in the
    // pull request rather than pretending it ended cleanly.
    description: done?.description || 'The model reached its step limit before summarising. The edits it had written are included.',
    changed: workspace.changed,
    completed: Boolean(done),
  };
}
