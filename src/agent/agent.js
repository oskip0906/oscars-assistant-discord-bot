import { chatCompletion } from './openrouter.js';
import { buildSystemPrompt } from './systemPrompt.js';
import { toolDefs, executeTool } from './tools/index.js';
import { rememberTurn } from './memory.js';
import { decide } from './jev.js';

const TOOL_RESULT_CAP = 12000;
const PICK_THRESHOLD = 0.8;

const clip = (v, n = 200) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > n ? `${s.slice(0, n)}…(${s.length} chars)` : s;
};
const log = (tag, ...parts) => console.log(`[agent ${tag}]`, ...parts);
// No letters or digits once custom emotes are removed: only emoji and punctuation.
export const saysNothing = (text) => !/[\p{L}\p{N}]/u.test(text.replace(/<a?:\w+:\d+>/g, ''));

// The agent loop: system + memory summary + new envelope → model →
// execute tool calls → repeat until plain text (or iteration cap). Returns reply
// text, or null when Panda was only mentioned and Jev decided it should stay out.
//
// There is no stored transcript and no history block: the turn is only the
// batch, and the model calls fetch_history when it needs earlier messages.
//
// `rememberContent` is what goes into long-term memory, and it is deliberately
// not `userContent`: media attachments go to the model for this turn only.
export async function runAgent(invocation, userContent, rememberContent = userContent, { chat = chatCompletion, decideImpl = decide } = {}) {
  const { contextStore, config, contextKey } = invocation;
  const summary = contextStore.summary?.(contextKey) || '';
  const messages = [
    { role: 'system', content: buildSystemPrompt(invocation) },
    ...(summary ? [{ role: 'system', content: `## What you remember about this server\n${summary}` }] : []),
    { role: 'user', content: userContent },
  ];
  const newMessages = [{ role: 'user', content: rememberContent }];
  const who = invocation.message?.author?.username ?? '?';
  const turnStart = Date.now();
  log(contextKey, `turn start from @${who} (model ${config.model}): ${clip(rememberContent, 150)}`);

  // A turn that dies at the model call is still remembered: the question is
  // usually the one thing left open.
  try {
  const tools = await toolDefs(invocation);
  // A ping or reply goes straight to the model. A mention-only turn asks Jev
  // first, which also names the tool to start with: when it is sure, the first
  // call is made to use it rather than answering from memory. Later iterations
  // go back to 'auto', so a wrong pick costs one call, not the turn.
  const { respond, tool: firstTool } = invocation.mayDecline
    ? await triage(tools, rememberContent, invocation, decideImpl)
    : { respond: true, tool: null };
  if (invocation.mayDecline) log(contextKey, `triage: respond=${respond} firstTool=${firstTool ?? 'none'}`);
  // Not for Panda after all: say nothing and remember nothing.
  if (!respond) return null;
  invocation.onAccept?.();
  for (let iteration = 0; iteration < config.maxToolIterations; iteration++) {
    const callStart = Date.now();
    const msg = await chat({
      apiKey: config.openrouterApiKey,
      model: config.model,
      messages,
      tools,
      toolChoice: iteration === 0 && firstTool ? { type: 'function', function: { name: firstTool } } : 'auto',
    });

    log(contextKey, `model #${iteration + 1} ${Date.now() - callStart}ms → ${
      msg.tool_calls?.length ? `tools: ${msg.tool_calls.map((c) => c.function.name).join(', ')}` : `text (${(msg.content || '').length} chars)`
    }`);

    const assistant = { role: 'assistant', content: msg.content ?? '' };
    if (msg.tool_calls?.length) assistant.tool_calls = msg.tool_calls;
    messages.push(assistant);
    newMessages.push(assistant);

    if (!msg.tool_calls?.length) {
      persist(invocation, newMessages);
      // Empty text is allowed when the model already reacted with an emoji —
      // the handler then sends nothing. Otherwise fall back to a placeholder.
      const text = msg.content?.trim() || '';
      log(contextKey, `turn done in ${Date.now() - turnStart}ms after ${iteration + 1} model call(s)`);
      // After a reaction, a reply with no words (usually the same emoji echoed) is dropped.
      if (invocation.reacted && saysNothing(text)) return '';
      return text || '🐼 …';
    }

    // A step that only reacts, without asking to reply, is the whole response:
    // the turn ends here, so the model can't add "Got it" afterwards.
    let reactOnly = msg.tool_calls.every((c) => c.function.name === 'react');
    for (const call of msg.tool_calls) {
      let result;
      const toolStart = Date.now();
      log(contextKey, `→ ${call.function.name}(${clip(call.function.arguments || '{}', 300)})`);
      try {
        const args = JSON.parse(call.function.arguments || '{}');
        if (args.reply === true) reactOnly = false;
        result = await executeTool(call.function.name, args, invocation);
      } catch (err) {
        result = `Tool ${call.function.name} crashed: ${String(err.message || err).slice(0, 300)}`;
        console.error(`[agent ${contextKey}] ✗ ${call.function.name} crashed:`, err);
      }
      log(contextKey, `← ${call.function.name} ${Date.now() - toolStart}ms: ${clip(String(result))}`);
      const toolMsg = {
        role: 'tool',
        tool_call_id: call.id,
        content: String(result).slice(0, TOOL_RESULT_CAP),
      };
      messages.push(toolMsg);
      newMessages.push(toolMsg);
    }
    if (reactOnly && invocation.reacted) {
      persist(invocation, newMessages);
      log(contextKey, `turn done (reaction only) in ${Date.now() - turnStart}ms after ${iteration + 1} model call(s)`);
      return '';
    }
  }

  log(contextKey, `hit tool-use limit (${config.maxToolIterations}) after ${Date.now() - turnStart}ms`);
  persist(invocation, newMessages);
  return '⚠️ I hit my tool-use limit before finishing that. Ask again, maybe a narrower version.';
  } catch (err) {
    log(contextKey, `turn failed after ${Date.now() - turnStart}ms: ${err.message || err}`);
    persist(invocation, newMessages);
    throw err;
  }
}

// The one Jev call for a turn where Panda was only mentioned (a keyword hit,
// no ping or reply): should Panda answer, because the message is speaking to it
// under any name or because people are talking about it and stepping in would
// help, and which tool should it start with. Jev down means no answer, as before.
async function triage(tools, message, invocation, decideImpl) {
  const { config } = invocation;
  const criteria = { none: 'No tool is needed: a plain text reply answers it.' };
  for (const t of tools) criteria[t.function.name] = String(t.function.description || '').slice(0, 300);
  const state = { message, assistant_name: config.botName, owner_name: 'Oscar' };
  const questions = {
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
    tool: { type: 'choice', instructions: 'Which tool should the assistant call first to handle `message`?', criteria },
  };
  const answers = await decideImpl(config, state, questions);
  const respond = [answers?.addressed, answers?.step_in].some((a) => a?.noul >= PICK_THRESHOLD);

  const answer = answers?.tool;
  if (!answer || answer.choice === 'none' || !(answer.choice in criteria)) return { respond, tool: null };
  const sure = (answer.probabilities?.[answer.choice] ?? answer.confidence ?? 0) >= PICK_THRESHOLD;
  return { respond, tool: sure ? answer.choice : null };
}

function persist(invocation, newMessages) {
  if (invocation.contextCleared) return;
  // Summarising costs a model call, so it happens after the reply is on its way
  // rather than in front of it.
  rememberTurn({ store: invocation.contextStore, key: invocation.contextKey, messages: newMessages, config: invocation.config });
}
