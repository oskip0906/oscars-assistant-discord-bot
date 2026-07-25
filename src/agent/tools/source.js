import { execFile } from 'node:child_process';
import { chatCompletion } from '../openrouter.js';
import { config } from '../../config.js';
import { runClaudeFix } from './claudeRunner.js';
import { verifyChangedFiles } from './verifyEdits.js';
import { selfFixState } from '../../selfFixState.js';

export const defs = [
  {
    type: 'function',
    function: {
      name: 'self_fix',
      description:
        'OWNER ONLY. Fix or change YOUR OWN source code. Hands the instruction to Claude Code running inside the panda-bot project folder, which reads and edits the files; the change is then syntax- and import-checked, committed, pushed to GitHub, and the bot restarts to apply it. Describe WHAT should change; Claude Code does the editing. While this runs the bot answers nobody, so warn the user it will be unavailable for a few minutes.',
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

// Files in the working tree that differ from HEAD — i.e. exactly what a commit
// would capture. This is what we verify before shipping.
async function changedFiles(root) {
  const res = await git(['status', '--porcelain'], root);
  if (res.code !== 0) return [];
  return res.stdout
    .split('\n')
    .map((line) => line.slice(3).trim())
    .filter(Boolean)
    .map((p) => (p.includes(' -> ') ? p.split(' -> ')[1] : p)) // renames
    .map((p) => p.replace(/^"|"$/g, ''));
}

// Stage everything, commit (if there's anything to commit), and push to origin
// on the current branch using traditional git. Auth: Oscar's PAT is attached as
// an ephemeral HTTP Authorization header via `-c http.extraHeader=…` so it is
// never written into .git/config or the remote URL. Falls back to whatever git
// credentials are already configured when no PAT is set.
//
// Never throws — returns a human-readable summary string suitable for a tool
// result. Reads the repo's actual origin remote, so it works regardless of the
// GitHub repo name.
export async function pushSource({ root, message, pat }) {
  const inside = await git(['rev-parse', '--is-inside-work-tree'], root);
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') {
    return `❌ ${root} is not a git repository — cannot push. (${inside.stderr.trim() || 'no origin'})`;
  }

  const branchRes = await git(['rev-parse', '--abbrev-ref', 'HEAD'], root);
  const branch = branchRes.stdout.trim() || 'HEAD';

  await git(['add', '-A'], root);

  const staged = await git(['diff', '--cached', '--name-only'], root);
  const files = staged.stdout.split('\n').map((s) => s.trim()).filter(Boolean);

  if (files.length) {
    const commit = await git(['commit', '-m', message || 'panda-bot: update source'], root);
    if (commit.code !== 0) {
      return `❌ git commit failed:\n${(commit.stderr || commit.stdout).slice(0, 1500)}`;
    }
  }

  // Auth for the push:
  //  * `-c credential.helper=` clears any inherited helper (e.g. macOS
  //    osxkeychain), so a STALE cached credential can't override the PAT.
  //  * `-c http.extraHeader=Authorization: Basic …` supplies the PAT as HTTP
  //    basic auth, keeping the secret out of .git/config and the remote URL.
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
    const raw = push.stderr || push.stdout;
    const detail = (pat ? raw.split(pat).join('***') : raw).slice(0, 1500);
    const permHint = /403|denied|permission/i.test(raw)
      ? '\n\nℹ️ The token authenticated but was denied write. Give the GitHub PAT "Contents: Read and write" permission (fine-grained) — or "repo" scope (classic) — and make sure this repository is in its scope, then retry.'
      : '';
    return `❌ git push failed on branch ${branch}:\n${detail}${permHint}`;
  }

  const summary = push.stderr.trim() || push.stdout.trim() || 'up to date';
  if (!files.length) {
    return `✅ Nothing new to commit on ${branch}; pushed any pending commits.\n${summary.slice(0, 800)}`;
  }
  return `✅ Committed ${files.length} file(s) and pushed to origin/${branch}.\nFiles: ${files.slice(0, 20).join(', ')}${files.length > 20 ? ' …' : ''}\n${summary.slice(0, 800)}`;
}

// Decide whether Claude finished or is waiting on an answer, and if it's
// waiting, produce the answer. This is what lets self_fix run unattended: the
// bot is deaf to Discord while fixing, so nobody else can answer for it.
const JUDGE_TOOL = [
  {
    type: 'function',
    function: {
      name: 'report',
      description: 'Report whether Claude Code finished the task or is waiting on an answer.',
      parameters: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: ['complete', 'needs_input'],
            description:
              '"complete" if the task is done (or has failed for good); "needs_input" if Claude asked a question or is blocked awaiting a decision.',
          },
          answer: {
            type: 'string',
            description:
              'When status is needs_input: the answer to send back so Claude can continue. Be decisive and specific.',
          },
        },
        required: ['status'],
      },
    },
  },
];

