import { chatCompletion, providerFor } from './openrouter.js';
import { buildSystemPrompt, myNames } from './systemPrompt.js';
import { toolDefs, executeTool, OWNER_ONLY_TOOLS } from './tools/index.js';
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

// One turn, at most MAX_MODEL_CALLS model calls after one Jev call:
// 1. Jev (triage) decides in what form to answer, the mood, and which tools run:
//    a yes/no per tool. The model never adds a tool of its own.
// 2. If Jev picked any, the model fills in their arguments and they all run at
//    once. It may go another round with the same tools when the results call for
//    it (search, then read a page), and stops as soon as it calls none.
// 3. The last call writes the reply from the results, with no tools left.
// Jev down means no tools: the model answers from what it was shown.
//
// What the turn refers to comes from the recent messages the handler puts above
// it (`invocation.recent`), not from searching history.
//
// `turnText` is the batch as plain text for Jev; `userContent` may also carry
// media attachments, which only the model sees.
export async function runAgent(invocation, userContent, turnText = userContent, { chat = chatCompletion, decideImpl = decide, random = Math.random } = {}) {
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
  const plan = await triage(allTools, turnText, invocation, decideImpl, random);
  log(contextKey, `triage: signOff=${plan.signOff} tools=${plan.tools.join(',') || 'none'} form=${plan.form ?? 'text'} mood=${plan.mood ?? '?'} lookup=${plan.needsContext}`);
  // A goodbye gets a wave and nothing else, so the conversation can end.
  if (plan.signOff) {
    if (await reactOnce(invocation.message, '👋')) invocation.reacted = true;
    return '';
  }
  const locked = plan.tools.find((name) => OWNER_ONLY_TOOLS.has(name));
  if (locked && !invocation.isOwner) return `Only Oscar can use \`${locked}\`.`;

  let step = 0;
  const ask = async (msgs, tools, toolChoice) => {
    const callStart = Date.now();
    const msg = await chat({ apiKey: config.openrouterApiKey, model: config.model, provider: providerFor(config, config.model), messages: msgs, tools, toolChoice });
    log(contextKey, `model #${++step} ${Date.now() - callStart}ms → ${
      msg.tool_calls?.length ? `tools: ${msg.tool_calls.map((c) => c.function.name).join(', ')}` : `text (${(msg.content || '').length} chars)`
    }`);
    return msg;
  };

  // Jev's read of the mood shapes the reply's tone and which reactions are offered.
  if (plan.mood) messages.push({ role: 'user', content: `[TONE] Jev reads the turn as ${plan.mood}: ${MOOD_NOTE[plan.mood]}` });

  // A reaction is a tool call too, so the forms that react offer `react` with Jev's picks.
  const reacts = plan.form === 'reaction' || plan.form === 'both';
  const picked = new Set(reacts ? [...plan.tools, 'react'] : plan.tools);
  const offered = allTools.filter((t) => picked.has(t.function.name));
  const reactNote = reacts
    ? ` React with exactly one emoji that fits the mood, and vary it: for example one of ${moodEmoji(plan.mood, random).join(' ')}, or any better fit (not always the same one). Only your first reaction is added.`
    : '';
  const lookupNote = plan.needsContext
    ? ' `message` refers to something the recent messages do not explain: call fetch_history with a `query` list of its key words, synonyms and phrases (e.g. ["event", "party", "saturday"]) to find what was said about it, rather than guessing.'
    : '';
  // Rounds of tool calls, leaving the last model call for the answer. A later
  // round that answers in words instead of calling more is the answer.
  let answer = null;
  for (let round = 1; offered.length && round < MAX_MODEL_CALLS; round++) {
    // react is offered until it has been used, so a later round can't pile on more.
    const tools = invocation.reacted ? offered.filter((t) => t.function.name !== 'react') : offered;
    if (!tools.length) break;
    const pickNote = {
      role: 'user',
      content:
        round === 1
          ? `[TOOLS] Picked for this turn: ${[...picked].join(', ')}. Call the ones that help, all in this one reply, with the arguments the turn needs.${reactNote}${lookupNote}`
          : `[TOOLS] Round ${round} of at most ${MAX_MODEL_CALLS - 1}. Call more of these tools only if the results so far are not enough to answer (e.g. read a page a search found); otherwise call nothing and write your reply now.`,
    };
    const msg = await ask([...messages, pickNote], tools, round === 1 ? 'required' : 'auto');
    // Only Jev's picks run, whatever else the model tries to call.
    const allowed = new Set(tools.map((t) => t.function.name));
    const calls = (msg.tool_calls ?? []).filter((c) => allowed.has(c.function?.name));
    if (!calls.length) {
      if (round > 1 && msg.content?.trim()) answer = msg;
      break;
    }
    messages.push({ role: 'assistant', content: msg.content ?? '', tool_calls: calls });
    (invocation.toolsUsed ??= []).push(...calls.map((c) => c.function.name));
    // Everything runs at once, except reactions, which keep their order: only the first one lands (reactOnce).
    let reactions = Promise.resolve();
    const run = (call) => runTool(call, invocation, contextKey);
    messages.push(...(await Promise.all(calls.map((call) => (call.function.name === 'react' ? (reactions = reactions.then(() => run(call))) : run(call))))));
    // A reaction-only turn ends at its reaction, so the model can't add "Got it".
    if (plan.form === 'reaction' && invocation.reacted) {
      log(contextKey, `turn done (reaction only) in ${Date.now() - turnStart}ms after ${step} model call(s)`);
      return '';
    }
  }

  // Tools stay listed (some providers reject tool results without them) but can't be called.
  const ran = messages.some((m) => m.role === 'tool');
  const msg = answer ?? (await ask(messages, ran ? offered : [], 'none'));
  const text = msg.content?.trim() || '';
  log(contextKey, `turn done in ${Date.now() - turnStart}ms after ${step} model call(s)`);
  // After a reaction, poll or card, a reply with no words (usually the same
  // emoji echoed) is dropped: something was already sent. A ping or reply is
  // always answered in words, so there it is kept.
  if ((invocation.posted || (invocation.reacted && !invocation.direct)) && saysNothing(text)) return '';
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
//    A reference nothing shown explains ("the event") adds fetch_history.
// 3. should Panda react, reply in text, or both? Sampled from Jev's odds, so it
//    varies like a person would; a turn owed words (a ping, a reply to Panda, a
//    question to it, a response to something it said) is text or both, never
//    only a reaction. A turn Panda
//    joined unaddressed just to react (invocation.reactOnly) is a reaction, no tools.
// 4. what mood is it in? The most likely one, since a misread mood is a bug.
// Jev down, or unsure of an answer, means no tools and a text reply.
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
  if (invocation.reactOnly) return { signOff: answers?.bye?.noul >= PICK_THRESHOLD, tools: [], form: 'reaction', mood, needsContext: false };

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
  return { signOff: answers?.bye?.noul >= PICK_THRESHOLD, tools: picked, form, mood, needsContext };
}
