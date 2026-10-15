import { chatCompletion, providerFor } from './openrouter.js';
import { buildSystemPrompt, myNames, NO_REPLY } from './systemPrompt.js';
import { toolDefs, executeTool, OWNER_ONLY_TOOLS, isLookup } from './tools/index.js';
import { decide, sampleChoice } from './jev.js';
import { redactSecrets } from '../config.js';
import { reactOnce } from '../discord/reactions.js';

const TOOL_RESULT_CAP = 12000;
const PICK_THRESHOLD = 0.8;
// Tuned against jev-1.13: plain chat scores every tool under 0.5, and clear
// requests score the right one 0.57–0.97. A spare pick is cheap, because the
// model only calls the picked tools it needs.
const TOOL_THRESHOLD = 0.5;
// At most this many model calls a turn: rounds of tool calls, then the answer.
export const MAX_MODEL_CALLS = 5;
// A turn Jev thinks is owed words this much (a question to Panda, a reply to
// something it said) is never reaction-only.
const NEEDS_WORDS = 0.5;
// Tuned against jev-1.13: casual chat and simple requests score 0.03–0.12, hard ones (a proof, a deadlock, a puzzle, a tradeoff) 0.48–0.84.
const THINK_THRESHOLD = 0.4;

// Emoji to vary reactions by the mood Jev reads. A few are offered at random each
// turn so Panda doesn't put 😂 on everything; the model may still pick its own.
export const MOOD_EMOJI = {
  funny: ['😂', '🤣', '💀', '😭', '😹', '🫠', '😆', '🤭', '😏', '🙈'],
  happy: ['🎉', '🥳', '😊', '🙌', '✨', '💯', '🔥', '🫶', '😄', '🤩'],
  sad: ['🫂', '😢', '🥺', '💙', '😔', '🤍', '🙏', '❤️‍🩹'],
  angry: ['😤', '😠', '😬', '🙃', '😮‍💨', '💢', '🫡', '🤝'],
  neutral: ['👍', '👀', '🤔', '👌', '🐼', '✅', '🙏', '🫡', '💭', '🆗'],
};
const MOOD_NOTE = {
  funny: 'it is joking around: play along, be quick and witty, never explain the joke.',
  happy: 'it is happy or excited: share the excitement.',
  sad: 'it is sad or down: be warm and supportive, no jokes, no lecture.',
  angry: 'it is annoyed or angry: stay calm and on their side, no cheerfulness, no scolding.',
  neutral: 'it is matter-of-fact.',
};

export function moodEmoji(mood, random = Math.random, count = 5) {
  const pool = [...(MOOD_EMOJI[mood] || MOOD_EMOJI.neutral)];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, count);
}

const clip = (v, n = 200) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > n ? `${s.slice(0, n)}…(${s.length} chars)` : s;
};
const log = (tag, ...parts) => console.log(`[agent ${tag}]`, ...parts);
// No letters or digits once custom emotes are removed: only emoji and punctuation.
export const saysNothing = (text) => !/[\p{L}\p{N}]/u.test(text.replace(/<a?:\w+:\d+>/g, ''));
// Nothing to say at all: empty, or only a 🐼 and punctuation ("🐼 …", "...").
// An emoji the model chose ("🔥") is still a reply; this is filler.
export const isNoReply = (text) => String(text ?? '').trim().toUpperCase().replace(/[\s.]+$/, '') === NO_REPLY;
export const isFiller = (text) => !String(text ?? '').replace(/🐼|[\s\p{P}]/gu, '');

// A sign-off: a wave and no words, so the conversation can end. The wave is
// only added if nothing has reacted to the message yet (reactOnce).
export async function signOff(invocation) {
  if (await reactOnce(invocation.message, '👋')) invocation.reacted = true;
  return '';
}

