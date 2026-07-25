import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { chatCompletion } from '../openrouter.js';
import { config } from '../../config.js';
// import { restart } from '../../index.js'; // No direct restart function in index.js, rely on process exit

export const defs = [
  {
    type: 'function',
    function: {
      name: 'self_fix',
      description:
        'OWNER ONLY. Fix or change YOUR OWN source code. Hands the instruction to the OpenRouter model, which reads and rewrites files inside the panda-bot project folder, then commits & pushes the edits to GitHub and restarts the bot to apply the change. Describe WHAT should change; the model does the editing. Takes a bit — warn the user it may be slow.',
      parameters: {
        type: 'object',
        properties: {
          instruction: { type: 'string', description: 'What to change/fix about the bot' },
        },
        required: ['instruction'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_push',
      description:
        "OWNER ONLY. Push YOUR OWN local source changes to GitHub using real git (add + commit + push), NOT the GitHub REST API. This is the correct tool for any request like 'push changes to github', 'commit and push my source', or 'save my code'. It stages every change in the panda-bot project, commits with your message, and pushes to the configured origin remote on the current branch. Do NOT use the `github` REST tool to create commits — that endpoint does not exist and 404s.",
      parameters: {
        type: 'object',
        properties: {
          message: {
            type: 'string',
            description: 'Commit message (defaults to a generic one if omitted). Only used when there are staged changes.',
          },
        },
      },
    },
  },
];

// --- self_fix: an OpenRouter-driven file-editing agent -------------------
//
// The model is given a tiny sandboxed toolset (list_files / read_file /
// write_file / finish) scoped to the project root. It reads the relevant
// source, rewrites whole files, and signals completion. We then run
// `node --check` on every changed .js file, commit + push, and restart.

const MAX_FIX_ITERATIONS = 40;
const MAX_FILE_BYTES = 200 * 1024;

// Directories/files the self-fix agent must never read or write. .env holds
// secrets; data/ is runtime state; node_modules/.git are not source.
const BLOCKED = ['.env', 'data', 'node_modules', '.git'];

// Resolve a model-supplied relative path safely inside the project root.
// Returns null for anything that escapes the root or touches a blocked path.
function safeResolve(root, rel) {
  if (typeof rel !== 'string' || !rel.trim()) return null;
  const clean = rel.replace(/^\.\/+/, '').replace(/^\/+/, '');
  const abs = path.resolve(root, clean);
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (abs !== root && !abs.startsWith(rootWithSep)) return null;
  const relFromRoot = path.relative(root, abs);
  const top = relFromRoot.split(path.sep)[0];
  if (BLOCKED.includes(top) || BLOCKED.includes(relFromRoot)) return null;
  return abs;
}

// Recursively list source-ish files under root, skipping blocked dirs.
function listSourceFiles(root, dir = root, acc = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const ent of entries) {
    if (BLOCKED.includes(ent.name)) continue;
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      listSourceFiles(root, abs, acc);
    } else if (ent.isFile()) {
      acc.push(path.relative(root, abs));
    }
  }
  return acc;
}

const fixToolDefs = [
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'List every source file (paths relative to the project root).',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a source file. Path is relative to the project root.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Relative file path, e.g. src/agent/agent.js' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description:
        'Create or overwrite a source file with the FULL new contents. Path is relative to the project root. Always write the complete file, never a diff.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative file path' },
          content: { type: 'string', description: 'The complete new file contents' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'finish',
      description: 'Call when the change is complete. Provide a short summary of what you changed.',
      parameters: {
        type: 'object',
        properties: { summary: { type: 'string', description: 'What you changed and why' } },
        required: ['summary'],
      },
    },
  },
];

// `node --check` one file. Resolves to null on success or an error string.
function nodeCheck(file, cwd) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ['--check', file],
      { cwd, timeout: 30 * 1000, maxBuffer: 4 * 1024 * 1024 },
      (err, _stdout, stderr) => {
        if (err) return resolve((stderr || err.message || 'syntax error').trim().slice(0, 1500));
        resolve(null);
      },
    );
  });
}

