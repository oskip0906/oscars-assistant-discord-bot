import { execFile } from 'node:child_process';
import { chatCompletion } from '../openrouter.js';
import { config } from '../../config.js';
import { runClaudeFix } from './claudeRunner.js';
import { verifyChangedFiles } from './verifyEdits.js';
import { openAutoMergedPr, repoSlug, snapshotFiles } from './prFlow.js';
import { dmOwner } from '../../discord/notify.js';
import { selfFixState } from '../../selfFixState.js';
import { getAIConfig } from '../../configManager.js';

// How long Oscar has to type 'confirm' before a development task auto-cancels.
const CONFIRM_TIMEOUT_MS = 30 * 1000;

// self_fix is a 'development' task: before it touches anything, present the
// model that will do the work and the task description, then wait for Oscar to
// type 'confirm'. Resolves to 'confirm' | 'cancel' | 'timeout'. Injectable so
// the orchestration tests can auto-confirm without a live channel.
async function requestConfirmation({ instruction, invocation, state, model }) {
  const prompt = [
    `🛠️ You are about to perform a **development task** using the OpenRouter model \`${model}\`.`,
    `The task is: "${String(instruction).replace(/\n/g, ' ').slice(0, 500)}".`,
    `Type \`confirm\` to proceed, or \`cancel\` to abort (auto-cancels in ${CONFIRM_TIMEOUT_MS / 1000}s).`,
  ].join('\n');

  // Flip to awaiting_confirmation FIRST (synchronous), then announce — so the
  // message handler is already capturing Oscar's reply before the prompt sends.
  const answered = state.awaitConfirmation({ userId: config.ownerId, timeoutMs: CONFIRM_TIMEOUT_MS });
  await invocation.message?.channel?.send(prompt).catch(() => {});
  return answered;
}

// self_fix always targets the repo's main line; a deployment that ends up on
// any other branch is a mistake to correct, not a state to preserve.
const DEFAULT_BASE = 'main';