// Opened with whatever lookups need_more_info asks for: searching and reading
// a link go together.
export const CORE_TOOLS = ['web_search', 'web_fetch'];
// The fallback for an action tool Jev did not pick: the model names it, it is
// added for the next round. Handled here, never by executeTool.
export const MORE_TOOLS = 'more_tools';
const moreToolsDef = (names) => ({
  type: 'function',
  function: {
    name: MORE_TOOLS,
    description: 'Add tools that are not listed yet, by name, when the turn needs one of them. They are listed from the next step on.',
    parameters: { type: 'object', properties: { names: { type: 'array', items: { type: 'string', enum: names } } }, required: ['names'] },
  },
});
// Answer first: a turn starts without lookup tools (isLookup). The model answers
// from what it has; only when it can't does it say so here, naming what is
// missing, and the lookups it names (with CORE_TOOLS) open for the next round.
export const NEED_MORE_INFO = 'need_more_info';
const needMoreInfoDef = (names) => ({
  type: 'function',
  function: {
    name: NEED_MORE_INFO,
    description:
      "Only when you can't answer from what's in front of you (the messages, the attachments) and what you know: say what is missing, and pick the lookup tools to get it. They are listed from the next step on. Never to double-check an answer you are sure of.",
    parameters: {
      type: 'object',
      properties: {
        missing: { type: 'string', description: 'What you need to know and do not.' },
        tools: { type: 'array', items: { type: 'string', enum: names }, description: 'The lookup tools to get it.' },
      },
      required: ['missing', 'tools'],
    },
  },
});
const PLUMBING = new Set([MORE_TOOLS, NEED_MORE_INFO]);

