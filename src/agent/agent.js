import { chatCompletion } from './openrouter.js';
import { buildSystemPrompt } from './systemPrompt.js';
import { toolDefs, executeTool, OWNER_ONLY_TOOLS } from './tools/index.js';
import { decide } from './jev.js';
import { redactSecrets } from '../config.js';

const TOOL_RESULT_CAP = 12000;
const PICK_THRESHOLD = 0.8;
const force = (name) => ({ type: 'function', function: { name } });

const clip = (v, n = 200) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > n ? `${s.slice(0, n)}…(${s.length} chars)` : s;
};
const log = (tag, ...parts) => console.log(`[agent ${tag}]`, ...parts);
// No letters or digits once custom emotes are removed: only emoji and punctuation.
export const saysNothing = (text) => !/[\p{L}\p{N}]/u.test(text.replace(/<a?:\w+:\d+>/g, ''));

// The agent loop: system prompt + the batch → model → execute tool calls →
// repeat until plain text (or iteration cap). Returns reply text, or null when
// Panda was only mentioned and Jev decided it should stay out.
//
// There is no stored transcript and no summary: the turn is only the batch, and
// the model calls fetch_history or index_chat when it needs earlier messages.
//
// `turnText` is the batch as plain text for Jev; `userContent` may also carry
// media attachments, which only the model sees.
export async function runAgent(invocation, userContent, turnText = userContent, { chat = chatCompletion, decideImpl = decide } = {}) {
  const { config, contextKey } = invocation;
  const who = invocation.message?.author?.username ?? '?';
  const turnStart = Date.now();
  log(contextKey, `turn start from @${who} (model ${config.model}): ${clip(turnText, 150)}`);

  try {
  const [allTools, system] = await Promise.all([toolDefs(invocation), buildSystemPrompt(invocation)]);
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: userContent },
  ];
  const plan = await triage(allTools, turnText, invocation, decideImpl);
  log(contextKey, `triage: respond=${plan.respond} signOff=${plan.signOff} tool=${plan.tool ?? 'none'} form=${plan.form ?? 'model decides'}`);
  // Not for Panda after all: say nothing and save nothing.
  if (!plan.respond) return null;
  invocation.onAccept?.();
  // A goodbye gets a wave and nothing else, so the conversation can end.
  if (plan.signOff) {
    await invocation.message.react('👋').then(() => (invocation.reacted = true), () => {});
    return '';
  }
  if (plan.tool && OWNER_ONLY_TOOLS.has(plan.tool) && !invocation.isOwner) return `Only Oscar can use \`${plan.tool}\`.`;
  // A text-only reply has no react tool; the other two forms must react.
  const tools = plan.form === 'message' ? allTools.filter((t) => t.function.name !== 'react') : allTools;
  for (let iteration = 0; iteration < config.maxToolIterations; iteration++) {
    const callStart = Date.now();
    // Jev's tool goes first. Until a reaction the form needs is made, the model may
    // not answer in text: 'required' lets it look things up first, and react several
    // times in one step, which forcing `react` would not. A wrong tool pick costs one call.
    const toolChoice =
      iteration === 0 && plan.tool ? force(plan.tool)
      : plan.form && plan.form !== 'message' && !invocation.reacted ? 'required'
      : 'auto';
    const msg = await chat({
      apiKey: config.openrouterApiKey,
      model: config.model,
      messages,
      tools,
      toolChoice,
    });

    log(contextKey, `model #${iteration + 1} ${Date.now() - callStart}ms → ${
      msg.tool_calls?.length ? `tools: ${msg.tool_calls.map((c) => c.function.name).join(', ')}` : `text (${(msg.content || '').length} chars)`
    }`);

    const assistant = { role: 'assistant', content: msg.content ?? '' };
    if (msg.tool_calls?.length) assistant.tool_calls = msg.tool_calls;
    messages.push(assistant);

    if (!msg.tool_calls?.length) {
      // Empty text is allowed when the model already reacted with an emoji —
      // the handler then sends nothing. Otherwise fall back to a placeholder.
      const text = msg.content?.trim() || '';
      log(contextKey, `turn done in ${Date.now() - turnStart}ms after ${iteration + 1} model call(s)`);
      // After a reaction, poll or card, a reply with no words (usually the same
      // emoji echoed) is dropped: something was already sent.
      if ((invocation.reacted || invocation.posted) && saysNothing(text)) return '';
      return text || '🐼 …';
    }

    for (const call of msg.tool_calls) {
      let result;
      const toolStart = Date.now();
      log(contextKey, `→ ${call.function.name}(${clip(call.function.arguments || '{}', 300)})`);
      try {
        const args = JSON.parse(call.function.arguments || '{}');
        result = await executeTool(call.function.name, args, invocation);
      } catch (err) {
        result = `Tool ${call.function.name} crashed: ${String(err.message || err).slice(0, 300)}`;
        console.error(`[agent ${contextKey}] ✗ ${call.function.name} crashed:`, err);
      }
      log(contextKey, `← ${call.function.name} ${Date.now() - toolStart}ms: ${clip(String(result))}`);
      const toolMsg = {
        role: 'tool',
        tool_call_id: call.id,
        content: redactSecrets(result).slice(0, TOOL_RESULT_CAP),
      };
      messages.push(toolMsg);
    }
    // A reaction-only turn ends at its first reaction, so the model can't add "Got it".
    if (plan.form === 'reaction' && invocation.reacted) {
      log(contextKey, `turn done (reaction only) in ${Date.now() - turnStart}ms after ${iteration + 1} model call(s)`);
      return '';
    }
  }

  log(contextKey, `hit tool-use limit (${config.maxToolIterations}) after ${Date.now() - turnStart}ms`);
  // A card or poll posted on the last step is the answer; a warning under it reads as a failure.
  return invocation.posted ? '' : '⚠️ I hit my tool-use limit before finishing that. Ask again, maybe a narrower version.';
  } catch (err) {
    log(contextKey, `turn failed after ${Date.now() - turnStart}ms: ${err.message || err}`);
    throw err;
  }
}

