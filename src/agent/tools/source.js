import { randomUUID } from 'node:crypto';
import { config } from '../../config.js';
import { dmOwner } from '../../discord/notify.js';
import { selfFixState } from '../../selfFixState.js';
import { getAIConfig } from '../../configManager.js';
import { startDevRunLog } from '../../devRunLog.js';
import { ApprovalCard } from '../../discord/approvalCard.js';
import { runDevelopmentSandbox } from './developmentSandbox.js';
import { chatCompletion } from '../openrouter.js';

export const approvalCard = new ApprovalCard(config.dataDir);

export const DEVELOPMENT_APPROVAL_PREFIX = 'panda:development-approval:';

export const defs = [
  {
    type: 'function',
    function: {
      name: 'self_fix',
      description:
        'OWNER ONLY. Propose a change to YOUR OWN source code. Panda shows Oscar a Discord approval button first. After approval, an isolated GitHub Actions sandbox checks out the repository, uses the configured OpenRouter development model to make and verify the change, opens a PR to main, enables auto-merge, and waits until it lands before Panda restarts. The live bot filesystem is never edited.',
      parameters: {
        type: 'object',
        properties: {
          instruction: { type: 'string', description: 'What to change or fix about the bot' },
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
export async function requestDevelopmentApproval({ instruction, invocation, state, model, label = 'Self-fix', card = approvalCard }) {
  const approval = state.beginApproval({ userId: config.ownerId });
  const prompt = {
    content: [
      `🛠️ **${label} requested**`,
      `OpenRouter development model: \`${model}\``,
      `Task: ${String(instruction).replace(/\s+/g, ' ').slice(0, 800)}`,
      '',
      'This will run only in an isolated GitHub Actions sandbox and open a pull request. The buttons wait for you — take as long as you need.',
    ].join('\n'),
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

// Ask the model to turn a raw instruction into a clean commit title and
// description. Runs on the configured development model so we never send a
// commit message composed from a lower-capability model.
async function generateCommitMessage(instruction, { apiKey, model }) {
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
  const msg = await chatCompletion({ apiKey, model, messages });
  const text = msg?.content?.trim();
  if (!text) throw new Error('empty response');
  // Strip markdown fences if present.
  const json = text.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '');
  const parsed = JSON.parse(json);
  if (typeof parsed.title !== 'string' || typeof parsed.description !== 'string') throw new Error('invalid shape');
  return { title: parsed.title, description: parsed.description };
}

export async function selfFix(
  { instruction },
  invocation,
  {
    runSandbox = runDevelopmentSandbox,
    notify = dmOwner,
    state = selfFixState,
    getConfig = getAIConfig,
    confirm = requestDevelopmentApproval,
    startLog = startDevRunLog,
  } = {},
) {
  const finish = async (headline, summary) => {
    await notify(
      invocation.client,
      config.ownerId,
      `🛠️ **${headline}**\n${summary}`,
    );
    return summary;
  };

  const { model: devModel } = getConfig('development');
  // Logged before the approval prompt so the log shows the request that was
  // never approved, not just the runs that made it to the sandbox.
  const logFinish = startLog('self_fix', {
    repo: config.developmentSandboxRepo,
    model: devModel,
    task: instruction,
  });

  const outcome = await confirm({ instruction, invocation, state, model: devModel });
  if (outcome !== 'confirm') {
    const why =
      { cancel: 'you cancelled it', superseded: 'a newer request took its place', aborted: 'the request was torn down before you answered' }[outcome] ||
      'it was not approved';
    logFinish('aborted', { reason: why });
    return `🚫 Self-fix aborted — ${why}. Nothing was changed.`;
  }

  state.begin();
  await invocation.message?.channel
    ?.send(`🛠️ Approval received — running in the remote GitHub Actions sandbox with \`${devModel}\`. I will wait for the PR to merge before restarting.`)
    .catch(() => {});

  // Generate a proper commit message so the instruction never appears verbatim in the commit.
  let commitMessage = null;
  let sandboxInstruction = instruction;
  let commitTitle = null;
  try {
    commitMessage = await generateCommitMessage(instruction, {
      apiKey: config.openrouterApiKey,
      model: devModel,
    });
    // Instruct the sandbox to use this exact title/description for its commit.
    sandboxInstruction = [
      `Use the following commit title: \`${commitMessage.title}\` and commit description:\n\n\`\`\`\n${commitMessage.description}\n\`\`\`\n\nThe actual code change to implement:\n${instruction}`,
    ].join('\n');
    commitTitle = commitMessage.title;
  } catch (err) {
    // Model call failed; fall back to the original instruction.
    console.error('[self_fix] commit message generation failed, using raw instruction:', err.message);
  }

  try {
    const result = await runSandbox({
      repo: config.developmentSandboxRepo,
      instruction: sandboxInstruction,
      model: devModel,
      autoMerge: true,
      selfFix: true,
      config,
      commitTitle,
    });
    if (!result.ok) {
      logFinish('failed', { pr: result.pr?.number, url: result.pr?.html_url, detail: result.summary });
      return finish('self_fix did not land', result.summary);
    }

    invocation.requestRestart = true;
    logFinish('merged', { pr: result.pr?.number, url: result.pr?.html_url });
    return finish('self_fix landed — restarting now', `${result.summary}\n\n🔁 Restarting now to apply the merged remote change.`);
  } catch (err) {
    logFinish('crashed', { detail: String(err.message || err) });
    return finish('self_fix crashed', `❌ Remote sandbox failed: ${String(err.message || err).slice(0, 500)}`);
  } finally {
    state.end();
  }
}
