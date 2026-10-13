import { chatCompletion, providerFor } from '../openrouter.js';
import { loadPrompt, writePrompt } from '../prompts.js';
import { addRule as addToFile, removeRule as removeFromFile } from '../rulesFile.js';

export const defs = [
  {
    type: 'function',
    function: {
      name: 'set_rule',
      description:
        "Rewrite your soul.md, the description of your personality, as a whole. Call it only when Oscar explicitly asks to rewrite or edit soul.md or your personality description itself. For anything to remember or any rule to follow from now on (always, never, be more or less…), use add_rule instead; to stop one, remove_rule. Pass his instruction in his own words. Oscar only.",
      parameters: {
        type: 'object',
        properties: {
          instruction: { type: 'string', description: "What to change, in Oscar's words." },
        },
        required: ['instruction'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_rule',
      description:
        "Save a standing rule in your rules file (RULES.md). Every reply you write from the next message on follows every rule in it. Call it whenever Oscar tells you to remember something or follow a rule from now on: \"remember that…\", \"always…\", \"never…\", \"don't respond to X\", \"be meaner\", \"answer everything with a question\" or \"with a joke\". Write the rule as one clear instruction to yourself, keeping his meaning (names with their ids when he names someone). Oscar only.",
      parameters: {
        type: 'object',
        properties: {
          rule: { type: 'string', description: 'The rule, as one instruction to yourself, e.g. "Never respond to Rice (id:123)."' },
        },
        required: ['rule'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remove_rule',
      description:
        "Delete a rule from your rules file (RULES.md) when Oscar tells you to stop doing something, forget something or drop a rule (\"stop being mean\", \"you can talk to X again\", \"forget rule 2\"). Give the rule's `number` from the numbered list of your rules, or `match`, text that the rule contains. Oscar only.",
      parameters: {
        type: 'object',
        properties: {
          number: { type: 'integer', description: 'The rule number shown in your rules list (1 is the first).' },
          match: { type: 'string', description: 'Text the rule contains; every rule containing it is removed.' },
        },
      },
    },
  },
];

// add_rule and remove_rule edit RULES.md (src/agent/rulesFile.js); the system
// prompt reads it on every turn, so the change applies from the next message.
const listed = (rules) => (rules.length ? rules.map((r, i) => `${i + 1}. ${r}`).join('\n') : '(no rules)');

export async function addRule({ rule = '' } = {}, invocation) {
  if (!String(rule).trim()) return 'Tell me the rule to save.';
  try {
    const { added, rules } = await addToFile(invocation.config, rule);
    return `${added ? '✅ Rule saved to RULES.md; it applies from the next message.' : 'That rule is already in RULES.md; nothing changed.'}\n\nRules now:\n${listed(rules)}`;
  } catch (err) {
    return `I couldn't save the rule to RULES.md, so nothing changed: ${String(err.message || err).slice(0, 200)}`;
  }
}

export async function removeRule({ number, match = '' } = {}, invocation) {
  if (!number && !String(match).trim()) return 'Give the rule number or text the rule contains.';
  try {
    const { removed, rules } = await removeFromFile(invocation.config, { number, match });
    if (!removed.length) return `No rule ${number ? `number ${number}` : `containing "${match}"`} is in RULES.md; nothing changed.\n\nRules now:\n${listed(rules)}`;
    return `✅ Removed from RULES.md:\n${removed.map((r) => `- ${r}`).join('\n')}\n\nRules now:\n${listed(rules)}`;
  } catch (err) {
    return `I couldn't update RULES.md, so nothing changed: ${String(err.message || err).slice(0, 200)}`;
  }
}

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

  const { model } = config;
  let next;
  try {
    const msg = await chat({
      apiKey: config.openrouterApiKey,
      model,
      provider: providerFor(config, model),
      messages: [
        { role: 'system', content: REWRITE },
        { role: 'user', content: `--- identity.md ---\n${identity}\n\n--- current soul.md ---\n${current}\n\n--- instruction ---\n${ask}` },
      ],
    });
    next = stripFences(msg?.content);
  } catch (err) {
    return `The model (${model}) failed, so nothing changed: ${String(err.message || err).slice(0, 200)}`;
  }
  if (!next) return `The model (${model}) returned nothing, so nothing changed.`;
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