// One turn, at most MAX_MODEL_CALLS model calls after one Jev call:
// 1. Jev (triage) decides in what form to answer, the mood, and which tools it
//    expects: a yes/no per tool.
// 2. Answer first. A turn with words is offered the action tools Jev picked
//    (more_tools adds others) and need_more_info, but no lookup tools: the
//    model answers from the turn, the attachments and what it knows. Only when
//    it can't does it call need_more_info, and the lookups it names open for
//    the next round. A reaction-only turn gets Jev's picks and react. Jev's
//    picks are advice: the tool choice is always auto, so a turn the model can
//    answer is one call with no tools. Called tools all run at once. The model
//    may go another round when the results call for it (search, then read a
//    page), and stops as soon as it calls none; words without a call are the answer.
// 3. Otherwise the last call writes the reply from the results, with no tools left.
// Jev down means no picks to go by, so every action tool is offered.
//
// What the turn refers to comes from the recent messages the handler puts above
// it (`invocation.recent`), not from searching history.
//
// `turnText` is the batch as plain text for Jev; `userContent` may also carry
// media attachments, which only the model sees. `invocation.signal` (a stop)
// ends the turn at the next step: no more model calls, tools or reply.
export async function runAgent(invocation, userContent, turnText = userContent, { chat = chatCompletion, decideImpl = decide, random = Math.random } = {}) {
  const { config, contextKey, signal } = invocation;
  const who = invocation.message?.author?.username ?? '?';
  const turnStart = Date.now();
  // Tokens, cost and time of this turn's model calls, shown under the reply.
  const stats = (invocation.stats ??= { inputTokens: 0, outputTokens: 0, cost: 0, modelMs: 0, modelCalls: 0, toolsOffered: 0 });
  const onUsage = (usage) => {
    stats.inputTokens += Number(usage.prompt_tokens) || 0;
    stats.outputTokens += Number(usage.completion_tokens) || 0;
    stats.cost += Number(usage.cost) || 0;
  };
  log(contextKey, `turn start from @${who} (model ${config.model}): ${clip(turnText, 150)}`);

  try {
  const [allTools, system] = await Promise.all([toolDefs(invocation), buildSystemPrompt(invocation)]);
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: userContent },
  ];
  const prepMs = Date.now() - turnStart;
  const plan = await triage(allTools, turnText, invocation, decideImpl, random);
  signal?.throwIfAborted();
  log(contextKey, `triage (prep ${prepMs}ms, jev ${Date.now() - turnStart - prepMs}ms): signOff=${plan.signOff} tools=${plan.tools.join(',') || 'none'} form=${plan.form ?? 'text'} mood=${plan.mood ?? '?'} lookup=${plan.needsContext} think=${plan.think}${plan.jevDown ? ' (jev down)' : ''}`);
  // A goodbye gets a wave and nothing else, so the conversation can end.
  if (plan.signOff) return signOff(invocation);
  // An Oscar-only lookup (query_db) Jev picks for a guest's question is just never offered; only an action stops the turn.
  const locked = plan.tools.find((name) => OWNER_ONLY_TOOLS.has(name) && !isLookup(name));
  if (locked && !invocation.isOwner) return `Only Oscar can use \`${locked}\`.`;

  const ask = async (msgs, tools, toolChoice) => {
    const callStart = Date.now();
    const before = stats.inputTokens;
    let msg;
    try {
      msg = await chat({ apiKey: config.openrouterApiKey, model: config.model, provider: providerFor(config, config.model), messages: msgs, tools, toolChoice, reasoning: plan.think ? { effort: 'low' } : undefined, onUsage, signal });
    } finally {
      stats.modelMs += Date.now() - callStart;
    }
    signal?.throwIfAborted();
    stats.modelCalls = (stats.modelCalls || 0) + 1;
    log(contextKey, `model #${stats.modelCalls} ${Date.now() - callStart}ms, ${tools?.length ?? 0} tools offered, ${stats.inputTokens - before} tokens in → ${
      msg.tool_calls?.length ? `tools: ${msg.tool_calls.map((c) => c.function.name).join(', ')}` : `text (${(msg.content || '').length} chars)`
    }`);
    return msg;
  };

  // Jev's read of the mood shapes the reply's tone and which reactions are offered.
  if (plan.mood) messages.push({ role: 'user', content: `[TONE] Jev reads the turn as ${plan.mood}: ${MOOD_NOTE[plan.mood]}` });
  // A voice reply is read aloud, so it is short and works as speech.
  if (invocation.message?.fromVoice) messages.push({ role: 'user', content: '[VOICE] This came from voice chat and your reply is read aloud, so answer the way you talk on a call: one or two short sentences (at most 30 words), shorter than you would type, with no markdown, links, lists, code or emoji. Add details only when asked for them.' });

  // A reaction is a tool call too, so the forms that react offer `react`. A
  // reaction-only turn gets just Jev's picks; a turn with words Jev's action
  // picks (Oscar's only for Oscar), more_tools for the other actions, and
  // need_more_info for the lookups.
  const reacts = plan.form === 'reaction' || plan.form === 'both';
  const wordy = plan.form !== 'reaction';
  const picked = new Set(plan.tools);
  const eligible = allTools.filter(({ function: { name } }) => name !== 'react' && (invocation.isOwner || !OWNER_ONLY_TOOLS.has(name)));
  const lookups = eligible.filter((t) => isLookup(t.function.name));
  const offered = allTools.filter(({ function: { name } }) =>
    name === 'react' ? reacts : wordy ? !isLookup(name) && eligible.some((t) => t.function.name === name) && (plan.jevDown || picked.has(name)) : picked.has(name),
  );
  // Set once need_more_info has been called: lookups may then be added by name too.
  let lookingUp = false;
  const unoffered = () => eligible.filter((t) => !offered.includes(t) && (lookingUp || !isLookup(t.function.name))).map((t) => t.function.name);
  const suggested = moodEmoji(plan.mood, random);
  const notes = [
    picked.size ? `Jev's guess at tools that may help: ${[...picked].join(', ')}. Advice, not a must: a lookup among them is only worth need_more_info if you can't answer without it.` : '',
    reacts ? `React with exactly one emoji that fits the mood, and vary it: for example one of ${suggested.join(' ')}, or any better fit (not always the same one). Only your first reaction is added.${wordy ? ' Write your reply as text in the same message as the reaction.' : ' No words.'}` : '',
    plan.needsContext
      ? `\`message\` may refer to something the recent messages do not explain. If you can't tell what, call need_more_info for fetch_history (an earlier conversation), search_notes (a note)${invocation.isOwner ? ' and query_db (anything else saved)' : ''}, then search with a \`query\` list of key words, synonyms and phrases (e.g. ["event", "party", "saturday"]) rather than guessing.`
      : '',
  ].filter(Boolean);
  // Rounds of tool calls, leaving the last model call for the answer. A later
  // round that answers in words instead of calling more is the answer.
  let answer = null;
  let listed = [];
  for (let round = 1; round < MAX_MODEL_CALLS; round++) {
    // react is offered until it has been used, so a later round can't pile on more.
    const more = wordy ? unoffered() : [];
    const closed = wordy && !lookingUp ? lookups.map((t) => t.function.name) : [];
    listed = [
      ...(invocation.reacted ? offered.filter((t) => t.function.name !== 'react') : offered),
      ...(more.length ? [moreToolsDef(more)] : []),
      ...(closed.length ? [needMoreInfoDef(closed)] : []),
    ];
    if (!listed.length) break;
    stats.toolsOffered = Math.max(stats.toolsOffered || 0, listed.length);
    const note =
      round === 1
        ? notes.length && { role: 'user', content: `[TOOLS] ${notes.join(' ')}` }
        : { role: 'user', content: `[TOOLS] Round ${round} of at most ${MAX_MODEL_CALLS - 1}. Call more tools only if the results so far are not enough to answer (e.g. read a page a search found); otherwise call nothing and write your reply now.` };
    const msg = await ask(note ? [...messages, note] : messages, listed, 'auto');
    // Only offered tools run, whatever else the model tries to call.
    const allowed = new Set(listed.map((t) => t.function.name));
    const calls = (msg.tool_calls ?? []).filter((c) => allowed.has(c.function?.name));
    // No tool calls: words here are the answer, so no extra call is spent.
    if (!calls.length) {
      if (msg.content?.trim()) answer = msg;
      break;
    }
    messages.push({ role: 'assistant', content: msg.content ?? '', tool_calls: calls });
    (invocation.toolsUsed ??= []).push(...calls.map((c) => c.function.name).filter((name) => !PLUMBING.has(name)));
    // Everything runs at once, except reactions, which keep their order: only the first one lands (reactOnce).
    let reactions = Promise.resolve();
    const run = (call) => {
      // Lookups open only through need_more_info, never by name here.
      if (call.function.name === MORE_TOOLS) return addTools(call, eligible.filter((t) => lookingUp || !isLookup(t.function.name)), offered);
      if (call.function.name !== NEED_MORE_INFO) return runTool(call, invocation, contextKey);
      lookingUp = true;
      return openLookups(call, lookups, offered, contextKey);
    };
    const toolsStart = Date.now();
    messages.push(...(await Promise.all(calls.map((call) => (call.function.name === 'react' ? (reactions = reactions.then(() => run(call))) : run(call))))));
    signal?.throwIfAborted();
    log(contextKey, `round ${round} tools ${Date.now() - toolsStart}ms`);
    // A reaction-only turn ends at its reaction, so the model can't add "Got it".
    if (plan.form === 'reaction' && invocation.reacted) break;
    // A reaction sent with the reply's words is the whole answer: no extra call.
    if (wordy && msg.content?.trim() && calls.every((c) => c.function.name === 'react')) {
      answer = msg;
      break;
    }
  }

  // A reaction-only turn says nothing. The reaction is the model's to choose; if
  // it wrote words instead, the first suggested emoji stands in, with no extra call.
  if (plan.form === 'reaction') {
    if (!invocation.reacted && (await reactOnce(invocation.message, suggested[0]))) invocation.reacted = true;
    log(contextKey, `turn done (reaction only) in ${Date.now() - turnStart}ms after ${stats.modelCalls} model call(s)`);
    return '';
  }

  // Tools stay listed (some providers reject tool results without them) but can't be called.
  const ran = messages.some((m) => m.role === 'tool');
  const msg = answer ?? (await ask(messages, ran ? listed : [], 'none'));
  const text = msg.content?.trim() || '';
  log(contextKey, `turn done in ${Date.now() - turnStart}ms after ${stats.modelCalls} model call(s), ${stats.inputTokens} in / ${stats.outputTokens} out tokens`);
  // A rule says to stay silent: nothing is sent, not even the sign-off wave.
  if (isNoReply(text)) {
    invocation.silent = true;
    return '';
  }
  // After a reaction, poll or card, a reply with no words (usually the same
  // emoji echoed) is dropped: something was already sent. A ping or reply is
  // always answered in words, so there it is kept.
  if ((invocation.posted || (invocation.reacted && !invocation.direct)) && saysNothing(text)) return '';
  // Nothing worth saying (no text, or just "🐼 …") signs off instead of sending filler.
  if (isFiller(text)) return signOff(invocation);
  return text;
  } catch (err) {
    log(contextKey, `turn ${signal?.aborted ? 'stopped' : 'failed'} after ${Date.now() - turnStart}ms: ${err.message || err}`);
    throw err;
  }
}

