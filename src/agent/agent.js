import { chatCompletion } from './openrouter.js';
import { buildSystemPrompt } from './systemPrompt.js';
import { toolDefs, executeTool } from './tools/index.js';

const TOOL_RESULT_CAP = 12000;

// The agent loop: system + per-server history + new envelope → model → execute
// tool calls → repeat until plain text (or iteration cap). Returns reply text.
export async function runAgent(invocation, userContent) {
  const { contextStore, config, contextKey } = invocation;
  const history = contextStore.get(contextKey);
  const messages = [
    { role: 'system', content: buildSystemPrompt(invocation) },
    ...history,
    { role: 'user', content: userContent },
  ];
  const newMessages = [{ role: 'user', content: userContent }];

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
  invocation.contextStore.append(invocation.contextKey, newMessages);
}
