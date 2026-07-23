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
        'OWNER ONLY. Fix or change YOUR OWN source code: hands the instruction to Claude Code inside the panda-bot project folder, then restarts the bot to apply the change. Describe WHAT should change; Claude Code does the editing.',
      parameters: {
        type: 'object',
        properties: {
          instruction: { type: 'string', description: 'What to change/fix about the bot' },
        },
        required: ['instruction'],
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
    .send(`🛠️ Self-fix starting in \`${root}\` — I'll restart once it's done…`)
    .catch(() => {});
  const result = await runClaude({ bin: invocation.config.claudeBin, prompt: wrapped, cwd: root });
  invocation.requestRestart = true;
  return `${result}\n\n[NOTE: the bot restarts to apply the changes right after you send your reply — mention that.]`;
}
