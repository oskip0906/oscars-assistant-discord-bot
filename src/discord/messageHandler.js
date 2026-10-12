import { runAgent, isFiller, signOff } from '../agent/agent.js';
import { formatEnvelope } from './envelope.js';
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

// Fixed-window input debounce with a per-channel queue.
//
// A trigger is a ping, a reply to Panda, a DM, or any other message Jev says is
// meant for Panda (forPanda). The FIRST trigger from a sender opens a 3s
// collection batch for them. Everything that sender says during those 3s is
// concatenated into one model input (the timer does NOT reset). Triggers from
// OTHER senders during that time are not dropped: each opens their own batch in
// the channel's queue — it collects its sender's follow-ups for its own 3s and
// is processed when its turn comes. Batches are processed strictly one at a time
// per channel, in the order their triggers were sent, and never before their 3s
// collection has elapsed.
const WINDOW_MS = 3000;

// Messages shown above each turn as background, and the most of each one that
// is kept. The same 5 are what Jev reads to decide whether to answer at all.
const RECENT_COUNT = 5;
const RECENT_CHARS = 500;
// Panda talks unpinged only when Jev is this sure the message is addressed to
// it or responds to something it said; below that it never talks.
const TALK = 0.7;
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
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const OWNER = 'oscar';
const OWNER_POSSESSIVE = `${OWNER}(?:'|’)?s`;
// Openers before a name used to call someone ("hey panda", "ok oscar, …").
const OPENER = "(?:(?:hey|hi|hello|yo|oi|ok|okay|so|um|uh|pls|please|sup|wait|ayo|ay)[\\s,!.]+)*";
// Greetings that make the next name the one being called ("hey oscar how's it going").
const GREETING = "(?:(?:hey|hi|hello|yo|oi|sup|ayo|ay|dear|thanks|thx|ty)[\\s,!.]+)+";

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
// null when this check can't tell (then Jev decides, as before).
export function addressee(message, config, user, repliedTo = null) {
  const isOwner = Boolean(config.ownerId) && message.author?.id === config.ownerId;
  const text = stripBotMention(message.content, user?.id ?? '').toLowerCase();
  const alias = `(?:${pandaAliases(config, user, isOwner).join('|')})`;
  const aliases = new RegExp(`(?<![\\w'’])${alias}(?![\\w'’])`, 'i');
  // Called at the start: "hey panda bot …" or "Oscar's bot, …".
  const callsPanda = new RegExp(`^\\W*(?:${GREETING}@?${alias}(?![\\w'’])|${OPENER}@?${alias}\\s*[,:!])`, 'i');
  // "Panda, ask Oscar…" is for Panda however it goes on.
  if (callsPanda.test(text)) return 'panda';
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
  return aliases.test(text) ? 'panda' : null;
}

// One line of channel history as Panda reads it; its own lines are marked (you).
const historyLine = (m, self) => `${m.author.id === self ? '(you) ' : ''}${formatEnvelope(m)}`.slice(0, RECENT_CHARS);

// Is a message that is not a ping, a reply to Panda or a DM still one to join,
// and how? Jev reads it with the RECENT_COUNT messages before it:
// - 'talk' only when Jev is at least 70% sure it responds to one of Panda's
//   own recent lines (only trusted when Panda really spoke there) or is
//   addressed to Panda (judged against identity.md and the recent lines).
// - 'react' when it is not for Panda but worth an emoji (funny, wild, dumb,
//   big news), sampled too, so Panda doesn't react to everything.
// - false otherwise. Bots are judged exactly like people. Jev off or down
//   means false: then only pings, replies and DMs are answered.
export async function forPanda(message, before, self, config, decideImpl = decide, random = Math.random) {
  const recent = before.slice(-RECENT_COUNT);
  const state = {
    message: formatEnvelope(message),
    recent_messages: recent.map((m) => historyLine(m, self)).join('\n') || '(none)',
    assistant_names: myNames(config, message.client?.user),
    assistant_identity: (await readPrompt(config, 'identity.md')).slice(0, IDENTITY_CHARS) || '(unknown)',
    owner_name: 'Oscar',
    sender_is_owner: message.author?.id && message.author.id === config.ownerId ? 'yes' : 'no',
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
        "Is `message` addressed to the assistant: said to it, asked of it, or meant for it to act on? Judge who it is from `assistant_identity` and `assistant_names`, and the conversation from `recent_messages` (its own lines start with (you)): a message can be for it without naming it, e.g. a request for something only it does, or the next line of an exchange with it. No if it is said to someone else (a name or @mention not in `assistant_names`: another bot or nickname such as \"slopbot\" is NOT the assistant), if it is about the assistant rather than to it, if people are talking among themselves, or if it only might be for it. \"my bot\" or \"my assistant\" means the assistant only when `sender_is_owner` is yes; from anyone else it is their own bot. No when it is put to `owner_name` himself (a question or request for him): the assistant never answers in his place.",
    },
    worth_reacting: {
      type: 'noul',
      instructions:
        'Even though `message` may not be meant for the assistant, would a friend reading the chat drop an emoji reaction on it? Yes only if it stands out: genuinely funny, wild or absurd, hilariously dumb, impressive, exciting or sad news, a striking picture or a hot take. No for ordinary chatter, plans and logistics, plain questions, greetings and small talk.',
    },
  });
  const p = (name) => answers?.[name]?.noul;
  const spoke = recent.some((m) => m.author?.id === self);
  if ((spoke && p('follows_up') >= TALK) || p('addressed') >= TALK) return 'talk';
  if (p('worth_reacting') >= REACT_FLOOR && sampleYes(p('worth_reacting'), { temperature: 1, random })) return 'react';
  return false;
}

