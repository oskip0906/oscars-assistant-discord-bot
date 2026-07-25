import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { chatCompletion } from '../openrouter.js';

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
async function runOpenRouterFix({ root, instruction, config }) {
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
            result = fs.readFileSync(abs, 'utf8').slice(0, MAX_FILE_BYTES);
          } catch (err) {
            result = `❌ Could not read ${args.path}: ${String(err.message || err).slice(0, 200)}`;
          }
        }
      } else if (name === 'write_file') {
        const abs = safeResolve(root, args.path);
        if (!abs) result = `❌ Refused: ${args.path} is outside the project or a protected path.`;
        else if (typeof args.content !== 'string') result = '❌ write_file needs a string `content`.';
        else {
          try {
            fs.mkdirSync(path.dirname(abs), { recursive: true });
            fs.writeFileSync(abs, args.content);
            const rel = path.relative(root, abs);
            changed.add(rel);
            log.push(`wrote ${rel} (${args.content.length} bytes)`);
            result = `✅ Wrote ${rel}.`;
            if (rel.endsWith('.js')) {
              const err = await nodeCheck(rel, root);
              result += err ? `\n⚠️ node --check FAILED — fix it:\n${err}` : '\n✅ node --check passed.';
            }
          } catch (err) {
            result = `❌ Could not write ${args.path}: ${String(err.message || err).slice(0, 200)}`;
          }
        }
      } else if (name === 'finish') {
        finished = String(args.summary || '').trim() || '(no summary)';
        result = '✅ Done.';
      } else {
        result = `Unknown tool: ${name}`;
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content: String(result).slice(0, 8000) });
    }

    if (finished !== null) return { summary: finished, changed: [...changed], log };
  }

  return { summary: '⚠️ self_fix hit its edit-iteration limit before finishing.', changed: [...changed], log };
}

// Run one git subcommand in cwd. Never rejects — resolves to {code, stdout, stderr}.
function git(args, cwd, timeoutMs = 60 * 1000) {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ''}` },
      },
      (err, stdout, stderr) => {
        resolve({ code: err?.code ?? (err ? 1 : 0), stdout: stdout || '', stderr: stderr || '' });
      },
    );
  });
}

// Stage everything, commit (if there's anything to commit), and push to origin
// on the current branch using traditional git. Auth: Oscar's PAT is attached as
// an ephemeral HTTP Authorization header via `-c http.extraHeader=…` so it is
// never written into .git/config or the remote URL. Falls back to whatever git
// credentials are already configured when no PAT is set.
//
// Never throws — returns a human-readable summary string suitable for a tool
// result. Reads the repo's actual origin remote, so it works regardless of the
// GitHub repo name (the old REST call hardcoded the wrong repo and 404'd).
export async function pushSource({ root, message, pat }) {
  const inside = await git(['rev-parse', '--is-inside-work-tree'], root);
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') {
    return `❌ ${root} is not a git repository — cannot push. (${inside.stderr.trim() || 'no origin'})`;
  }

  const branchRes = await git(['rev-parse', '--abbrev-ref', 'HEAD'], root);
  const branch = branchRes.stdout.trim() || 'HEAD';

  await git(['add', '-A'], root);

  const staged = await git(['diff', '--cached', '--name-only'], root);
  const changedFiles = staged.stdout.split('\n').map((s) => s.trim()).filter(Boolean);

  if (changedFiles.length) {
    const commit = await git(['commit', '-m', message || 'panda-bot: update source'], root);
    if (commit.code !== 0) {
      return `❌ git commit failed:\n${(commit.stderr || commit.stdout).slice(0, 1500)}`;
    }
  }

  // Auth for the push:
  //  * `-c credential.helper=` clears any inherited helper (e.g. macOS
  //    osxkeychain), so a STALE cached credential can't override the PAT.
  //  * `-c http.extraHeader=Authorization: Basic …` supplies the PAT as HTTP
  //    basic auth (username is ignored by GitHub for token auth), keeping the
  //    secret out of .git/config and the remote URL.
  // With no PAT we fall back to whatever git credentials are already configured.
  const authArgs = pat
    ? [
        '-c',
        'credential.helper=',
        '-c',
        `http.extraHeader=Authorization: Basic ${Buffer.from(`x-access-token:${pat}`).toString('base64')}`,
      ]
    : [];
  const push = await git([...authArgs, 'push', 'origin', 'HEAD'], root);
  if (push.code !== 0) {
    const raw = (push.stderr || push.stdout);
    const detail = (pat ? raw.split(pat).join('***') : raw).slice(0, 1500);
    // A 403 AFTER the token authenticates (GitHub names the account in the
    // error) means the PAT lacks write access — for a fine-grained token that
    // is a missing "Contents: Read and write" permission or a repo not in its
    // scope. The repo's API `permissions` shows Oscar's USER role, so it can
    // look like write access even when the token itself can't push.
    const permHint = /403|denied|permission/i.test(raw)
      ? '\n\nℹ️ The token authenticated but was denied write. Give the GitHub PAT "Contents: Read and write" permission (fine-grained) — or "repo" scope (classic) — and make sure this repository is in its scope, then retry.'
      : '';
    return `❌ git push failed on branch ${branch}:\n${detail}${permHint}`;
  }

  const summary =
    push.stderr.trim() || push.stdout.trim() || 'up to date';
  if (!changedFiles.length) {
    return `✅ Nothing new to commit on ${branch}; pushed any pending commits.\n${summary.slice(0, 800)}`;
  }
  return `✅ Committed ${changedFiles.length} file(s) and pushed to origin/${branch}.\nFiles: ${changedFiles.slice(0, 20).join(', ')}${changedFiles.length > 20 ? ' …' : ''}\n${summary.slice(0, 800)}`;
}

export async function gitPush({ message }, invocation) {
  return pushSource({
    root: invocation.config.projectRoot,
    message,
    pat: invocation.config.githubPat,
  });
}

export async function selfFix({ instruction }, invocation) {
  const root = invocation.config.projectRoot;
  await invocation.message.channel
    .send(`🛠️ Self-fix starting in \`${root}\` — the model is editing my source; I'll commit, push, and restart once it's done…`)
    .catch(() => {});

  const fix = await runOpenRouterFix({ root, instruction, config: invocation.config });

  // Nothing was written → don't commit/push/restart; report and stop.
  if (!fix.changed.length) {
    return `⚠️ Self-fix made no file changes.\n\n${fix.summary}`;
  }

  // Persist the edits to GitHub with traditional git so the change survives the
  // restart and lives in the remote. Best-effort: a push failure never blocks
  // the restart, it's just reported.
  const commitMsg = `self_fix: ${String(instruction).replace(/\s+/g, ' ').trim().slice(0, 72)}`;
  const pushResult = await pushSource({ root, message: commitMsg, pat: invocation.config.githubPat });

  invocation.requestRestart = true;
  const changedList = fix.changed.slice(0, 20).join(', ') + (fix.changed.length > 20 ? ' …' : '');
  return `🛠️ ${fix.summary}\n\n📝 Changed: ${changedList}\n\n🔁 Git: ${pushResult}\n\n[NOTE: the bot restarts to apply the changes right after you send your reply — mention that.]`;
}
