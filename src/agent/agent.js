import { chatCompletion } from './openrouter.js';
import { buildSystemPrompt } from './systemPrompt.js';
import { toolDefs, executeTool, OWNER_ONLY_TOOLS } from './tools/index.js';
import { decide } from './jev.js';
import { redactSecrets } from '../config.js';

const TOOL_RESULT_CAP = 12000;
const PICK_THRESHOLD = 0.8;
// Tuned against jev-1.13: plain chat scores every tool under 0.5, and clear
// requests score the right one 0.57–0.97. A spare pick is cheap, because the
// model only calls the picked tools it needs.
const TOOL_THRESHOLD = 0.5;

const clip = (v, n = 200) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > n ? `${s.slice(0, n)}…(${s.length} chars)` : s;
};
const log = (tag, ...parts) => console.log(`[agent ${tag}]`, ...parts);
// No letters or digits once custom emotes are removed: only emoji and punctuation.
export const saysNothing = (text) => !/[\p{L}\p{N}]/u.test(text.replace(/<a?:\w+:\d+>/g, ''));

// One turn, at most two model calls after one Jev call:
// 1. Jev (triage) decides in what form to answer, and which tools run:
//    a yes/no per tool. The model never adds a tool of its own.
// 2. If Jev picked any, one model call fills in their arguments and they all run at once.
// 3. One model call writes the reply from the results, with no tools left.
// Jev down means no tools: the model answers from what it was shown.
//
// What the turn refers to comes from the recent messages the handler puts above
// it (`invocation.recent`), not from searching history.
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
  log(contextKey, `triage: signOff=${plan.signOff} tools=${plan.tools.join(',') || 'none'} form=${plan.form ?? 'text'}`);
  // A goodbye gets a wave and nothing else, so the conversation can end.
  if (plan.signOff) {
    await invocation.message.react('👋').then(() => (invocation.reacted = true), () => {});
    return '';
  }
  const locked = plan.tools.find((name) => OWNER_ONLY_TOOLS.has(name));
  if (locked && !invocation.isOwner) return `Only Oscar can use \`${locked}\`.`;

  let step = 0;
  const ask = async (msgs, tools, toolChoice) => {
    const callStart = Date.now();
    const msg = await chat({ apiKey: config.openrouterApiKey, model: config.model, messages: msgs, tools, toolChoice });
    log(contextKey, `model #${++step} ${Date.now() - callStart}ms → ${
      msg.tool_calls?.length ? `tools: ${msg.tool_calls.map((c) => c.function.name).join(', ')}` : `text (${(msg.content || '').length} chars)`
    }`);
    return msg;
  };

  // A reaction is a tool call too, so the forms that react offer `react` with Jev's picks.
  const picked = new Set(plan.form === 'reaction' || plan.form === 'both' ? [...plan.tools, 'react'] : plan.tools);
  const offered = allTools.filter((t) => picked.has(t.function.name));
  if (offered.length) {
    const pickNote = {
      role: 'user',
      content: `[TOOLS] Picked for this turn: ${[...picked].join(', ')}. Call the ones that help, all in this one reply, with the arguments the turn needs. There is no second round: you answer from their results.`,
    };
    const msg = await ask([...messages, pickNote], offered, 'required');
    // Only Jev's picks run, whatever else the model tries to call.
    const calls = (msg.tool_calls ?? []).filter((c) => picked.has(c.function?.name));
    if (calls.length) {
      messages.push({ role: 'assistant', content: msg.content ?? '', tool_calls: calls });
      (invocation.toolsUsed ??= []).push(...calls.map((c) => c.function.name));
      // Everything runs at once, except reactions, which keep their order (they can spell a word).
      let reactions = Promise.resolve();
      const run = (call) => runTool(call, invocation, contextKey);
      messages.push(...(await Promise.all(calls.map((call) => (call.function.name === 'react' ? (reactions = reactions.then(() => run(call))) : run(call))))));
    }
    // A reaction-only turn ends at its reaction, so the model can't add "Got it".
    if (plan.form === 'reaction' && invocation.reacted) {
      log(contextKey, `turn done (reaction only) in ${Date.now() - turnStart}ms after ${step} model call(s)`);
      return '';
    }
  }

  // Tools stay listed (some providers reject tool results without them) but can't be called.
  const ran = messages.some((m) => m.role === 'tool');
  const msg = await ask(messages, ran ? offered : [], 'none');
  const text = msg.content?.trim() || '';
  log(contextKey, `turn done in ${Date.now() - turnStart}ms after ${step} model call(s)`);
  // After a reaction, poll or card, a reply with no words (usually the same
  // emoji echoed) is dropped: something was already sent.
  if ((invocation.reacted || invocation.posted) && saysNothing(text)) return '';
  return text || '🐼 …';
  } catch (err) {
    log(contextKey, `turn failed after ${Date.now() - turnStart}ms: ${err.message || err}`);
    throw err;
  }
}