export const defs = [
  {
    type: 'function',
    function: {
      name: 'self_fix',
      description:
        'OWNER ONLY. Fix or change YOUR OWN source code. Hands the instruction to Claude Code running inside the panda-bot project folder, which reads and edits the files; the change is then syntax- and import-checked, opened as a pull request against remote main on GitHub, auto-merged there, pulled back down so this machine matches remote, and the bot restarts to apply it. Nothing is ever committed to the local checkout. Describe WHAT should change; Claude Code does the editing. While this runs the bot answers nobody, so warn the user it will be unavailable for a few minutes.',
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
  {
    type: 'function',
    function: {
      name: 'git_pull',
      description:
        "OWNER ONLY. Fetch and merge remote changes into YOUR OWN local source by running real git `pull origin HEAD` on the current branch. Use this when a push was rejected because the remote has commits you don't have locally, or to pick up changes someone pushed to GitHub. (self_fix does its own harder sync — fetch + reset to origin/main — after its PR merges.)",
      parameters: {
        type: 'object',
        properties: {},
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
//
// `-uall` matters: plain --porcelain collapses a brand-new directory to a
// single "src/deep/" entry, and a shipping step that tried to upload that as a
// blob would die on EISDIR. Ignored files (.env, data/, node_modules) never
// appear either way — git filters them out for us.
export async function changedFiles(root) {
  const res = await git(['status', '--porcelain', '-uall'], root);
  if (res.code !== 0) return [];
  return res.stdout
    .split('\n')
    .map((line) => line.slice(3).trim())
    .filter(Boolean)
    .map((p) => (p.includes(' -> ') ? p.split(' -> ')[1] : p)) // renames
    .map((p) => p.replace(/^"|"$/g, ''));
}

// Ephemeral auth for a network git operation: supply Oscar's PAT as an HTTP
// basic-auth header via `-c http.extraHeader=…` so the secret stays out of
// .git/config and the remote URL, and clear any inherited credential helper so
// a stale cached credential can't override it. Empty when no PAT is set.
function authArgs(pat) {
  return pat
    ? [
        '-c',
        'credential.helper=',
        '-c',
        `http.extraHeader=Authorization: Basic ${Buffer.from(`x-access-token:${pat}`).toString('base64')}`,
      ]
    : [];
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

  const push = await git([...authArgs(pat), 'push', 'origin', 'HEAD'], root);
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

// Fetch and merge remote changes into the current branch with real git
// (`pull origin HEAD`). Uses the same ephemeral PAT auth as pushSource so
// private repos authenticate without persisting the secret. Never throws —
// returns a human-readable summary string suitable for a tool result.
export async function pullSource({ root, pat }) {
  const inside = await git(['rev-parse', '--is-inside-work-tree'], root);
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') {
    return `❌ ${root} is not a git repository — cannot pull. (${inside.stderr.trim() || 'no origin'})`;
  }

  const pull = await git([...authArgs(pat), 'pull', 'origin', 'HEAD'], root);
  if (pull.code !== 0) {
    const raw = pull.stderr || pull.stdout;
    const detail = (pat ? raw.split(pat).join('***') : raw).slice(0, 1500);
    return `❌ git pull failed:\n${detail}`;
  }

  const summary = pull.stdout.trim() || pull.stderr.trim() || 'already up to date';
  return `✅ Pulled from origin.\n${summary.slice(0, 800)}`;
}

// One authenticated GitHub REST call, shaped the way prFlow wants it.
function ghRequest(pat) {
  return async (method, endpoint, body) => {
    const res = await fetch(`https://api.github.com${endpoint}`, {
      method,
      headers: {
        ...(pat ? { Authorization: `Bearer ${pat}` } : {}),
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'panda-bot',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { message: text.slice(0, 400) };
    }
    return { status: res.status, json };
  };
}

// How a self_fix reaches production: the edits Claude left in the working tree
// are uploaded as a pull request against remote main, auto-merged there, and
// then pulled back down. The local checkout is never committed to — it only
// ever consumes what main says, which is what keeps it from drifting.
//
// Never throws; returns {ok, summary}. ok:false means the code on this machine
// is NOT the merged code, so the caller must not restart into it.
export async function shipViaPullRequest({
  root,
  title,
  body = '',
  changed,
  base = DEFAULT_BASE,
  pat,
  openPr = openAutoMergedPr,
  sync = syncToRemote,
  now = Date.now,
}) {
  const remote = await git(['remote', 'get-url', 'origin'], root);
  const slug = remote.code === 0 ? repoSlug(remote.stdout) : null;
  if (!slug) {
    return {
      ok: false,
      summary: `❌ No GitHub \`origin\` remote in ${root} — cannot open a pull request. (${(remote.stderr || remote.stdout).trim().slice(0, 200)})`,
    };
  }

  const files = snapshotFiles(root, changed);
  const branchName = `self-fix-${now()}`;

  const pr = await openPr({ gh: ghRequest(pat), slug, base, branchName, title, body, files });
  if (!pr.ok) {
    return {
      ok: false,
      summary: `❌ ${pr.detail}${pr.url ? `\n${pr.url}` : ''}\nThe edits are still on disk and I am NOT restarting.`,
    };
  }

  // Only now is main the truth. Pulling before the merge would wipe the fix.
  const pulled = await sync({ root, base, pat });
  if (pulled.startsWith('❌')) {
    return { ok: false, summary: `⚠️ ${pr.detail}\n${pr.url}\nBut the local pull failed, so I am NOT restarting:\n${pulled}` };
  }

  return { ok: true, summary: `✅ ${pr.detail}\n${pr.url}\n${pulled}` };
}

// Bring the local checkout into line with a remote branch, discarding whatever
// is in the working tree. This is the step self_fix runs after its PR is merged:
// the merged code is the truth, and the local edits are a spent draft of it.
//
// It is `fetch` + `reset --hard` rather than `pull` on purpose. A pull is a
// merge, and a merge aborts when local files (Claude's edits, or an untracked
// new file that the PR also added) would be overwritten — which is the normal
// case here, not an exception. Never throws; returns a summary string.
export async function syncToRemote({ root, base = 'main', pat }) {
  const inside = await git(['rev-parse', '--is-inside-work-tree'], root);
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') {
    return `❌ ${root} is not a git repository — cannot sync to origin/${base}.`;
  }

  const fetch = await git([...authArgs(pat), 'fetch', 'origin', base], root);
  if (fetch.code !== 0) {
    const raw = fetch.stderr || fetch.stdout;
    return `❌ git fetch failed:\n${redact(raw, pat).slice(0, 1500)}`;
  }

  // A deployment that drifted onto another branch still has to end up running
  // main. The trees are identical at this point, so the switch can't conflict.
  const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], root)).stdout.trim();
  let stayedOn = '';
  if (branch !== base) {
    const checkout = await git(['checkout', '-B', base], root);
    if (checkout.code !== 0) {
      // Another worktree already has `base` checked out, so this one can't take
      // the name. The branch it sits on matters far less than its contents, so
      // reset that branch to the remote instead of giving up.
      stayedOn = ` (still on \`${branch}\` — ${base} is checked out elsewhere)`;
    }
  }

  const reset = await git(['reset', '--hard', 'FETCH_HEAD'], root);
  if (reset.code !== 0) {
    return `❌ git reset to origin/${base} failed:\n${(reset.stderr || reset.stdout).slice(0, 1500)}`;
  }

  const head = (await git(['log', '-1', '--oneline'], root)).stdout.trim();
  return `✅ Pulled origin/${base} — local checkout now matches remote at ${head}${stayedOn}`;
}

function redact(text, pat) {
  return pat ? String(text).split(pat).join('***') : String(text);
}

// What ships is whatever the working tree now differs from HEAD by, checked
// before it leaves the machine.
async function verifyWorkingTree({ root }) {
  const changed = await changedFiles(root);
  return { changed, problems: await verifyChangedFiles(root, changed) };
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

// Deps are injectable so the orchestration can be tested without ever reaching
// the real `claude` binary, GitHub, or Discord.
export async function selfFix(
  { instruction },
  invocation,
  {
    runFix = runClaudeFix,
    verify = verifyWorkingTree,
    ship = shipViaPullRequest,
    notify = dmOwner,
    state = selfFixState,
    getConfig = getAIConfig,
    confirm = requestConfirmation,
  } = {},
) {
  const root = config.projectRoot;

  // Every exit path ends here: Oscar gets a DM the moment the fix settles,
  // sent directly rather than through the model — self_fix ends in a restart,
  // and a report routed through the agent could be reworded or lost with it.
  const finish = async (headline, summary) => {
    await notify(
      invocation.client,
      config.ownerId,
      [`🛠️ **${headline}**`, `> ${String(instruction).replace(/\n/g, ' ').slice(0, 500)}`, '', summary].join('\n'),
    );
    return summary;
  };

  // Development-task confirmation gate: pick the dev model, show Oscar what will
  // run, and wait for an explicit 'confirm'. Anything else aborts before we
  // touch a single file or take the executing lock.
  const { model: devModel } = getConfig('development');
  const outcome = await confirm({ instruction, invocation, state, model: devModel });
  if (outcome !== 'confirm') {
    const why = outcome === 'cancel' ? 'you cancelled' : `no confirmation within ${CONFIRM_TIMEOUT_MS / 1000}s`;
    await invocation.message?.channel?.send(`🚫 Self-fix aborted — ${why}. Nothing was changed.`).catch(() => {});
    return `Self-fix aborted before starting (${why}). Nothing was changed.`;
  }

  // Lock first, announce second: the lock must be up before we await anything.
  state.begin();
  await invocation.message?.channel
    ?.send(`🛠️ Self-fix confirmed — starting in \`${root}\` using \`${devModel}\`. I'll be unresponsive until it lands, then restart.`)
    .catch(() => {});

  try {
    const result = await runFix({
      bin: config.claudeBin,
      cwd: root,
      instruction,
      judge: (text) => judgeClaudeOutput(text, instruction),
    });

    const tail = result.text.length > 4000 ? `…${result.text.slice(-4000)}` : result.text;

    if (!result.completed) {
      return finish(
        'self_fix did not complete',
        `⚠️ Self-fix did not complete (${result.rounds} round(s)). Nothing was shipped, and I am NOT restarting.\n\n${tail}`,
      );
    }

    // Verify before shipping. A bad edit that gets committed and restarted into
    // takes the bot down until it is fixed by hand — which is exactly how the
    // '../../config.js' crash happened.
    const { changed, problems } = await verify({ root });
    if (problems.length) {
      return finish(
        'self_fix failed verification',
        [
          '❌ Self-fix made changes but they failed verification, so nothing was shipped or restarted.',
          'The edits are still on disk if you want to look at them.',
          '',
          problems.join('\n\n').slice(0, 2000),
          '',
          tail,
        ].join('\n'),
      );
    }

    // The squash-merged commit takes its title from `title` (the branch PR
    // title) and its body from `body`. Keep the title short and prefixed, and
    // build the body as a detailed description from the completion output — the
    // same thing Oscar sees reported when a self_fix lands.
    const shortInstruction = String(instruction).replace(/\s+/g, ' ').trim();
    const title = `🛠️ Self-fix: ${shortInstruction.slice(0, 60)}`;
    // Ship through GitHub, not through this checkout: PR against main →
    // auto-merge → pull the merged result back down. If any of that fails the
    // local code is NOT what main says, so we must not restart into it.
    const shipped = await ship({
      root,
      title,
      body: [
        'Performed automatically by panda-bot `self_fix`.',
        '',
        `**Instruction from Oscar:** ${shortInstruction.slice(0, 1500)}`,
        '',
        '**Files modified:**',
        changed.length ? changed.map((f) => `- \`${f}\``).join('\n') : '- (none reported)',
        '',
        `**Verified:** \`node --check\` + import resolution passed across ${changed.length} changed file(s).`,
        '',
        '**Details from the self_fix run:**',
        tail,
      ].join('\n'),
      changed,
      pat: config.githubPat,
    });

    if (!shipped.ok) {
      console.error(`[self_fix] not restarting:\n${shipped.summary}`);
      return finish(
        'self_fix could not ship',
        `${tail}\n\n✅ Verified ${changed.length} changed file(s), but shipping failed.\n${shipped.summary}`,
      );
    }

    invocation.requestRestart = true;
    return finish(
      'self_fix landed — restarting now',
      `${tail}\n\n✅ Verified ${changed.length} changed file(s).\n🔁 ${shipped.summary}\n\n[NOTE: the bot restarts to apply the changes right after you send your reply — mention that.]`,
    );
  } catch (err) {
    return finish('self_fix crashed', `Self-fix failed: ${String(err.message || err).slice(0, 500)}`);
  } finally {
    // Always release. A crash, a timeout, or a missing `claude` binary must
    // never leave the bot permanently ignoring everyone.
    state.end();
  }
}

export async function gitPush({ message }) {
  return pushSource({ root: config.projectRoot, message, pat: config.githubPat });
}

export async function gitPull() {
  return pullSource({ root: config.projectRoot, pat: config.githubPat });
}