// Drive the OpenRouter model through the sandboxed edit loop. Never throws —
// resolves to { summary, changed: string[], log: string[] }.
async function runOpenRouterFix({ root, instruction }) {
  const changed = new Set();
  const log = [];
  const system = [
    'You are a senior Node.js engineer editing the LIVE source of "panda-bot", a Discord AI agent.',
    'It is a plain ESM Node app; entry point src/index.js MUST stay bootable.',
    'Work ONLY through the provided tools. Explore with list_files/read_file, then apply changes with write_file (always the COMPLETE file contents).',
    'Hard rules:',
    '- NEVER read or write .env (secrets) or anything under data/ (runtime state) — those are blocked anyway.',
    '- Keep everything valid ESM. After you are confident the change is correct and self-consistent, call finish with a short summary.',
    'Make the smallest correct change that satisfies the task. Do not rewrite unrelated code.',
  ].join('\n');

  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: `Task from Oscar: ${instruction}` },
  ];

  for (let i = 0; i < MAX_FIX_ITERATIONS; i++) {
    let msg;
    try {
      msg = await chatCompletion({
        apiKey: config.openrouterApiKey,
        model: config.model,
        messages,
        tools: fixToolDefs,
      });
    } catch (err) {
      return { summary: `⚠️ self_fix model call failed: ${String(err.message || err).slice(0, 300)}`, changed: [...changed], log };
    }

    const assistant = { role: 'assistant', content: msg.content ?? '' };
    if (msg.tool_calls?.length) assistant.tool_calls = msg.tool_calls;
    messages.push(assistant);

    if (!msg.tool_calls?.length) {
      // No tool call and no finish — treat the text as the summary and stop.
      return { summary: (msg.content || '').trim() || '(model stopped without a summary)', changed: [...changed], log };
    }

    let finished = null;
    for (const call of msg.tool_calls) {
      const name = call.function?.name;
      let args = {};
      try {
        args = JSON.parse(call.function?.arguments || '{}');
      } catch {
        /* leave args empty */
      }
      let result;
      if (name === 'list_files') {
        result = listSourceFiles(root).sort().join('\n') || '(no files)';
      } else if (name === 'read_file') {
        const abs = safeResolve(root, args.path);
        if (!abs) result = `❌ Refused: ${args.path} is outside the project or a protected path.`;
        else {
          try {
            result = fs.readFileSync(abs, 'utf8');
            if (result.length > MAX_FILE_BYTES) {
              result = `❌ Refused: ${args.path} is too large (${result.length} bytes).`;
            }
          } catch (err) {
            result = `❌ Read failed: ${err.message}`;
          }
        }
      } else if (name === 'write_file') {
        const abs = safeResolve(root, args.path);
        if (!abs) {
          result = `❌ Refused: ${args.path} is outside the project or a protected path.`;
        } else {
          try {
            fs.writeFileSync(abs, args.content, 'utf8');
            changed.add(path.relative(root, abs));
            result = `✅ Wrote ${args.path}.`;
          } catch (err) {
            result = `❌ Write failed: ${err.message}`;
          }
        }
      } else if (name === 'finish') {
        finished = args.summary;
        result = `✅ Self-fix complete: ${args.summary}`;
      } else {
        result = `❌ Unknown tool: ${name}`;
      }
      const toolMsg = {
        role: 'tool',
        tool_call_id: call.id,
        content: String(result).slice(0, TOOL_RESULT_CAP),
      };
      messages.push(toolMsg);
    }
    if (finished) return { summary: finished, changed: [...changed], log };
  }
  return { summary: '⚠️ Reached MAX_FIX_ITERATIONS', changed: [...changed], log };
}

function runGit(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: 30 * 1000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`git ${args[0]} failed: ${stderr || stdout || err.message}`));
      resolve(stdout);
    });
  });
}

async function performGitPush(message) {
  const cwd = config.projectRoot;

  // Stage all changes
  await runGit(cwd, ['add', '.']);

  // Check if there are any staged changes to commit
  const status = await runGit(cwd, ['status', '--porcelain']);
  if (!status.trim()) {
    return 'No changes to commit or push.';
  }

  // Commit
  const commitMessage = message || `self_fix: automated commit at ${new Date().toLocaleString()}`;
  await runGit(cwd, ['commit', '-m', commitMessage]);

  // Push
  await runGit(cwd, ['push']);
  return `Successfully committed and pushed changes: ${commitMessage}`;
}

export async function selfFix(args, invocation) {
  config.isSelfFixInProgress = true;
  const log = [];
  try {
    log.push('Starting self-fix operation...');
    // Run the OpenRouter fix agent
    const { summary, changed, log: fixLog } = await runOpenRouterFix({
      root: config.projectRoot,
      instruction: args.instruction,
    });
    log.push(...fixLog);

    if (changed.length) {
      log.push(`Changed files: ${changed.join(', ')}`);

      // Validate changed JS files with node --check
      const jsFiles = changed.filter((f) => f.endsWith('.js'));
      for (const file of jsFiles) {
        log.push(`Checking ${file} with node --check...`);
        const error = await nodeCheck(path.join(config.projectRoot, file), config.projectRoot);
        if (error) {
          log.push(`❌ ${file} failed node --check:\n${error}`);
          return `Self-fix completed with changes, but validation failed for ${file}:\n${error}\nNo changes were committed or pushed.`;
        }
        log.push(`✅ ${file} passed node --check.`);
      }

      // Commit and push changes
      log.push('Committing and pushing changes...');
      const pushResult = await performGitPush(`self_fix: ${summary}`);
      log.push(pushResult);
      log.push('Self-fix complete. Exiting process to allow for restart.');
      process.exit(0); // Exit process to trigger a restart by a process manager
      return `Self-fix successful! ${summary}\nChanges committed, pushed, and bot is restarting.`;
    } else {
      log.push('No files were changed by the self-fix process.');
      return `Self-fix completed with no changes: ${summary}`;
    }
  } catch (err) {
    log.push(`Self-fix encountered a critical error: ${err.message}`);
    return `Self-fix failed: ${err.message}`;
  } finally {
    config.isSelfFixInProgress = false;
    console.log(`Self-fix operation finished. Log:\n${log.join('\n')}`);
  }
}

export async function gitPush(args) {
  try {
    const pushResult = await performGitPush(args.message);
    return pushResult;
  } catch (err) {
    return `Git push failed: ${err.message}`;
  }
}