async function runTool(call, invocation, contextKey) {
  const name = call.function.name;
  const toolStart = Date.now();
  log(contextKey, `→ ${name}(${clip(call.function.arguments || '{}', 300)})`);
  let result;
  try {
    result = await executeTool(name, JSON.parse(call.function.arguments || '{}'), invocation);
  } catch (err) {
    result = `Tool ${name} crashed: ${String(err.message || err).slice(0, 300)}`;
    console.error(`[agent ${contextKey}] ✗ ${name} crashed:`, err);
  }
  log(contextKey, `← ${name} ${Date.now() - toolStart}ms: ${clip(String(result))}`);
  return { role: 'tool', tool_call_id: call.id, content: redactSecrets(result).slice(0, TOOL_RESULT_CAP) };
}

// The one Jev call of every turn, made once the turn is known to be for Panda
// (forPanda in messageHandler.js). Its answers are applied in order by runAgent:
// 1. is it a sign-off?
// 2. which tools does it need? One yes/no per tool, so several can run at once.
// 3. should Panda react, reply in text, or both?
// Jev down, or unsure of an answer, means no tools and a text reply.
async function triage(tools, message, invocation, decideImpl) {
  const { config } = invocation;
  const author = invocation.message?.author;
  const state = {
    message,
    recent_messages: invocation.recent || '(none)',
    sender: `${author?.displayName || author?.username || 'someone'}${invocation.isOwner ? ' (Oscar, the owner)' : ''}`,
    assistant_name: config.botName,
    owner_name: 'Oscar',
  };
  const questions = {
    bye: { type: 'noul', instructions: 'Is `message` a sign-off that ends the conversation without asking for or offering anything more?' },
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
  // react is not asked about: the response form decides it.
  const asked = tools.filter((t) => t.function.name !== 'react');
  for (const t of asked) {
    const what = String(t.function.description || '').replace(/^OWNER ONLY\.\s*/, '').slice(0, 300);
    questions[`use_${t.function.name}`] = {
      type: 'noul',
      instructions: `Should the assistant call the \`${t.function.name}\` tool to handle \`message\`? Read \`message\` together with \`recent_messages\`, which say what it refers to. The tool: ${what}`,
    };
  }
  const answers = await decideImpl(config, state, questions);
  const sureOf = (a) => a?.probabilities?.[a.choice] ?? a?.confidence ?? 0;

  const picked = asked.map((t) => t.function.name).filter((name) => answers?.[`use_${name}`]?.noul >= TOOL_THRESHOLD);
  // A wrong "reaction only" leaves a question unanswered, so that one needs Jev to be sure.
  const form = answers?.respond_with;
  const valid = ['reaction', 'message', 'both'].includes(form?.choice) && (form.choice !== 'reaction' || sureOf(form) >= PICK_THRESHOLD);
  return { signOff: answers?.bye?.noul >= PICK_THRESHOLD, tools: picked, form: valid ? form.choice : null };
}