// Suppress Discord link embeds by wrapping bare URLs in <>. Image URLs stay
// bare on purpose — for image_search results the embed IS the answer. Skips
// URLs already wrapped, inside markdown links, or in inline code.
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

export function suppressLinkEmbeds(text) {
  return String(text ?? '').replace(/(?<![<(`])\bhttps?:\/\/\S+/g, (url) =>
    IMAGE_URL.test(url) ? url : `<${url}>`,
  );
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// One turn at a time per server (or DM), across its channels: turns there share
// server-wide state such as the music queue.
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

  // Channels where a bot signed off; Panda ignores bots there until a human speaks.
  // Kept outside `channels`, which is torn down as soon as its queue drains.
  const signedOff = new Set();

  // direct = pinged, replied to, or DMed; otherwise Jev judged it meant for Panda.
  // reactOnly = Panda joins unaddressed only to react (forPanda said 'react').
  function makeBatch(message, direct, reactOnly = false) {
    const batch = { claimantId: message.author.id, messages: [message], closed: false, direct, reactOnly, sentAt: message.createdAt?.getTime() ?? Date.now() };
    batch.collected = new Promise((resolve) => {
      setTimeout(() => {
        batch.closed = true;
        resolve();
      }, WINDOW_MS);
    });
    return batch;
  }

  async function processBatch(batch) {
    const messages = batch.messages;
    const anchor = messages[messages.length - 1]; // reply/react to the most recent
    const contextKey = anchor.guild ? anchor.guild.id : `dm:${anchor.author.id}`;

    await enqueueContext(contextKey, async () => {
      const turnStart = Date.now();
      anchor.channel.sendTyping().catch(() => {});
      const typing = setInterval(() => anchor.channel.sendTyping().catch(() => {}), 8000);
      try {
        const parts = [];
        const attachments = [];
        for (const m of messages) {
          let ref = null;
          if (m.reference?.messageId) ref = await m.fetchReference().catch(() => null);
          parts.push(formatEnvelope(m, ref));
          // A reply to someone's picture ("what's this?") is about that picture.
          attachments.push(...mediaOf(m, 'in the turn'), ...mediaOf(ref, 'in the message replied to'));
        }

        // What was said just before the batch, so "that" and "it" resolve without
        // searching history. Jev reads it too when picking tools.
        const self = client.user?.id;
        const before = await readChannelRange(messages[0].channel, messages[0].id, { count: RECENT_COUNT }).catch(() => []);
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
          `[RESPOND TO THIS — ${triggerName} ${batch.direct ? 'pinged you' : batch.reactOnly ? 'did not name or ping you and it is not for you; it just stands out, so you only react to it with emoji' : 'did not ping you. Read it with the recent messages and judge for yourself whether it is meant for you or you are just joining in; names in it are only yours if they are your names'}${messages.length > 1 ? `, then sent ${messages.length - 1} more message(s) within 3 seconds` : ''}. This matters most: it is your actual task. Answer what is actually said here.]`,
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
          recent,
          // Collect any Discord embeds produced by tool calls (e.g. image_search)
          // so they can be sent alongside the text reply.
          embeds: [],
        };

        // Media is downloaded only here, for a turn Panda answers, and goes to
        // the model for this turn only; memory keeps the text, whose attachment
        // URLs expire and would break later turns.
        const media = attachments.length ? await attachmentParts(attachments, await modelInputs(config)) : [];

        let replyText;
        try {
          replyText = await runAgentImpl(invocation, media.length ? [{ type: 'text', text: combined }, ...media] : combined, turn);
        } catch (err) {
          console.error('[panda] agent failed:', err);
          replyText = `⚠️ Something broke on my end: ${String(err.message || err).slice(0, 250)}`;
        }

        // Send any embeds the tools produced (e.g. from image_search). These go
        // before the text reply so the images appear above the fold.
        if (invocation.embeds.length) {
          try {
            await anchor.channel.send({ embeds: invocation.embeds });
          } catch (err) {
            console.error('[panda] failed to send image embeds:', err);
          }
        }

        // Filler ("", "🐼 …") is never sent. If nothing else answered the turn
        // (no reaction, poll or card), Panda signs off: a wave, no message.
        if (isFiller(replyText)) {
          replyText = '';
          if (!invocation.reacted && !invocation.posted) await signOff(invocation);
        }

        const sent = [];
        if (replyText.trim()) {
          replyText = suppressLinkEmbeds(redactSecrets(replyText));
          const tools = toolsLine(invocation.toolsUsed);
          const stats = statsLine(invocation.stats, Date.now() - turnStart);
          const parts = chunkMessage([tools, replyText, stats].filter(Boolean).join('\n'));
          let first = true;
          for (const chunk of parts) {
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
      } finally {
        clearInterval(typing);
      }
    });
  }

  // Drain a channel's batch queue strictly in order, one at a time. Each batch
  // is awaited to the end of its 3s collection before it is processed.
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

      // Private mode: anything not from Oscar is dropped right here. No reply,
      // no reaction, no batch, no Jev, nothing saved.
      if (privateMode?.isOn()) {
        if (message.author.id !== config.ownerId) return;
      }

      const channelId = message.channelId;

      // Any human speaking in the channel — to the bot or not — means this is a
      // live conversation again, so Panda will talk to bots there again.
      if (!message.author.bot) signedOff.delete(channelId);

      // A sender with a still-collecting batch in this channel gets everything
      // they say folded into it (no check needed, timer NOT reset).
      const foldIn = () => {
        const open = channels.get(channelId)?.queue.find((b) => !b.closed && b.claimantId === message.author.id);
        if (!open) return false;
        open.messages.push(message);
        // A slower Jev check can land after a later follow-up; keep them in the order they were sent.
        open.messages.sort((a, b) => a.createdAt - b.createdAt);
        // A ping or a reply to Panda folded in makes the whole batch direct.
        if (message.mentions?.users?.has(client.user.id) || message.mentions?.repliedUser?.id === client.user.id) {
          open.direct = true;
          open.reactOnly = false;
        }
        return true;
      };
      if (foldIn()) return;

      // Otherwise this message must qualify as a trigger to open a new batch.
      if (message.author.bot && !config.allowBots) return;
      const isDM = !message.guild;
      if (isDM && !config.dmEnabled) return;

      const mentioned = message.mentions?.users?.has(client.user.id) ?? false;
      let repliedToBot = false;
      let ref = null;
      if (!isDM && message.reference?.messageId) {
        ref = await message.fetchReference().catch(() => null);
        repliedToBot = ref?.author?.id === client.user.id;
      }
      const direct = isDM || mentioned || repliedToBot;
      let joined = 'talk';
      // Called by name ("panda bot", "Oscar's bot", Oscar's "my bot") it talks;
      // a message put to Oscar is his, so Panda neither answers nor reacts.
      const to = direct ? null : addressee(message, config, client.user, ref);
      if (to === 'owner') return;
      if (!direct && to !== 'panda') {
        // A full queue would drop it anyway, so Jev is not asked.
        if ((channels.get(channelId)?.queue.length ?? 0) >= MAX_QUEUE) return;
        const before = await message.channel.messages.fetch({ limit: RECENT_COUNT, before: message.id }).catch(() => []);
        joined = await forPanda(message, [...before.values()].reverse(), client.user.id, config, decideImpl);
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

      // Open a new 3s collection batch in this channel's queue, placed by when the
      // trigger was sent rather than when its Jev check came back. Two sent in the
      // same millisecond go in a random order.
      const st = channels.get(channelId) ?? { queue: [], busy: false };
      if (st.queue.length >= MAX_QUEUE) {
        console.log(`[panda] queue full in ${channelId}: dropped a trigger from @${message.author.username}`);
        return;
      }
      channels.set(channelId, st);
      const batch = makeBatch(message, direct, joined === 'react');
      const at = st.queue.findIndex((b) => b.sentAt > batch.sentAt || (b.sentAt === batch.sentAt && Math.random() < 0.5));
      st.queue.splice(at === -1 ? st.queue.length : at, 0, batch);
      message.channel.sendTyping().catch(() => {});
      pump(channelId);
    } catch (err) {
      console.error('[panda] message handling failed:', err);
    }
  };
}
