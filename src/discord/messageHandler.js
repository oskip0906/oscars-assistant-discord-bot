import { runAgent, isFiller, signOff } from '../agent/agent.js';
import { formatEnvelope, transcriptOf } from './envelope.js';
import { chunkMessage } from './chunk.js';
import { decide, sampleYes } from '../agent/jev.js';
import { saveContext } from '../agent/historyStore.js';
import { attachmentParts, mediaOf } from './attachments.js';
import { modelInputs } from './model.js';
import { redactSecrets } from '../config.js';
import { readChannelRange } from '../agent/tools/history.js';
import { myNames } from '../agent/systemPrompt.js';
import { readPrompt } from '../agent/prompts.js';
import { reactOnce } from './reactions.js';
import { turnSignal } from '../agent/openrouter.js';
import { isVoiceWebhook, stopSpeaking } from '../voice/session.js';

// Fixed-window input debounce with a per-channel queue.
//
// A trigger is a ping, a reply to Panda, a DM, or any other message Jev says is
// meant for Panda (forPanda). The FIRST trigger from a sender opens a collection
// batch for them (config.batchWindowMs, BATCH_WINDOW_MS, default 1s).
// Everything that sender says in that window is concatenated into one model
// input (the timer does NOT reset). Triggers from OTHER senders during that time
// are not dropped: each opens their own batch in the channel's queue — it
// collects its sender's follow-ups for its own window and is processed when its
// turn comes. Batches are processed strictly one at a time per channel, in the
// order their triggers were sent, and never before their window has elapsed.
const WINDOW_MS = 1000;

// Messages shown above each turn as background, and the most of each one that
// is kept. The same 5 are what Jev reads to decide whether to answer at all.
const RECENT_COUNT = 5;
const RECENT_CHARS = 500;
// Panda talks unpinged only when Jev is this sure the message is addressed to
// it or responds to something it said; below that it never talks.
const TALK = 0.8;
// Said aloud in a call there is no ping or reply to Panda, so the bar is lower there.
const VOICE_TALK = 0.5;
// Speech already arrives cut at its pauses, so a call's turn waits only briefly for more of it.
const VOICE_WINDOW_MS = 150;
// identity.md is cut to this for Jev, which reads it to tell what is meant for Panda.
const IDENTITY_CHARS = 2000;
// Unaddressed messages are reacted to only when Jev leans yes, then sampled.
const REACT_FLOOR = 0.5;

// Waiting batches per channel, held in memory. A trigger past this is dropped (spam guard).
const MAX_QUEUE = 10;

