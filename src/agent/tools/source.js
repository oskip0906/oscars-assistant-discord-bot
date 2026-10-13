import { randomUUID } from 'node:crypto';
import { config } from '../../config.js';
import { dmOwner } from '../../discord/notify.js';
import { selfFixState } from '../../selfFixState.js';
import { startDevRunLog } from '../../devRunLog.js';
import { ApprovalCard } from '../../discord/approvalCard.js';
import { runDevelopmentSandbox } from './developmentSandbox.js';
import { chatCompletion, providerFor, turnSignal } from '../openrouter.js';

export const approvalCard = new ApprovalCard(config.dataDir);

export const DEVELOPMENT_APPROVAL_PREFIX = 'panda:development-approval:';

export const defs = [
  {
    type: 'function',
    function: {
      name: 'self_fix',
      description:
        'OWNER ONLY. Propose a change to YOUR OWN source code. Panda shows Oscar a Discord approval button first. After approval, an isolated GitHub Actions sandbox checks out the repository, runs Claude Code to make and test the change, opens a PR to main, enables auto-merge, and Panda restarts once it lands. The tool returns at once and the run continues in the background, so Panda keeps answering everyone meanwhile; the result is DMed to Oscar only. The live bot filesystem is never edited. Claude Code sees only the repository and the instruction — not this chat, earlier runs or GitHub — so the instruction must state the whole change on its own, even when retrying.',
      parameters: {
        type: 'object',
        properties: {
          instruction: { type: 'string', description: 'The complete change to make, self-contained (never "retry the previous task")' },
        },
        required: ['instruction'],
      },
    },
  },
];

// Pending approvals live in memory, and a Discord button never expires — so a
// card posted before a restart still looks live afterwards, while the run behind
// it is gone. Stamping the boot into the id lets a click on one of those say so
// precisely, instead of the flat "expired" that sent Oscar hunting.
export const BOOT_ID = randomUUID().replace(/-/g, '').slice(0, 8);

export function approvalButtonId(id, approved, boot = BOOT_ID) {
  return `${DEVELOPMENT_APPROVAL_PREFIX}${approved ? 'approve' : 'cancel'}:${boot}:${id}`;
}

export function parseApprovalButtonId(customId) {
  // The boot segment is optional so cards written by an older build still parse
  // — they read as "from a previous boot", which is exactly what they are.
  const match = String(customId || '').match(/^panda:development-approval:(approve|cancel):(?:([0-9a-f]{8}):)?(.+)$/);
  if (!match) return null;
  return { approved: match[1] === 'approve', boot: match[2] || null, id: match[3], fromThisBoot: match[2] === BOOT_ID };
}

// All development tasks use this Discord-native gate. There is intentionally
// no text fallback: changing source must be an explicit button interaction.
export async function requestDevelopmentApproval({ instruction, invocation, state, label = 'Self-fix', card = approvalCard }) {
  const approval = state.beginApproval({ userId: config.ownerId });
  const prompt = {
    content: [
      `🛠️ **${label} requested**`,
      'Runs Claude Code in GitHub Actions with the prompt below.',
      'This will run only in an isolated GitHub Actions sandbox and open a pull request. The buttons wait for you — take as long as you need.',
    ].join('\n'),
    embeds: [{ title: 'Prompt for Claude Code', description: String(instruction).slice(0, 4000) }],
    components: [
      {
        type: 1,
        components: [
          { type: 2, style: 3, label: 'Approve remote sandbox', custom_id: approvalButtonId(approval.id, true) },
          { type: 2, style: 4, label: 'Cancel', custom_id: approvalButtonId(approval.id, false) },
        ],
      },
    ],
    allowedMentions: { parse: [] },
  };
  let sent = null;
  try {
    sent = await invocation.message?.channel?.send(prompt);
  } catch {
    state.end();
    return 'cancel';
  }
  // Recorded before the wait, so a restart mid-wait can find this card and
  // retire it rather than leaving a live-looking button on a dead request.
  card?.remember(sent?.channelId, sent?.id);

  const outcome = await approval.result;
  card?.forget();
  // A click rewrites the card itself. Every other ending — a newer request
  // taking over, a run torn down — leaves live-looking buttons on a request
  // nothing is waiting for, which is the state that produced "expired" clicks.
  if (outcome !== 'confirm' && outcome !== 'cancel') {
    await sent
      ?.edit({
        content: `🚫 **${label}** was replaced by a newer request and is no longer waiting.`,
        components: [],
      })
      .catch(() => {});
  }
  return outcome;
}

// Oscar's request is often a one-liner, and Claude Code sees nothing but the
// prompt, so the chat model restates it as a self-contained task Oscar approves.
// It must not pad the request: an earlier version invented requirements.
async function writeClaudeCodePrompt(instruction, { apiKey, model, provider }) {
  const messages = [
    {
      role: 'system',
      content: `You write the prompt for Claude Code, which will change the source of Panda, a Node.js Discord bot, unattended in CI. Claude Code sees only the repository and your prompt: not this chat, earlier runs, or anything Oscar said elsewhere.

Restate Oscar's request as a clear, self-contained task. Stay faithful to it: say what he asked for and nothing more. Do not add requirements, features, edge cases, constraints, acceptance criteria or tests he did not ask for, and do not guess at his reasons. Do not invent file names, functions or facts you were not given; tell Claude Code to find them in the repo. Keep it as short as the request allows — a one-line request gets a few sentences, not a spec. Plain text, under 1500 characters. Return only the prompt.`,
    },
    { role: 'user', content: `Oscar's request: ${instruction}` },
  ];
  const msg = await chatCompletion({ apiKey, model, provider, messages });
  const text = msg?.content?.trim();
  if (!text) throw new Error('empty response');
  return text.slice(0, 4000);
}

