import { execFile } from 'node:child_process';

// The Claude Code connection, used by self_fix and nothing else. There is
// deliberately no general-purpose "run Claude on anything" tool exposed to the
// model — this module is reachable only through self_fix.

const TIMEOUT_MS = 10 * 60 * 1000;
const MAX_ROUNDS = 5;

// Run Claude Code once. Never rejects — always resolves to
// { ok, text, sessionId }, because every caller here is building a tool result.
//
// The prompt goes over stdin rather than argv: `-p` is a boolean flag, so a
// prompt in argv is capped by the OS argument-length limit (silently truncating
// long instructions) and a leading '-' would be misparsed as an option. stdin
// has neither problem.
export function runClaude({ bin, prompt, cwd, sessionId = null, timeoutMs = TIMEOUT_MS }) {
  return new Promise((resolve) => {
    const args = ['-p', '--dangerously-skip-permissions', '--output-format', 'json'];
    if (sessionId) args.push('--resume', sessionId);

    const child = execFile(
      bin,
      args,
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 32 * 1024 * 1024,
        env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ''}` },
      },
      (err, stdout, stderr) => {
        const raw = String(stdout ?? '').trim();
        const parsed = parseResult(raw);

        if (err) {
          const detail = [raw, String(stderr ?? '').trim()].filter(Boolean).join('\n').slice(-6000);
          const label = err.killed
            ? `⏱️ Claude Code timed out after ${Math.round(timeoutMs / 1000)}s.`
            : `Claude Code exited with ${err.code ?? 'a signal'}.`;
          return resolve({ ok: false, text: `${label}\n${detail || err.message}`, sessionId: parsed.sessionId });
        }
        // The CLI reports logical failures (max turns, execution error) in the
        // envelope while still exiting 0, so the exit code alone is not enough.
        if (parsed.isError) {
          return resolve({
            ok: false,
            text: `Claude Code reported a failure${parsed.subtype ? ` (${parsed.subtype})` : ''}.\n${parsed.text}`,
            sessionId: parsed.sessionId,
          });
        }
        resolve({
          ok: true,
          text: parsed.text || '(Claude Code produced no output)',
          sessionId: parsed.sessionId,
        });
      },
    );
    // The child can die before draining stdin; swallow the resulting EPIPE.
    child.stdin?.on('error', () => {});
    child.stdin?.end(String(prompt ?? ''));
  });
}

// `--output-format json` emits one result envelope carrying the final text and
// the session id we need in order to resume. Anything unparseable is treated as
// plain text so a CLI change can't hard-fail the fix.
function parseResult(raw) {
  if (!raw.startsWith('{')) return { text: raw, sessionId: null, isError: false, subtype: null };
  try {
    const obj = JSON.parse(raw);
    const text = typeof obj.result === 'string' ? obj.result : raw;
    return {
      text,
      sessionId: obj.session_id ?? null,
      isError: obj.is_error === true,
      subtype: typeof obj.subtype === 'string' ? obj.subtype : null,
    };
  } catch {
    return { text: raw, sessionId: null, isError: false, subtype: null };
  }
}

// Drive Claude to completion, answering anything it asks along the way.
//
// After each round the judge (an OpenRouter call, injected) decides whether
// Claude finished or is waiting on input. If it's waiting, the judge's answer
// becomes the prompt for a `--resume` of the same session. Capped at maxRounds;
// hitting the cap is a failure, not a success, so a Claude that never stops
// asking can't be mistaken for a completed fix.
export async function runClaudeFix({
  bin,
  cwd,
  instruction,
  judge,
  maxRounds = MAX_ROUNDS,
  run = runClaude,
  onRound = () => {},
}) {
  const transcript = [];
  let prompt = buildPrompt(instruction);
  let sessionId = null;

  for (let round = 1; round <= maxRounds; round++) {
    const res = await run({ bin, prompt, cwd, sessionId });
    transcript.push(res.text);
    onRound({ round, text: res.text, ok: res.ok });

    if (!res.ok) {
      return { completed: false, text: transcript.join('\n\n'), rounds: round };
    }
    sessionId = res.sessionId ?? sessionId;

    let verdict;
    try {
      verdict = await judge(res.text);
    } catch (err) {
      // The judge is a network call; if it fails we can't safely assume the
      // work is done, so stop and report rather than commit blind.
      return {
        completed: false,
        text: `${transcript.join('\n\n')}\n\n⚠️ Could not evaluate Claude's output: ${String(err.message || err).slice(0, 200)}`,
        rounds: round,
      };
    }

    if (verdict?.status === 'complete') {
      return { completed: true, text: transcript.join('\n\n'), rounds: round };
    }

    // Resuming without a session id would silently start a fresh conversation
    // and lose all of Claude's context, so bail instead.
    if (!sessionId) {
      return {
        completed: false,
        text: `${transcript.join('\n\n')}\n\n⚠️ Claude asked a question but returned no session id to resume.`,
        rounds: round,
      };
    }
    prompt = verdict?.answer || 'Use your best judgement and finish the task.';
  }

  return { completed: false, text: transcript.join('\n\n'), rounds: maxRounds };
}

function buildPrompt(instruction) {
  return [
    'You are editing the LIVE source code of "panda-bot", a Discord AI agent, in this directory.',
    'It is running right now and will restart itself to pick up your changes once you finish.',
    '',
    `Task from Oscar: ${instruction}`,
    '',
    'Hard rules:',
    '- Do NOT read, modify, or print .env (secrets), and do NOT touch data/ (runtime state).',
    '- Keep it a plain ESM Node app; entry point src/index.js must stay bootable.',
    '- Relative imports must point at files that actually exist — a wrong path crashes the bot on boot.',
    '- Run `node --check` on every file you change and fix any error before finishing.',
    '- Make the smallest correct change. Do not rewrite unrelated code.',
    '',
    'Work autonomously and do not ask questions unless you genuinely cannot proceed.',
  ].join('\n');
}
