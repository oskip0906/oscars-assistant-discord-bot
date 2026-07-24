import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';

export const defs = [
  {
    type: 'function',
    function: {
      name: 'prompt_claude',
      description:
        "OWNER ONLY. Run Claude Code on Oscar's Mac with auto-approved edits (--dangerously-skip-permissions) and return its output. Use for coding tasks, file operations, or anything Oscar asks you to do on his machine. Takes minutes — warn the user it may be slow.",
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'The task/prompt to give Claude Code' },
          directory: {
            type: 'string',
            description: "Absolute working directory for the task (default: Oscar's home directory)",
          },
        },
        required: ['prompt'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'self_fix',
      description:
        'OWNER ONLY. Fix or change YOUR OWN source code: hands the instruction to Claude Code inside the panda-bot project folder, commits & pushes the edits to GitHub, then restarts the bot to apply the change. Describe WHAT should change; Claude Code does the editing.',
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

const TIMEOUT_MS = 10 * 60 * 1000;

// Never rejects — always resolves to text suitable for a tool result.
export function runClaude({ bin, prompt, cwd, timeoutMs = TIMEOUT_MS }) {
  return new Promise((resolve) => {
    // Feed the prompt over stdin rather than as a CLI positional argument.
    // `-p` (--print) is a boolean flag, so the prompt would otherwise ride in
    // argv, where it is capped by the OS argument-length limit (truncating long
    // instructions) and a leading '-' would be misread as an option. stdin has
    // no such limit and is never parsed as flags, so arbitrarily long
    // instructions pass through intact. `--input-format text` (the default)
    // makes `claude -p` read the whole of stdin as the prompt.
    const child = execFile(
      bin,
      ['-p', '--dangerously-skip-permissions', '--output-format', 'text'],
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 32 * 1024 * 1024,
        env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ''}` },
      },
      (err, stdout, stderr) => {
        const out = [stdout?.trim(), stderr?.trim() ? `[stderr]\n${stderr.trim()}` : '']
          .filter(Boolean)
          .join('\n');
        const tail = out.length > 6000 ? `…${out.slice(-6000)}` : out;
        if (err?.killed) return resolve(`⏱️ Claude Code timed out after ${Math.round(timeoutMs / 1000)}s.\n${tail}`);
        if (err) return resolve(`Claude Code exited with code ${err.code ?? 'signal'}.\n${tail || err.message}`);
        resolve(tail || '(Claude Code produced no output)');
      },
    );
    // Guard against EPIPE if the process dies before consuming stdin.
    child.stdin.on('error', () => {});
    child.stdin.end(String(prompt ?? ''));
  });
}

export async function promptClaude({ prompt, directory }, invocation) {
  const cwd = directory || os.homedir();
  if (!fs.existsSync(cwd)) return `Directory does not exist: ${cwd}`;
  await invocation.message.channel
    .send(`🔧 Running Claude Code in \`${cwd}\` — this can take a few minutes…`)
    .catch(() => {});
  return runClaude({ bin: invocation.config.claudeBin, prompt, cwd });
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
  const wrapped = [
    'You are editing the LIVE source code of "panda-bot", a Discord AI agent, in this directory. It is currently running; after you finish it will restart itself to pick up your changes.',
    `Task from Oscar: ${instruction}`,
    'Hard rules:',
    '- Do NOT modify or print .env (secrets) and do NOT touch data/ (runtime state).',
    '- Keep it a plain ESM Node app; entry point src/index.js must stay bootable.',
    '- After editing, run `node --check` on every file you changed and fix any syntax errors.',
  ].join('\n');
  await invocation.message.channel
    .send(`🛠️ Self-fix starting in \`${root}\` — I'll commit, push, and restart once it's done…`)
    .catch(() => {});
  const result = await runClaude({ bin: invocation.config.claudeBin, prompt: wrapped, cwd: root });

  // Persist the edits to GitHub with traditional git so the change survives the
  // restart and lives in the remote. Best-effort: a push failure never blocks
  // the restart, it's just reported.
  const commitMsg = `self_fix: ${String(instruction).replace(/\s+/g, ' ').trim().slice(0, 72)}`;
  const pushResult = await pushSource({ root, message: commitMsg, pat: invocation.config.githubPat });

  invocation.requestRestart = true;
  return `${result}\n\n🔁 Git: ${pushResult}\n\n[NOTE: the bot restarts to apply the changes right after you send your reply — mention that.]`;
}