// Ask the model to turn a raw instruction into a clean commit title and
// description, with the conversation model.
async function generateCommitMessage(instruction, { apiKey, model, provider }) {
  const messages = [
    {
      role: 'system',
      content: `You are a developer writing a git commit message. Given a change instruction, produce a JSON object with exactly two fields:

- "title": a single-line commit title that starts with "Self-fix: " and concisely describes the change (≤72 chars).
- "description": a detailed, well-written paragraph (or paragraphs) that explains what changed and why, in clear language suitable for a commit body.

Return ONLY the JSON object, no other text.`,
    },
    { role: 'user', content: `Instruction: ${instruction}` },
  ];
  const msg = await chatCompletion({ apiKey, model, provider, messages });
  const text = msg?.content?.trim();
  if (!text) throw new Error('empty response');
  // Strip markdown fences if present.
  const json = text.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '');
  const parsed = JSON.parse(json);
  if (typeof parsed.title !== 'string' || typeof parsed.description !== 'string') throw new Error('invalid shape');
  return { title: parsed.title, description: parsed.description };
}

// Returns at once. A turn holds its server's queue until it ends, so waiting
// here for the approval click and the minutes-long sandbox run left everyone in
// the server unanswered until the fix landed.
export function selfFix(args, invocation, deps = {}) {
  const state = deps.state || selfFixState;
  if (state.isActive()) return '🛠️ A self-fix is already running. Wait for it to land (Oscar gets a DM) before asking for another.';
  // Outside the turn's stop signal: a "@Panda stop" never half-kills a fix. Its
  // approval card (Approve / Cancel) stays the only way to start or drop it.
  turnSignal.exit(() => runSelfFix(args, invocation, deps)).catch((err) => console.error('[self_fix] background run failed:', err));
  return '🛠️ Writing the prompt for Claude Code now; an approval card will appear here in a moment. The fix runs in the background, so I keep answering meanwhile, and Oscar gets the result by DM.';
}

export async function runSelfFix(
  { instruction },
  invocation,
  {
    runSandbox = runDevelopmentSandbox,
    notify = dmOwner,
    state = selfFixState,
    confirm = requestDevelopmentApproval,
    startLog = startDevRunLog,
    restart = () => setTimeout(() => process.exit(42), 1500),
  } = {},
) {
  // Nobody is waiting on a return value any more, so every ending is DMed to
  // Oscar. Only him: the server does not need to hear about it.
  const finish = async (headline, summary) => {
    await notify(
      invocation.client,
      config.ownerId,
      `🛠️ **${headline}**\n${summary}`,
    );
    return summary;
  };

  // Logged before the approval prompt so the log shows the request that was
  // never approved, not just the runs that made it to the sandbox.
  const logFinish = startLog('self_fix', {
    repo: config.developmentSandboxRepo,
    model: 'claude-code',
    task: instruction,
  });

  let prompt = instruction;
  try {
    prompt = await writeClaudeCodePrompt(instruction, { apiKey: config.openrouterApiKey, model: config.model, provider: providerFor(config, config.model) });
  } catch (err) {
    // The card then shows Oscar's own words, so he still approves exactly what runs.
    console.error('[self_fix] prompt generation failed, using the instruction as is:', err.message);
  }

  const outcome = await confirm({ instruction: prompt, invocation, state });
  if (outcome !== 'confirm') {
    const why =
      { cancel: 'you cancelled it', superseded: 'a newer request took its place', aborted: 'the request was torn down before you answered' }[outcome] ||
      'it was not approved';
    logFinish('aborted', { reason: why });
    const summary = `🚫 Self-fix aborted — ${why}. Nothing was changed.`;
    // A click on the card already says so in the channel, and a cancel needs no DM.
    if (outcome !== 'cancel') await invocation.message?.channel?.send(summary).catch(() => {});
    return summary;
  }

  state.begin();
  // Do not disturb while the run is in flight; the bot still answers everyone.
  invocation.client?.user?.setPresence({ status: 'dnd' });
  await invocation.message?.channel
    ?.send(`🛠️ Approval received — running Claude Code in the remote GitHub Actions sandbox. I keep answering meanwhile and restart once the PR merges.`)
    .catch(() => {});

  // Generate a proper commit title so the instruction never appears verbatim in
  // it. The workflow commits; Claude's own summary becomes the commit body.
  let commitTitle = null;
  try {
    commitTitle = (await generateCommitMessage(instruction, { apiKey: config.openrouterApiKey, model: config.model, provider: providerFor(config, config.model) })).title;
  } catch (err) {
    // Model call failed; runDevelopmentSandbox falls back to an automatic title.
    console.error('[self_fix] commit message generation failed, using the automatic title:', err.message);
  }

  try {
    const result = await runSandbox({
      repo: config.developmentSandboxRepo,
      instruction: prompt,
      autoMerge: true,
      selfFix: true,
      config,
      commitTitle,
    });
    if (!result.ok) {
      logFinish('failed', { pr: result.pr?.number, url: result.pr?.html_url, detail: result.summary });
      return finish('self_fix did not land', result.summary);
    }

    logFinish('merged', { pr: result.pr?.number, url: result.pr?.html_url });
    const summary = await finish('self_fix landed — restarting now', `${result.summary}\n\n🔁 Restarting now to apply the merged remote change.`);
    console.log('[panda] self_fix landed — exiting with code 42 to restart');
    restart();
    return summary;
  } catch (err) {
    logFinish('crashed', { detail: String(err.message || err) });
    return finish('self_fix crashed', `❌ Remote sandbox failed: ${String(err.message || err).slice(0, 500)}`);
  } finally {
    state.end();
    invocation.client?.user?.setPresence({ status: 'online' });
  }
}
