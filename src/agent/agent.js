import { chatCompletion } from './openrouter.js';
import { buildSystemPrompt } from './systemPrompt.js';
import { toolDefs, executeTool } from './tools/index.js';
import { rememberEvicted } from './memory.js';

const TOOL_RESULT_CAP = 12000;

// The agent loop: system + memory + per-server history + new envelope → model →
// execute tool calls → repeat until plain text (or iteration cap). Returns reply
// text.
//
// `rememberContent` is what goes into long-term memory, and it is deliberately
// not `userContent`: the turn is sent with a block of recent channel history for
// context, and storing that too meant every turn wrote ten already-stored
// messages back into memory. Six turns of that filled the transcript with
// duplicates of itself, evicted the real conversation, and left the model
// reading its own "do NOT reply to these" blocks as if they were prior turns.
export async function runAgent(invocation, userContent, rememberContent = userContent) {
  const { contextStore, config, contextKey } = invocation;
  const history = contextStore.get(contextKey);
  const summary = contextStore.summary?.(contextKey) || '';
  const messages = [
    { role: 'system', content: buildSystemPrompt(invocation) },
    ...(summary ? [{ role: 'system', content: `## What you remember about this server\n${summary}` }] : []),
    ...history,
    { role: 'user', content: userContent },
  ];
  const newMessages = [{ role: 'user', content: rememberContent }];

  for (let iteration = 0; iteration < config.maxToolIterations; iteration++) {
    const msg = await chatCompletion({
      apiKey: config.openrouterApiKey,
      model: config.model,
      messages,
      tools: toolDefs(),
    });

    const assistant = { role: 'assistant', content: msg.content ?? '' };
    if (msg.tool_calls?.length) assistant.tool_calls = msg.tool_calls;
    messages.push(assistant);
    newMessages.push(assistant);

    if (!msg.tool_calls?.length) {
      persist(invocation, newMessages);
      // Empty text is allowed when the model already reacted with an emoji —
      // the handler then sends nothing. Otherwise fall back to a placeholder.
      const text = msg.content?.trim() || '';
      if (text) return text;
      return invocation.reacted ? '' : '🐼 …';
    }

    for (const call of msg.tool_calls) {
      let result;
      try {
        const args = JSON.parse(call.function.arguments || '{}');
        result = await executeTool(call.function.name, args, invocation);
      } catch (err) {
        result = `Tool ${call.function.name} crashed: ${String(err.message || err).slice(0, 300)}`;
      }
      const toolMsg = {
        role: 'tool',
        tool_call_id: call.id,
        content: String(result).slice(0, TOOL_RESULT_CAP),
      };
      messages.push(toolMsg);
      newMessages.push(toolMsg);
    }
  }

  persist(invocation, newMessages);
  return '⚠️ I hit my tool-use limit before finishing that. Progress is saved — tell me to continue.';
}

function persist(invocation, newMessages) {
  if (invocation.contextCleared) return;
  const evicted = invocation.contextStore.append(invocation.contextKey, newMessages);
  // Summarising costs a model call, so it happens after the reply is on its way
  // rather than in front of it.
  rememberEvicted({ store: invocation.contextStore, key: invocation.contextKey, evicted, config: invocation.config });
}