async function judgeClaudeOutput(text, instruction) {
  const msg = await chatCompletion({
    apiKey: config.openrouterApiKey,
    model: config.model,
    messages: [
      {
        role: 'system',
        content: [
          'You supervise a Claude Code session that is editing the source of a Discord bot.',
          "You are given Claude Code's latest output. Decide whether it FINISHED the task or is ASKING for something.",
          'If it is asking a question or waiting on a decision, answer it yourself — decisively, in one or two sentences — so it can continue unattended. Never ask a question back.',
          'Prefer "complete" when the output reads like a summary of work already done.',
          'Always answer by calling the report tool.',
        ].join('\n'),
      },
      {
        role: 'user',
        content: `Original task: ${instruction}\n\n--- Claude Code output ---\n${String(text).slice(0, 12000)}`,
      },
    ],
    tools: JUDGE_TOOL,
  });

  // No structured verdict → assume done. The round cap guards the other
  // direction, so this can't wedge the loop.
  const call = msg.tool_calls?.[0];
  if (!call) return { status: 'complete' };
  try {
    const args = JSON.parse(call.function?.arguments || '{}');
    return args.status === 'needs_input'
      ? { status: 'needs_input', answer: args.answer }
      : { status: 'complete' };
  } catch {
    return { status: 'complete' };
  }
}

export async function selfFix({ instruction }, invocation) {
  const root = config.projectRoot;

  // Lock first, announce second: the lock must be up before we await anything.
  selfFixState.begin();
  await invocation.message?.channel
    ?.send(`🛠️ Self-fix starting in \`${root}\` — I'll be unresponsive until it lands, then restart.`)
    .catch(() => {});

  try {
    const result = await runClaudeFix({
      bin: config.claudeBin,
      cwd: root,
      instruction,
      judge: (text) => judgeClaudeOutput(text, instruction),
    });

    const tail = result.text.length > 4000 ? `…${result.text.slice(-4000)}` : result.text;

    if (!result.completed) {
      return `⚠️ Self-fix did not complete (${result.rounds} round(s)). Nothing was committed or pushed, and I am NOT restarting.\n\n${tail}`;
    }

    // Verify before shipping. A bad edit that gets committed and restarted into
    // takes the bot down until it is fixed by hand — which is exactly how the
    // '../../config.js' crash happened.
    const changed = await changedFiles(root);
    const problems = await verifyChangedFiles(root, changed);
    if (problems.length) {
      return [
        '❌ Self-fix made changes but they failed verification, so nothing was committed, pushed, or restarted.',
        'The edits are still on disk if you want to look at them.',
        '',
        problems.join('\n\n').slice(0, 2000),
        '',
        tail,
      ].join('\n');
    }

    const commitMsg = `self_fix: ${String(instruction).replace(/\s+/g, ' ').trim().slice(0, 72)}`;
    const pushResult = await pushSource({ root, message: commitMsg, pat: config.githubPat });

    invocation.requestRestart = true;
    return `${tail}\n\n✅ Verified ${changed.length} changed file(s).\n🔁 Git: ${pushResult}\n\n[NOTE: the bot restarts to apply the changes right after you send your reply — mention that.]`;
  } catch (err) {
    return `Self-fix failed: ${String(err.message || err).slice(0, 500)}`;
  } finally {
    // Always release. A crash, a timeout, or a missing `claude` binary must
    // never leave the bot permanently ignoring everyone.
    selfFixState.end();
  }
}

export async function gitPush({ message }) {
  return pushSource({ root: config.projectRoot, message, pat: config.githubPat });
}
