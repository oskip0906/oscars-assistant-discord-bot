import { config } from '../../config.js';
import { dmOwner } from '../../discord/notify.js';
import { selfFixState } from '../../selfFixState.js';
import { getAIConfig } from '../../configManager.js';
import { runDevelopmentSandbox } from './developmentSandbox.js';

const APPROVAL_TIMEOUT_MS = 30 * 1000;
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

export function approvalButtonId(id, approved) {
  return `${DEVELOPMENT_APPROVAL_PREFIX}${approved ? 'approve' : 'cancel'}:${id}`;
}

export function parseApprovalButtonId(customId) {
  const match = String(customId || '').match(/^panda:development-approval:(approve|cancel):(.+)$/);
  return match ? { approved: match[1] === 'approve', id: match[2] } : null;
}

// All development tasks use this Discord-native gate. There is intentionally
// no text fallback: changing source must be an explicit button interaction.
export async function requestDevelopmentApproval({ instruction, invocation, state, model, label = 'Self-fix' }) {
  const approval = state.beginApproval({ userId: config.ownerId, timeoutMs: APPROVAL_TIMEOUT_MS });
  const prompt = {
    content: [
      `🛠️ **${label} requested**`,
      `OpenRouter development model: \`${model}\``,
      `Task: ${String(instruction).replace(/\s+/g, ' ').slice(0, 800)}`,
      '',
      `This will run only in an isolated GitHub Actions sandbox and open a pull request. Approve within ${APPROVAL_TIMEOUT_MS / 1000}s.`,
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
  try {
    await invocation.message?.channel?.send(prompt);
  } catch {
    state.end();
    return 'cancel';
  }
  return approval.result;
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
  } = {},
) {
  const finish = async (headline, summary) => {
    await notify(
      invocation.client,
      config.ownerId,
      [`🛠️ **${headline}**`, `> ${String(instruction).replace(/\n/g, ' ').slice(0, 500)}`, '', summary].join('\n'),
    );
    return summary;
  };

  const { model: devModel } = getConfig('development');
  const outcome = await confirm({ instruction, invocation, state, model: devModel });
  if (outcome !== 'confirm') {
    const why = outcome === 'cancel' ? 'you cancelled it' : `it was not approved within ${APPROVAL_TIMEOUT_MS / 1000}s`;
    return `🚫 Self-fix aborted — ${why}. Nothing was changed.`;
  }

  state.begin();
  await invocation.message?.channel
    ?.send(`🛠️ Approval received — running in the remote GitHub Actions sandbox with \`${devModel}\`. I will wait for the PR to merge before restarting.`)
    .catch(() => {});

  try {
    const result = await runSandbox({
      repo: config.developmentSandboxRepo,
      instruction,
      model: devModel,
      autoMerge: true,
      selfFix: true,
      config,
    });
    if (!result.ok) return finish('self_fix did not land', result.summary);

    invocation.requestRestart = true;
    return finish('self_fix landed — restarting now', `${result.summary}\n\n🔁 Restarting now to apply the merged remote change.`);
  } catch (err) {
    return finish('self_fix crashed', `❌ Remote sandbox failed: ${String(err.message || err).slice(0, 500)}`);
  } finally {
    state.end();
  }
}