// Sign-offs. A conversation with another bot runs as long as it has something to
// say; it ends when the other bot says one of these. A wave costs one reaction
// and ends the exchange, where a reply restarts it.
const FAREWELL_RE =
  /\b(bye|goodbye|good ?night|see ?ya|see you( later| around)?|cya|later(s)?|take care|farewell|catch you later|have a (great|good|nice|wonderful) (day|one|night|evening)|you too|talk (to you )?later|ttyl|peace out|signing off|gn|gtg|g2g|ttfn|nite|i'?m (all set|good)|standing by)\b/i;

// "@Panda stop", "panda, cancel", "nvm panda", or "stop" in a reply to Panda: the
// whole message is the stop word, so "stop the music" or "can you stop by" are
// ordinary requests.
const STOP_WORDS = '(?:stop(?: it| that| now)?|cancel(?: it| that)?|abort|halt|nvm|never ?mind)';

// Strip the bot's own mention so detection sees only what the sender "said".
function stripBotMention(text, clientUserId) {
  return String(text ?? '')
    .replace(new RegExp(`<@!?${clientUserId}>`, 'g'), ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// A sign-off that asks nothing. "See you later!" ends a conversation; "bye, but
// first can you check X?" does not, so a question mark disqualifies it.
export function isSignOff(text, clientUserId = '') {
  const stripped = stripBotMention(text, clientUserId);
  if (!stripped) return false;
  return FAREWELL_RE.test(stripped) && !stripped.includes('?');
}

// Jev reads intent, so "aight gn" or a goodbye in another language counts too.
// The regex above is the fallback when Jev is off or down.
export async function signsOff(text, clientUserId, config, decideImpl = decide) {
  const stripped = stripBotMention(text, clientUserId);
  if (!stripped) return false;
  const answers = await decideImpl(config, { message: stripped }, {
    bye: { type: 'noul', instructions: 'Is `message` a sign-off that ends the conversation without asking for or offering anything more?' },
  });
  return answers?.bye ? answers.bye.noul >= 0.8 : isSignOff(text, clientUserId);
}

// --- who is a message addressed to? ----------------------------------------
//
// A cheap check that runs before Jev on every unpinged server message. The words
// that mean Panda depend on who says them: from Oscar, "my bot" or "my
// assistant" is Panda; from anyone else it is their own bot. Anyone may call it
// Panda (or its Discord name), "panda bot", "Oscar's bot" or "the bot". A message
// put to Oscar himself (his @mention, a reply to him, "Oscar, can you…") is his
// to answer, so Panda stays out of it rather than answering in his place.
// Being named is not being addressed: only a name in calling position (the start
// of the message, or tagged on the end: "…, panda?") counts as calling Panda.
// Named anywhere else ("I think panda is broken", "ask panda later") it is
// 'named' and Jev decides; with Jev down, Panda stays out of it.
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const OWNER = 'oscar';
const OWNER_POSSESSIVE = `${OWNER}(?:'|’)?s`;
// Openers before a name used to call someone ("hey panda", "ok oscar, …").
const OPENER = "(?:(?:hey|hi|hello|yo|oi|ok|okay|so|um|uh|pls|please|sup|wait|ayo|ay)[\\s,!.]+)*";
// Greetings that make the next name the one being called ("hey oscar how's it going").
const GREETING = "(?:(?:hey|hi|hello|yo|oi|sup|ayo|ay|dear|thanks|thx|ty)[\\s,!.]+)+";
// Words after a name at the start that make the message about Panda, not to it ("panda is so slow").
const ABOUT =
  "is|isn't|was|wasn't|are|were|has|hasn't|had|have|keeps|kept|seems|seemed|just|always|never|still|did|didn't|does|doesn't|can't|cannot|won't|wouldn't|couldn't|got|gets|went|said|says|told|thinks|thought|knows|kinda|really|sucks|broke|crashed";

// Every phrase that names Panda when `isOwner` (or not) says it.
export function pandaAliases(config, user, isOwner = false) {
  const names = new Set([config.botName, user?.globalName, user?.username].filter(Boolean).map((n) => n.toLowerCase()));
  const phrases = [...names].map(escapeRe);
  for (const n of names) phrases.push(`${escapeRe(n)} ?bot`);
  phrases.push(`${OWNER_POSSESSIVE} (?:bot|assistant|ai)`, 'the bot', 'the assistant');
  if (isOwner) phrases.push('my (?:bot|assistant|ai)');
  return phrases;
}

// 'panda' when the message calls Panda, 'owner' when it is put to Oscar instead,
// 'named' when it names Panda without calling it, null when it doesn't name it
// (for both, Jev decides).
export function addressee(message, config, user, repliedTo = null) {
  const isOwner = Boolean(config.ownerId) && message.author?.id === config.ownerId;
  const text = stripBotMention(message.content, user?.id ?? '').toLowerCase();
  const alias = `(?:${pandaAliases(config, user, isOwner).join('|')})`;
  const aliases = new RegExp(`(?<![\\w'’])${alias}(?![\\w'’])`, 'i');
  // Called at the start: "hey panda bot …" or "Oscar's bot, …".
  const callsPanda = new RegExp(`^\\W*(?:${GREETING}@?${alias}(?![\\w'’])|${OPENER}@?${alias}\\s*[,:!])`, 'i');
  // "Panda, ask Oscar…" is for Panda however it goes on.
  if (callsPanda.test(text)) return 'panda';
  // Its name opening the message, unless the message goes on to talk about it
  // ("panda bot is down again"); or tagged on the end ("what time is it, panda?").
  const opens = new RegExp(`^\\W*${OPENER}@?${alias}(?![\\w'’])(?!\\s*(?:${ABOUT})(?![\\w'’]))`, 'i');
  const tagged = new RegExp(`(?:,\\s*|^\\W*)@?${alias}[\\s?!.]*$|(?<![\\w'’])${alias}\\s*\\?[\\s?!.]*$`, 'i');
  if (!isOwner && config.ownerId) {
    const pingsOwner =
      message.mentions?.users?.has?.(config.ownerId) || new RegExp(`<@!?${config.ownerId}>`).test(message.content ?? '');
    const repliesToOwner = repliedTo?.author?.id === config.ownerId;
    // "Oscar, …", "hey oscar can you…", "…right oscar?", "oscar do you…" — not "Oscar's bot".
    const namesOwner = new RegExp(
      `^\\W*${GREETING}${OWNER}(?![\\w'’])|^\\W*${OWNER}\\s*(?:[,:!?]|$)|(?:,\\s*${OWNER}|(?<![\\w'’])${OWNER}\\s*\\?)[\\s?!.]*$|(?<![\\w'’])${OWNER}[,:]?\\s+(?:can|could|will|would|do|did|are|were|have|is|should|pls|please)\\s+(?:you|u|ya)\\b`,
      'i',
    ).test(text);
    if (pingsOwner || repliesToOwner || namesOwner) return 'owner';
  }
  if (opens.test(text) || tagged.test(text)) return 'panda';
  return aliases.test(text) ? 'named' : null;
}

// A stop meant for Panda: pinged or replied to (`direct`), or naming it.
export function isStop(message, config, user, direct = false) {
  const isOwner = Boolean(config.ownerId) && message.author?.id === config.ownerId;
  const alias = `(?:${pandaAliases(config, user, isOwner).join('|')})`;
  const m = stripBotMention(message.content, user?.id ?? '').match(new RegExp(`^\\W*${OPENER}(@?${alias}[\\s,:!.]+)?${STOP_WORDS}([\\s,]+@?${alias})?[\\s.!]*$`, 'i'));
  return Boolean(m && (direct || m[1] || m[2]));
}

// One line of channel history as Panda reads it; its own lines are marked (you).
// The small grey `-# ` lines on Panda's own replies (the tools it used, the
// token stats) are left out: noise, and they read as "always use tools".
// A voice transcript is the speaker's words, not Panda's and not a bot's.
const historyLine = (m, self) => {
  const said = transcriptOf(m, self);
  if (said) return `🎙️ ${said.name} (said in voice): ${said.text}`.slice(0, RECENT_CHARS);
  return (m.author.id === self ? `(you) ${formatEnvelope(m).replace(/(?<=^|\n|: )-# [^\n]*(\n|$)/g, '').trimEnd()}` : formatEnvelope(m)).slice(0, RECENT_CHARS);
};

// Is a message that is not a ping, a reply to Panda or a DM still one to join,
// and how? Jev reads it with the RECENT_COUNT messages before it:
// - 'talk' only when Jev is at least 80% sure it responds to one of Panda's
//   own recent lines (only trusted when Panda really spoke there) or is
//   addressed to Panda (judged against identity.md and the recent lines).
// - 'react' when it is not for Panda but worth an emoji (funny, wild, dumb,
//   big news), sampled too, so Panda doesn't react to everything.
// - false otherwise. Bots are judged exactly like people. Jev off or down
//   means false: then only pings, replies and DMs are answered.
export async function forPanda(message, before, self, config, decideImpl = decide, random = Math.random, named = false) {
  const recent = before.slice(-RECENT_COUNT);
  const state = {
    message: formatEnvelope(message),
    recent_messages: recent.map((m) => historyLine(m, self)).join('\n') || '(none)',
    assistant_names: myNames(config, message.client?.user),
    assistant_identity: (await readPrompt(config, 'identity.md')).slice(0, IDENTITY_CHARS) || '(unknown)',
    owner_name: 'Oscar',
    sender_is_owner: message.author?.id && message.author.id === config.ownerId ? 'yes' : 'no',
    names_assistant: named ? 'yes, but not at the start or end where someone would call it' : 'no',
  };
  const answers = await decideImpl(config, state, {
    follows_up: {
      type: 'noul',
      instructions:
        "The assistant's own lines in `recent_messages` start with (you). Is `message` a direct response to one of those lines: answering a question it asked, replying to, correcting, disputing, thanking or asking about something it said? No if there is no (you) line, if `message` responds to someone else's line, or if it only shares a topic with the assistant's line without responding to it.",
    },
    addressed: {
      type: 'noul',
      instructions:
        "Is `message` addressed to the assistant: said to it, asked of it, or meant for it to act on? Judge who it is from `assistant_identity` and `assistant_names`, and the conversation from `recent_messages` (its own lines start with (you)): a message can be for it without naming it, e.g. a request for something only it does, or the next line of an exchange with it. No if it is said to someone else (a name or @mention not in `assistant_names`: another bot's name or a nickname is NOT the assistant), if it is about the assistant rather than to it, if people are talking among themselves, or if it only might be for it. Naming the assistant is not addressing it (see `names_assistant`): \"panda is so slow today\", \"ask panda later\", \"I told the bot to stop\" or \"lol panda got it wrong\" talk about it, not to it; yes only when the message itself asks or tells it something. \"my bot\" or \"my assistant\" means the assistant only when `sender_is_owner` is yes; from anyone else it is their own bot. No when it is put to `owner_name` himself (a question or request for him): the assistant never answers in his place.",
    },
    worth_reacting: {
      type: 'noul',
      instructions:
        'Even though `message` may not be meant for the assistant, would a friend reading the chat drop an emoji reaction on it? Yes only if it stands out: genuinely funny, wild or absurd, hilariously dumb, impressive, exciting or sad news, a striking picture or a hot take. No for ordinary chatter, plans and logistics, plain questions, greetings and small talk.',
    },
  });
  const p = (name) => answers?.[name]?.noul;
  const spoke = recent.some((m) => m.author?.id === self);
  const bar = message.fromVoice ? VOICE_TALK : TALK;
  if ((spoke && p('follows_up') >= bar) || p('addressed') >= bar) return 'talk';
  if (p('worth_reacting') >= REACT_FLOOR && sampleYes(p('worth_reacting'), { temperature: 1, random })) return 'react';
  return false;
}

// Suppress Discord link embeds by wrapping bare URLs in <>. Image URLs stay
// bare on purpose, so Discord shows the picture under the message: any URL
// ending in an image extension, and the ones in `keep` (image_search results,
// whose links often have none). Skips URLs already wrapped, inside markdown
// links, or in inline code.
const IMAGE_URL = /\.(png|jpe?g|gif|webp|avif)(\?\S*)?$/i;
// "-# 🔧 web_search ×2 · send_card": the tools a turn called, as Discord's small
// grey subtext above the reply. No tools, no line. A reaction shows for itself.
export function toolsLine(names = []) {
  const counts = new Map();
  for (const name of names) if (name !== 'react') counts.set(name, (counts.get(name) || 0) + 1);
  return counts.size ? `-# 🔧 ${[...counts].map(([name, n]) => (n > 1 ? `${name} ×${n}` : name)).join(' · ')}` : '';
}

// "-# 📥 1,204 in · 📤 87 out · 💸 $0.0021 · ⏱️ 4.2s total · 🧠 2.9s model":
// what the turn's model calls used and cost, and how long the turn and the
// model took, as subtext under the reply. No model call, no line.
export function statsLine(stats, totalMs) {
  if (!stats) return '';
  const secs = (ms) => `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
  return `-# 📥 ${stats.inputTokens.toLocaleString('en-US')} in · 📤 ${stats.outputTokens.toLocaleString('en-US')} out · 💸 $${stats.cost.toFixed(4)} · ⏱️ ${secs(totalMs)} total · 🧠 ${secs(stats.modelMs)} model`;
}

export function suppressLinkEmbeds(text, keep = new Set()) {
  return String(text ?? '').replace(/(?<![<(`])\bhttps?:\/\/\S+/g, (url) =>
    IMAGE_URL.test(url) || keep.has(url) ? url : `<${url}>`,
  );
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// One turn at a time per server (or DM), across its channels: turns there share
// server-wide state such as the music queue. A voice call's turns have a queue of their own.
const contextQueues = new Map();
function enqueueContext(key, task) {
  const prev = contextQueues.get(key) || Promise.resolve();
  const next = prev.then(task, task);
  contextQueues.set(
    key,
    next.finally(() => {
      if (contextQueues.get(key) === next) contextQueues.delete(key);
    }),
  );
  return next;
}

export function createMessageHandler({ client, config, player, privateMode, runAgentImpl = runAgent, decideImpl = decide }) {
  // channelId -> { queue: Batch[], busy: boolean }
  // Batch = { claimantId, messages: Message[], closed: boolean, collected: Promise }
  const channels = new Map();

  // Every batch queued or running, until its turn ends: what a stop can reach.
  const live = new Set();
  // Replies the trigger check already fetched, so a turn doesn't fetch them again.
  const refs = new WeakMap();
  const windowMs = config.batchWindowMs ?? WINDOW_MS;

  // Channels where a bot signed off; Panda ignores bots there until a human speaks.
  // Kept outside `channels`, which is torn down as soon as its queue drains.
  const signedOff = new Set();

  // direct = pinged, replied to, or DMed; otherwise Jev judged it meant for Panda.
  // reactOnly = Panda joins unaddressed only to react (forPanda said 'react').
  // `before` is the RECENT_COUNT messages before the trigger when forPanda
  // already read them, so the turn doesn't read them again.
  function makeBatch(message, direct, reactOnly = false, before = null) {
    const batch = {
      claimantId: message.author.id, channelId: message.channelId, trigger: message, before, messages: [message], closed: false, direct, reactOnly,
      sentAt: message.createdAt?.getTime() ?? Date.now(), abort: new AbortController(),
    };
    batch.collected = new Promise((resolve) => {
      setTimeout(() => {
        batch.closed = true;
        resolve();
      }, message.fromVoice ? VOICE_WINDOW_MS : windowMs);
    });
    return batch;
  }

  // A Panda-addressed stop from someone with work here: their own batches in
  // this channel (Oscar's: every batch in it), queued or running, are aborted.
  // A running turn makes no more model calls, starts no more tools and sends
  // nothing; what already happened is not undone, and a self-fix keeps its own
  // approval card (its background run is outside the turn). False when there
  // was nothing of theirs to stop, so the message is handled as usual.
  async function stopWork(message) {
    const isOwner = message.author.id === config.ownerId;
    const mine = [...live].filter((b) => b.channelId === message.channelId && (isOwner || b.claimantId === message.author.id));
    if (!mine.length) return false;
    const queue = channels.get(message.channelId)?.queue ?? [];
    for (const b of mine) {
      b.abort.abort();
      live.delete(b);
      if (queue.includes(b)) queue.splice(queue.indexOf(b), 1);
    }
    console.log(`[panda] stop from @${message.author.username} in ${message.channelId}: ${mine.length} turn(s) aborted`);
    await message
      .reply({
        content: `⏹️ Stopped${mine.length > 1 ? ` ${mine.length} requests` : ''}. Anything already done stays done (sent messages, reactions, notes, reminders), and a self-fix still goes by its own Approve / Cancel card.`,
        allowedMentions: { parse: [] },
      })
      .catch(() => {});
    return true;
  }

  async function processBatch(batch) {
    const messages = batch.messages;
    const anchor = messages[messages.length - 1]; // reply/react to the most recent
    // What is said in a call runs on its own queue, so typed messages elsewhere in the server never
    // wait behind a voice conversation (voice and music never share a server, so nothing server-wide
    // is raced). The channel queue still keeps a call's chat in order.
    const contextKey = anchor.guild ? (anchor.fromVoice ? `${anchor.guild.id}:voice` : anchor.guild.id) : `dm:${anchor.author.id}`;
    const { signal } = batch.abort;
    // A stop rejects this, so the turn lets go of the queue at once.
    const stopped = new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    stopped.catch(() => {});

    try {
    await enqueueContext(contextKey, async () => {
      if (signal.aborted) return;
      const stages = [`waited ${Date.now() - batch.sentAt}ms`];
      let stageStart = Date.now();
      const stage = (name) => {
        stages.push(`${name} ${Date.now() - stageStart}ms`);
        stageStart = Date.now();
      };
      const turnStart = Date.now();
      anchor.channel.sendTyping().catch(() => {});
      const typing = setInterval(() => anchor.channel.sendTyping().catch(() => {}), 8000);
      try {
        const parts = [];
        const attachments = [];
        for (const m of messages) {
          let ref = null;
          if (m.reference?.messageId) ref = refs.has(m) ? refs.get(m) : await m.fetchReference().catch(() => null);
          parts.push(`${formatEnvelope(m, ref)}${m.reference?.messageId && !ref ? ' (replying to a message that could not be loaded)' : ''}`);
          // A reply to someone's picture ("what's this?") is about that picture.
          attachments.push(...mediaOf(m, 'in the turn'), ...mediaOf(ref, 'in the message replied to'));
        }

        // What was said just before the batch, so "that" and "it" resolve without
        // searching history. Jev reads it too when picking tools.
        const self = client.user?.id;
        const before =
          batch.before && messages[0] === batch.trigger
            ? batch.before
            : await readChannelRange(messages[0].channel, messages[0].id, { count: RECENT_COUNT }).catch(() => []);
        stage('context');
        const recent = before.map((m) => historyLine(m, self)).join('\n');
        // "What do you think of this?" often points at a picture, GIF or file
        // posted just before, maybe on its own with no text: those are read
        // too, newest first, after the turn's own.
        for (const m of [...before].reverse()) attachments.push(...mediaOf(m, 'in the recent messages'));
        const trigger = messages[0].author;
        const triggerName = messages[0].member?.displayName || trigger.displayName || trigger.username;
        const turn = parts.join('\n');
        const combined = [
          ...(recent
            ? [
                '[RECENT MESSAGES — the 5 messages just before the turn, oldest first, each with who said it. Supporting background only: do not answer these. Use them to tell what the turn refers to and who is talking about what; if they do not make it clear, do not guess. Lines marked (you) are your own replies.]',
                recent,
                '',
              ]
            : []),
          `[RESPOND TO THIS — ${triggerName} ${batch.direct ? 'pinged you' : batch.reactOnly ? 'did not name or ping you and it is not for you; it just stands out, so you only react to it with emoji' : 'did not ping you. Read it with the recent messages and judge for yourself whether it is meant for you or you are just joining in; names in it are only yours if they are your names'}${messages.length > 1 ? `, then sent ${messages.length - 1} more message(s) within ${windowMs / 1000} seconds` : ''}. This matters most: it is your actual task. Answer what is actually said here.]`,
          turn,
        ].join('\n');

        const invocation = {
          message: anchor,
          guild: anchor.guild ?? null,
          member: anchor.member ?? null,
          client,
          player,
          config,
          contextKey,
          isOwner: anchor.author.id === config.ownerId,
          privateMode,
          reacted: false,
          // A poll or card a tool posted (create_poll, send_card) counts as a response.
          posted: false,
          // Every tool the agent calls this turn, in order; shown above the reply.
          toolsUsed: [],
          // Joined unaddressed for something worth an emoji: react, say nothing.
          reactOnly: batch.reactOnly && !batch.direct,
          // Pinged, replied to or DMed: always answered in words (text or text + reactions).
          direct: batch.direct,
          batchedCount: messages.length,
          // Fired by a stop (stopWork): the turn ends at its next step.
          signal,
          recent,
          // Collect any Discord embeds produced by tool calls so they can be
          // sent alongside the text reply.
          embeds: [],
          // Image links image_search returned: kept bare in the reply so they show as pictures.
          imageUrls: new Set(),
        };

        // Media is downloaded only here, for a turn Panda answers, and goes to
        // the model for this turn only; memory keeps the text, whose attachment
        // URLs expire and would break later turns.
        const media = attachments.length ? await attachmentParts(attachments, await modelInputs(config)) : [];
        // The links behind the [ATTACHMENTS] numbers, in the same order, so a tool can take "#1".
        invocation.attachmentUrls = [...new Set(attachments.map((a) => a.url).filter(Boolean))];
        stage(`attachments (${attachments.length})`);
        if (signal.aborted) return;

        let replyText;
        try {
          // Every model call inside the turn, tools' included, sees the stop (turnSignal).
          const content = media.length ? [{ type: 'text', text: combined }, ...media] : combined;
          replyText = await Promise.race([turnSignal.run(signal, () => runAgentImpl(invocation, content, turn)), stopped]);
        } catch (err) {
          if (signal.aborted) return;
          console.error('[panda] agent failed:', err);
          replyText = `⚠️ Something broke on my end: ${String(err.message || err).slice(0, 250)}`;
        }
        stage('agent');
        // Stopped as the turn ended: nothing is sent.
        if (signal.aborted) return;

        // Send any embeds the tools produced. These go before the text reply.
        if (invocation.embeds.length) {
          try {
            await anchor.channel.send({ embeds: invocation.embeds });
          } catch (err) {
            console.error('[panda] failed to send tool embeds:', err);
          }
        }

        // Filler ("", "🐼 …") is never sent. If nothing else answered the turn
        // (no reaction, poll or card), Panda signs off: a wave, no message,
        // unless one of Oscar's rules told it to stay silent (invocation.silent).
        if (isFiller(replyText)) {
          replyText = '';
          if (!invocation.reacted && !invocation.posted && !invocation.silent) await signOff(invocation);
        }

        const sent = [];
        if (replyText.trim()) {
          replyText = suppressLinkEmbeds(redactSecrets(replyText), invocation.imageUrls);
          // A voice message's reply starts being read aloud now, while the text is posted (not waited for).
          if (!signal.aborted) anchor.speak?.(replyText);
          const tools = toolsLine(invocation.toolsUsed);
          const stats = statsLine(invocation.stats, Date.now() - turnStart);
          const parts = chunkMessage([tools, replyText, stats].filter(Boolean).join('\n'));
          let first = true;
          for (const chunk of parts) {
            if (signal.aborted) break;
            const payload = { content: chunk, allowedMentions: { parse: ['users'], repliedUser: true } };
            // Space out follow-ups to stay clear of Discord's per-channel
            // send limit (~5 messages / 5s). discord.js also handles 429s
            // internally, but this keeps long replies from bursting.
            if (!first) await sleep(750);
            try {
              sent.push(first ? await anchor.reply(payload) : await anchor.channel.send(payload));
            } catch {
              sent.push(await anchor.channel.send(payload).catch(() => null));
            }
            first = false;
          }
        }

        // Saved after the reply is out, so the database can never delay or break it.
        // Everything Panda saw is kept, in this channel's memory: the messages
        // before the turn, the turn and the replies. DMs never are.
        saveContext(config, [...before, ...messages, ...sent]).catch((err) =>
          console.error('[history] save failed:', String(err.message || err).slice(0, 200)),
        );
        stage('send');
        console.log(`[panda] turn stages in ${anchor.channelId}: ${stages.join(', ')}`);
      } finally {
        clearInterval(typing);
      }
    });
    } finally {
      live.delete(batch);
    }
  }

  // Drain a channel's batch queue strictly in order, one at a time. Each batch
  // is awaited to the end of its collection window before it is processed.
  function pump(channelId) {
    const state = channels.get(channelId);
    if (!state || state.busy) return;
    state.busy = true;
    (async () => {
      try {
        while (state.queue.length) {
          const batch = state.queue[0];
          await batch.collected;
          // An earlier message whose Jev check came back late was queued in front: it goes first.
          if (state.queue[0] !== batch) continue;
          state.queue.shift();
          // Private mode switched on while this batch was collecting: a guest's is dropped unprocessed.
          if (privateMode?.isOn() && batch.claimantId !== config.ownerId) continue;
          try {
            await processBatch(batch);
          } catch (err) {
            console.error('[panda] batch processing failed:', err);
          }
        }
      } finally {
        state.busy = false;
        if (state.queue.length) pump(channelId); // defensive: batch landed mid-teardown
        else channels.delete(channelId);
      }
    })();
  }

  return async (message) => {
    try {
      if (message.author.id === client.user.id) return;
      // The gateway echo of a voice transcript: the voice session already handed that text over, so it must not be answered twice.
      if (message.webhookId && isVoiceWebhook(message.webhookId)) return;

      // Private mode: anything not from Oscar is dropped right here. No reply,
      // no reaction, no batch, no Jev, nothing saved.
      if (privateMode?.isOn()) {
        if (message.author.id !== config.ownerId) return;
      }

      const channelId = message.channelId;

      // Any human speaking in the channel — to the bot or not — means this is a
      // live conversation again, so Panda will talk to bots there again.
      if (!message.author.bot) signedOff.delete(channelId);

      const isDM = !message.guild;
      const mentioned = message.mentions?.users?.has(client.user.id) ?? false;
      // Discord names the replied-to author on the message itself; the reply is
      // fetched only when that doesn't settle it.
      let repliedToBot = !isDM && message.mentions?.repliedUser?.id === client.user.id;

      // A stop goes first, so it never folds into a batch as an ordinary message;
      // it also cuts off whatever Panda is saying in this server's call.
      if (isStop(message, config, client.user, isDM || mentioned || repliedToBot)) {
        const hushed = message.guildId ? stopSpeaking(message.guildId) : false;
        if ((await stopWork(message)) || hushed) return;
      }

      // A sender with a still-collecting batch in this channel gets everything
      // they say folded into it (no check needed, timer NOT reset).
      const foldIn = () => {
        const open = channels.get(channelId)?.queue.find((b) => !b.closed && b.claimantId === message.author.id);
        if (!open) return false;
        open.messages.push(message);
        // A slower Jev check can land after a later follow-up; keep them in the order they were sent.
        open.messages.sort((a, b) => a.createdAt - b.createdAt);
        // A ping or a reply to Panda folded in makes the whole batch direct.
        if (mentioned || repliedToBot) {
          open.direct = true;
          open.reactOnly = false;
        }
        return true;
      };
      if (foldIn()) return;

      // Otherwise this message must qualify as a trigger to open a new batch.
      if (message.author.bot && !config.allowBots) return;
      if (isDM && !config.dmEnabled) return;

      let ref = null;
      if (!isDM && !mentioned && !repliedToBot && message.reference?.messageId) {
        ref = await message.fetchReference().catch(() => null);
        refs.set(message, ref);
        repliedToBot = ref?.author?.id === client.user.id;
      }
      const direct = isDM || mentioned || repliedToBot;
      let joined = 'talk';
      let before = null;
      // Called by name ("panda bot, …", "Oscar's bot, …", Oscar's "my bot …") it
      // talks; only named (talked about) it is Jev's call like any other message.
      // A message put to Oscar is his, so Panda neither answers nor reacts.
      const to = direct ? null : addressee(message, config, client.user, ref);
      if (to === 'owner') return;
      if (!direct && to !== 'panda') {
        // A full queue would drop it anyway, so Jev is not asked.
        if ((channels.get(channelId)?.queue.length ?? 0) >= MAX_QUEUE) return;
        before = [...(await message.channel.messages.fetch({ limit: RECENT_COUNT, before: message.id }).catch(() => [])).values()].reverse();
        joined = await forPanda(message, before, client.user.id, config, decideImpl, Math.random, to === 'named');
        if (!joined) return;
        // A follow-up of theirs may have opened a batch while Jev was deciding.
        if (foldIn()) return;
      }

      // Bot-to-bot: keep going as long as the other bot does, and end it on its
      // sign-off with a wave instead of a reply. Unpinged bot lines are ignored
      // from then on until a human speaks, so its "you too!" doesn't start it
      // again; a ping or reply is still answered (or waved at, if it's a bye).
      if (message.author.bot) {
        if (signedOff.has(channelId) && !direct) return;
        if (await signsOff(message.content, client.user.id, config, decideImpl)) {
          signedOff.add(channelId);
          await reactOnce(message, '👋');
          return;
        }
      }

      // Open a new collection batch in this channel's queue, placed by when the
      // trigger was sent rather than when its Jev check came back. Two sent in the
      // same millisecond go in a random order.
      const st = channels.get(channelId) ?? { queue: [], busy: false };
      if (st.queue.length >= MAX_QUEUE) {
        console.log(`[panda] queue full in ${channelId}: dropped a trigger from @${message.author.username}`);
        return;
      }
      channels.set(channelId, st);
      const batch = makeBatch(message, direct, joined === 'react', before);
      live.add(batch);
      const at = st.queue.findIndex((b) => b.sentAt > batch.sentAt || (b.sentAt === batch.sentAt && Math.random() < 0.5));
      st.queue.splice(at === -1 ? st.queue.length : at, 0, batch);
      message.channel.sendTyping().catch(() => {});
      pump(channelId);
    } catch (err) {
      console.error('[panda] message handling failed:', err);
    }
  };
}