// The one Jev call of every turn. Its answers are applied in order by runAgent:
// 1. a mention-only message (no ping or reply): is it for Panda, or should Panda step in?
// 2. is it a sign-off?
// 3. does it need a tool, and which one first?
// 4. should Panda react, reply in text, or both?
// Jev down, or unsure of an answer, leaves that decision to the model, except
// that a mention-only message then gets no answer at all.
async function triage(tools, message, invocation, decideImpl) {
  const { config } = invocation;
  // react is not a tool pick: the response form decides it.
  const criteria = {};
  for (const t of tools) if (t.function.name !== 'react') criteria[t.function.name] = String(t.function.description || '').slice(0, 300);
  const state = { message, assistant_name: config.botName, owner_name: 'Oscar' };
  const questions = {
    ...(invocation.mayDecline && {
      addressed: {
        type: 'noul',
        instructions:
          "Is `message` speaking to the assistant, asking or telling it something? It may be called `assistant_name`, `owner_name`'s assistant, the assistant of `owner_name`, the bot, or anything else that clearly means it.",
      },
      step_in: {
        type: 'noul',
        instructions:
          'Is `message` talking about the assistant in a way where it should step in: a question about it nobody has answered, something wrong said about it, or someone who clearly wants its help?',
      },
    }),
    bye: { type: 'noul', instructions: 'Is `message` a sign-off that ends the conversation without asking for or offering anything more?' },
    needs_tool: {
      type: 'noul',
      instructions:
        'Does handling `message` need one of the tools: looking something up, reading earlier messages, or taking an action? No when the assistant can answer from what it already knows, or only needs to react or chat.',
    },
    tool: { type: 'choice', instructions: 'Which tool should the assistant call first to handle `message`?', criteria },
    respond_with: {
      type: 'choice',
      instructions: 'How should the assistant respond to `message`?',
      criteria: {
        reaction: 'Only emoji reactions, no text: a social beat (thanks, lol, gg, agreement, a cool picture), or `message` asks it to just react or not reply.',
        message: 'Only a text reply: a question, a request, or something worth saying.',
        both: 'Emoji reactions plus a text reply: `message` asks for both, or its tone is worth acknowledging and it also needs an answer.',
      },
    },
  };
  const answers = await decideImpl(config, state, questions);
  const sureOf = (a) => a?.probabilities?.[a.choice] ?? a?.confidence ?? 0;

  const respond = !invocation.mayDecline || [answers?.addressed, answers?.step_in].some((a) => a?.noul >= PICK_THRESHOLD);
  // Jev picks a tool even for "thanks", so a pick only counts when it also says one is needed.
  const pick = answers?.tool;
  const tool = answers?.needs_tool?.noul >= 0.5 && pick?.choice in criteria && sureOf(pick) >= PICK_THRESHOLD ? pick.choice : null;
  // A wrong "reaction only" leaves a question unanswered, so that one needs Jev to be sure.
  const form = answers?.respond_with;
  const valid = ['reaction', 'message', 'both'].includes(form?.choice) && (form.choice !== 'reaction' || sureOf(form) >= PICK_THRESHOLD);
  return { respond, signOff: answers?.bye?.noul >= PICK_THRESHOLD, tool, form: valid ? form.choice : null };
}
