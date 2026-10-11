import { chatCompletion } from '../openrouter.js';
import { getAIConfig } from '../../configManager.js';
import { loadPrompt, writePrompt } from '../prompts.js';

export const defs = [
  {
    type: 'function',
    function: {
      name: 'set_rule',
      description:
        "Change your personality for good: behavior, vibe, tone, attitude, habits. It rewrites your soul.md with the development model, and the change applies from the next message on. Call it whenever Oscar tells you to behave differently from now on (always, never, stop, start, be more or less…). Pass his instruction in his own words. Oscar only.",
      parameters: {
        type: 'object',
        properties: {
          instruction: { type: 'string', description: "What to change, in Oscar's words." },
        },
        required: ['instruction'],
      },
    },
  },
];

const REWRITE = `You maintain soul.md, the part of a Discord bot's instructions that sets its personality: behavior, vibe, tone and attitude.
You are given the current soul.md, the bot's fixed identity.md (for reference only: never copy it into soul.md and never contradict it), and an instruction from the bot's owner.
Return the complete new soul.md with the instruction applied. Add, change or remove only what the instruction asks; keep everything else as it is, in the same Markdown style.
Reply with ONLY the file content, with no code fences and no comments.`;

const stripFences = (text) => String(text ?? '').trim().replace(/^```(?:markdown|md)?\n([\s\S]*?)\n```$/i, '$1').trim();

// Oscar only (OWNER_ONLY_TOOLS). The replaced soul.md is kept as history/soul-….md
// before anything is written, so a bad rewrite can always be undone.
export async function setRule({ instruction = '' } = {}, invocation, { chat = chatCompletion } = {}) {
  const ask = String(instruction).trim();
  if (!ask) return 'Tell me what to change about my personality or behavior.';
  const { config } = invocation;
  let current;
  let identity;
  try {
    [current, identity] = await Promise.all([loadPrompt(config, 'soul.md'), loadPrompt(config, 'identity.md')]);
  } catch (err) {
    return `I couldn't read my prompts from the database, so nothing changed: ${String(err.message || err).slice(0, 200)}`;
  }

  const { model } = getAIConfig('development');
  let next;
  try {
    const msg = await chat({
      apiKey: config.openrouterApiKey,
      model,
      messages: [
        { role: 'system', content: REWRITE },
        { role: 'user', content: `--- identity.md ---\n${identity}\n\n--- current soul.md ---\n${current}\n\n--- instruction ---\n${ask}` },
      ],
    });
    next = stripFences(msg?.content);
  } catch (err) {
    return `The development model (${model}) failed, so nothing changed: ${String(err.message || err).slice(0, 200)}`;
  }
  if (!next) return `The development model (${model}) returned nothing, so nothing changed.`;
  if (next === current.trim()) return 'That is already how I behave; soul.md is unchanged.';

  const backup = `history/soul-${new Date().toISOString().replace(/[:.]/g, '-')}.md`;
  try {
    await writePrompt(config, backup, current);
    await writePrompt(config, 'soul.md', `${next}\n`);
  } catch (err) {
    return `I couldn't save soul.md, so nothing changed: ${String(err.message || err).slice(0, 200)}`;
  }
  return `✅ soul.md updated with \`${model}\`. The old version is saved as \`${backup}\`.\n\nNew soul.md:\n${next}`;
}