// need_more_info: the lookups named (and CORE_TOOLS) join the offer from the next round.
function openLookups(call, lookups, offered, contextKey) {
  let args = {};
  try {
    args = JSON.parse(call.function.arguments || '{}');
  } catch {}
  const names = new Set([...[].concat(args.tools ?? []), ...CORE_TOOLS]);
  const added = lookups.filter((t) => names.has(t.function.name) && !offered.includes(t));
  offered.push(...added);
  log(contextKey, `need_more_info: ${clip(args.missing ?? '', 200)} → ${added.map((t) => t.function.name).join(', ') || 'nothing new'}`);
  return {
    role: 'tool',
    tool_call_id: call.id,
    content: `Opened: ${added.map((t) => t.function.name).join(', ') || 'nothing new'}. Look up what is missing now${args.missing ? ` (${String(args.missing).slice(0, 300)})` : ''}, then answer.`,
  };
}

// more_tools: the named tools this sender may use join the offer from the next round.
function addTools(call, eligible, offered) {
  let names = [];
  try {
    names = [].concat(JSON.parse(call.function.arguments || '{}').names ?? []);
  } catch {}
  const added = eligible.filter((t) => names.includes(t.function.name) && !offered.includes(t));
  offered.push(...added);
  return {
    role: 'tool',
    tool_call_id: call.id,
    content: added.length ? `Added: ${added.map((t) => t.function.name).join(', ')}. Call them now if the turn needs them.` : 'Nothing added: those are already listed, are not tools, or are not available to this sender.',
  };
}

async function runTool(call, invocation, contextKey) {
  const name = call.function.name;
  const toolStart = Date.now();
  log(contextKey, `→ ${name}(${clip(call.function.arguments || '{}', 300)})`);
  let result;
  let args;
  try {
    args = JSON.parse(call.function.arguments || '{}');
  } catch {
    args = undefined;
  }
  try {
    // A stopped turn starts nothing new; unreadable arguments never run the
    // tool: the model is told to fix them.
    result = invocation.signal?.aborted
      ? 'Not run: the turn was stopped.'
      : args === undefined
        ? `Invalid arguments for ${name}: not valid JSON. Nothing ran; call it again with a JSON object of arguments.`
        : await executeTool(name, args, invocation);
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
//    A reference nothing shown explains ("the event") adds fetch_history.
// 3. should Panda react, reply in text, or both? Sampled from Jev's odds, so it
//    varies like a person would; a turn owed words (a ping, a reply to Panda, a
//    question to it, a response to something it said) is text or both, never
//    only a reaction. A turn Panda
//    joined unaddressed just to react (invocation.reactOnly) is a reaction, no tools.
// 4. what mood is it in? The most likely one, since a misread mood is a bug.
// 5. does a reply in words need careful thinking (math, logic, code, a tradeoff)?
//    Then the model reasons at low effort; otherwise it doesn't reason at all.
// Jev down, or unsure of an answer, means no picks and a text reply.
async function triage(tools, message, invocation, decideImpl, random = Math.random) {
  const { config } = invocation;
  const author = invocation.message?.author;
  const state = {
    message,
    recent_messages: invocation.recent || '(none)',
    sender: `${author?.displayName || author?.username || 'someone'}${invocation.isOwner ? ' (Oscar, the owner)' : ''}`,
    assistant_names: myNames(config, invocation.client?.user),
    owner_name: 'Oscar',
  };
  const questions = {
    bye: { type: 'noul', instructions: 'Is `message` a sign-off that ends the conversation without asking for or offering anything more?' },
    unexplained: {
      type: 'noul',
      instructions:
        'Does `message` refer to something specific that neither `message` nor `recent_messages` explain — an event, plan, person, place, thing or earlier conversation ("the event", "that game", "what she said") — so the assistant cannot know what it means without looking further back in the chat?',
    },
    respond_with: {
      type: 'choice',
      instructions:
        'How would a sharp, socially aware friend in a group chat respond to `message`, read together with `recent_messages`? Judge this message on its own: none of these is the default.',
      criteria: {
        reaction: 'Only emoji reactions, no words: `message` asks nothing and is worth reacting to (funny, wild, dumb, impressive, exciting or sad news, a cool picture, thanks, agreement, gg), so words would add nothing; or it asks for just a reaction.',
        message: 'Only a text reply: `message` wants an answer or a reply, and has no punchline or feeling an emoji would add to.',
        both: 'A text reply plus emoji reactions: `message` wants an answer and also has a punchline or feeling worth acknowledging (funny, exciting, sad, annoying), or asks for both.',
      },
    },
    needs_words: {
      type: 'noul',
      instructions:
        "Is `message` owed a reply in words: a question or request put to the assistant, or a response to something the assistant said (its lines in `recent_messages` start with (you)), so that only an emoji would leave the person ignored?",
    },
    mood: {
      type: 'choice',
      instructions: 'What mood is `message` in, read together with `recent_messages`?',
      criteria: {
        funny: 'Joking, teasing, banter, laughing, something absurd or ironic.',
        happy: 'Happy, excited, proud, grateful, good news.',
        sad: 'Sad, disappointed, lonely, tired, worried, bad news.',
        angry: 'Annoyed, frustrated, angry, ranting.',
        neutral: 'Matter-of-fact: a plain question, request or statement.',
      },
    },
    think: { type: 'noul', instructions: 'Does answering `message` correctly need careful step-by-step thinking — multi-step math or logic, a tricky puzzle, debugging or designing code, or weighing a complex tradeoff — rather than a quick reply from what the assistant already knows?' },
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
  const mood = answers?.mood?.choice in MOOD_EMOJI ? answers.mood.choice : null;
  const jevDown = !answers;
  if (invocation.reactOnly) return { signOff: answers?.bye?.noul >= PICK_THRESHOLD, tools: [], form: 'reaction', mood, needsContext: false, think: false, jevDown };

  const picked = asked.map((t) => t.function.name).filter((name) => answers?.[`use_${name}`]?.noul >= TOOL_THRESHOLD);
  // Tuned against jev-1.13: references nothing shown explains score 0.90–0.97,
  // plain chat ≤ 0.45, "fix that" right under the bug report 0.73. fetch_history's
  // search reads what was remembered, then the last 1000 messages if nothing was.
  const needsContext = answers?.unexplained?.noul >= PICK_THRESHOLD && asked.some((t) => t.function.name === 'fetch_history');
  if (needsContext && !picked.includes('fetch_history')) picked.push('fetch_history');
  const odds = answers?.respond_with?.probabilities ?? {};
  // A reaction alone would ignore the person: text or both, by Jev's odds, where
  // a reaction-worthy turn that is owed words counts toward both.
  const owed = invocation.direct || answers?.needs_words?.noul >= NEEDS_WORDS;
  let form = owed
    ? sampleChoice({ choice: 'message', probabilities: { message: odds.message, both: (odds.both ?? 0) + (odds.reaction ?? 0) } }, { random })
    : sampleChoice(answers?.respond_with, { random });
  if (!['reaction', 'message', 'both'].includes(form)) form = null;
  // Only a reply in words is worth reasoning over.
  const think = form !== 'reaction' && answers?.think?.noul >= THINK_THRESHOLD;
  return { signOff: answers?.bye?.noul >= PICK_THRESHOLD, tools: picked, form, mood, needsContext, think, jevDown };
}
