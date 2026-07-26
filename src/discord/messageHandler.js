import { runAgent } from '../agent/agent.js';
import { formatEnvelope } from './envelope.js';
import { chunkMessage } from './chunk.js';
import { PRIVATE_MESSAGE } from '../privateMode.js';
import { selfFixState, SELF_FIX_MESSAGE } from '../selfFixState.js';

// Fixed-window input debounce with a per-channel queue.
//
// The FIRST triggering message from a sender opens a 3s collection batch for
// them. Everything that sender says during those 3s is concatenated into one
// model input (the timer does NOT reset). Triggers from OTHER senders during
// that time are not dropped: each opens their own batch at the back of the
// channel's FIFO queue — it collects its sender's follow-ups for its own 3s
// and is processed when its turn comes. Batches are processed strictly one at
// a time per channel, in arrival order, and never before their 3s collection
// has elapsed.
const WINDOW_MS = 3000;

// The messages before the ping, always fetched and always labelled as
// background. Previously this was conditional on the trigger looking ambiguous,
// which meant a turn that *seemed* self-contained was answered with no idea what
// the channel had been talking about.
const HISTORY_LIMIT = 10;

// Two bots that are both polite never stop. Each of slopbot's messages pinged
// Panda, so Panda answered, so slopbot answered — nine rounds of "sounds good!"
// with nothing being said. A conversation with another bot gets this many turns
// to reach a point before Panda stops feeding it; any human message in the
// channel clears the count, because a human being present means it is a real
// conversation again.
const MAX_BOT_EXCHANGES = 3;

// Sign-offs. When another bot says one of these there is nothing left to answer:
// a wave costs one reaction and ends the exchange, where a reply restarts it.
const FAREWELL_RE =
  /\b(bye|goodbye|good ?night|see ?ya|see you( later| around)?|cya|later(s)?|take care|farewell|catch you later|have a (great|good|nice|wonderful) (day|one|night|evening)|you too|talk (to you )?later|ttyl|peace out|signing off|i'?m (all set|good)|standing by)\b/i;

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

// Suppress Discord link embeds by wrapping bare URLs in <>. Image URLs stay
// bare on purpose — for image_search results the embed IS the answer. Skips
// URLs already wrapped, inside markdown links, or in inline code.
const IMAGE_URL = /\.(png|jpe?g|gif|webp|avif)(\?\S*)?$/i;
export function suppressLinkEmbeds(text) {
  return String(text ?? '').replace(/(?<![<(`])\bhttps?:\/\/\S+/g, (url) =>
    IMAGE_URL.test(url) ? url : `<${url}>`,
  );
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Cross-channel serialization per context (guild / DM) so two channels of one
// guild can't race the stored transcript.
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

export function createMessageHandler({ client, config, contextStore, player, privateMode, selfFix = selfFixState, runAgentImpl = runAgent }) {
  // channelId -> { queue: Batch[], busy: boolean }
  // Batch = { claimantId, messages: Message[], closed: boolean, collected: Promise }
  const channels = new Map();

  // channelId -> consecutive turns answered for bots with no human in between.
  // Kept outside `channels`, which is torn down as soon as its queue drains.
  const botExchanges = new Map();

  function makeBatch(message) {
    const batch = { claimantId: message.author.id, messages: [message], closed: false };
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
      anchor.channel.sendTyping().catch(() => {});
      const typing = setInterval(() => anchor.channel.sendTyping().catch(() => {}), 8000);
      try {
        // The messages before the ping, always. `before` anchors on the trigger
        // itself, so this is the run-up to being addressed rather than "the last
        // ten messages", which on a busy channel is a different set entirely.
        const batchIds = new Set(messages.map((m) => m.id));
        let historyParts = [];
        try {
          const fetched = (await anchor.channel.messages?.fetch({ limit: HISTORY_LIMIT, before: messages[0].id })) ?? new Map();
          historyParts = [...fetched.values()]
            .filter((m) => !batchIds.has(m.id))
            .reverse() // Discord returns newest-first; the stack wants oldest-first
            .map((m) => formatEnvelope(m));
        } catch (err) {
          console.error('[panda] history fetch failed:', err);
        }

        const parts = [];
        for (const m of messages) {
          let ref = null;
          if (m.reference?.messageId) ref = await m.fetchReference().catch(() => null);
          parts.push(formatEnvelope(m, ref));
        }

        // Two labelled blocks, because an unlabelled wall of messages left the
        // model guessing which line it was supposed to be answering — and it
        // guessed wrong, replying to the room instead of to the person.
        const trigger = messages[0].author;
        const triggerName = messages[0].member?.displayName || trigger.displayName || trigger.username;
        const combined = [
          ...(historyParts.length
            ? [
                `[HISTORY CONTEXT — the ${historyParts.length} message(s) before you were pinged, oldest first. Background only: do NOT reply to these, they are already said and done.]`,
                ...historyParts,
                '[END HISTORY CONTEXT]',
                '',
              ]
            : []),
          `[RESPOND TO THIS — ${triggerName} pinged you${messages.length > 1 ? `, then sent ${messages.length - 1} more message(s) within 3 seconds` : ''}. This is the turn you are answering.]`,
          ...parts,
        ].join('\n');

        const invocation = {
          message: anchor,
          guild: anchor.guild ?? null,
          member: anchor.member ?? null,
          client,
          player,
          contextStore,
          config,
          contextKey,
          isOwner: anchor.author.id === config.ownerId,
          privateMode,
          contextCleared: false,
          requestRestart: false,
          reacted: false,
          batchedCount: messages.length,
        };

        let replyText;
        try {
          replyText = await runAgentImpl(invocation, combined);
        } catch (err) {
          console.error('[panda] agent failed:', err);
          replyText = `⚠️ Something broke on my end: ${String(err.message || err).slice(0, 250)}`;
        }

        // A response is MANDATORY (reaction or text — never none). If the model
        // produced neither, fall back to a reaction, then to text.
        if (!replyText.trim() && !invocation.reacted) {
          try {
            await anchor.react('👀');
            invocation.reacted = true;
          } catch {
            replyText = '🐼';
          }
        }

        if (replyText.trim()) {
          replyText = suppressLinkEmbeds(replyText);
          const parts = chunkMessage(replyText);
          let first = true;
          for (const chunk of parts) {
            const payload = { content: chunk, allowedMentions: { parse: ['users'], repliedUser: true } };
            // Space out follow-ups to stay clear of Discord's per-channel
            // send limit (~5 messages / 5s). discord.js also handles 429s
            // internally, but this keeps long replies from bursting.
            if (!first) await sleep(750);
            try {
              if (first) await anchor.reply(payload);
              else await anchor.channel.send(payload);
            } catch {
              await anchor.channel.send(payload).catch(() => {});
            }
            first = false;
          }
        }

        if (invocation.requestRestart) {
          console.log('[panda] self_fix requested restart — exiting with code 42');
          setTimeout(() => process.exit(42), 1500);
        }
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
          state.queue.shift();
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

      const channelId = message.channelId;

      // Any human speaking in the channel — to the bot or not — means this is a
      // live conversation again, so the bot-loop budget resets.
      if (!message.author.bot) botExchanges.delete(channelId);

      // A sender with a still-collecting batch in this channel gets everything
      // they say folded into it (no mention needed, timer NOT reset).
      const state = channels.get(channelId);
      if (state) {
        const open = state.queue.find((b) => !b.closed && b.claimantId === message.author.id);
        if (open) {
          open.messages.push(message);
          return;
        }
      }

      // Otherwise this message must qualify as a trigger to open a new batch.
      if (message.author.bot && !config.allowBots) return;
      const isDM = !message.guild;
      if (isDM && !config.dmEnabled) return;

      const mentioned = message.mentions?.users?.has(client.user.id) ?? false;
      let repliedToBot = false;
      if (!isDM && message.reference?.messageId) {
        const ref = await message.fetchReference().catch(() => null);
        repliedToBot = ref?.author?.id === client.user.id;
      }
      if (!isDM && !mentioned && !repliedToBot) return;

      // Bot-to-bot: end it deliberately rather than trading pleasantries until
      // one of us is rate-limited. A sign-off gets a wave and nothing else, and
      // an exchange that keeps going without ever reaching a point is dropped
      // once the budget runs out. Both paths stay silent from then on until a
      // human speaks, which clears the count above.
      if (message.author.bot) {
        const spent = botExchanges.get(channelId) || 0;
        if (isSignOff(message.content, client.user.id)) {
          botExchanges.set(channelId, MAX_BOT_EXCHANGES);
          if (spent < MAX_BOT_EXCHANGES) await message.react('👋').catch(() => {});
          return;
        }
        if (spent >= MAX_BOT_EXCHANGES) {
          if (spent === MAX_BOT_EXCHANGES) {
            console.log(`[panda] bot loop in ${channelId}: ${MAX_BOT_EXCHANGES} exchanges with @${message.author.username} and no human — holding off until someone else speaks`);
            botExchanges.set(channelId, spent + 1);
          }
          return;
        }
        botExchanges.set(channelId, spent + 1);
      }

      // Self-fix in progress: the bot is rewriting its own source and must not
      // route anything to the model. Triggers get the hardcoded busy string and
      // nothing else — once per sender, so a multi-minute fix can't flood the
      // channel. Sits after trigger qualification on purpose: people who aren't
      // talking to the bot get silence, not busy spam.
      //
      // A pending approval deliberately does NOT count as busy. It waits for a
      // button with no deadline, and nothing is being rewritten yet — treating
      // it as busy would leave the bot answering everyone with "I'm rebuilding
      // my source" until Oscar got round to clicking.
      if (selfFix?.isActive()) {
        if (selfFix.shouldNotify(message.author.id)) {
          await message
            .reply({ content: SELF_FIX_MESSAGE, allowedMentions: { parse: [] } })
            .catch(() => {});
        }
        return;
      }

      // Private mode: a non-owner trigger gets the hardcoded refusal immediately
      // (no batch, no model). Bots are ignored silently to avoid loops.
      if (privateMode?.isOn() && message.author.id !== config.ownerId) {
        if (!message.author.bot) {
          await message.reply({ content: PRIVATE_MESSAGE, allowedMentions: { parse: [] } }).catch(() => {});
        }
        return;
      }

      // Open a new 3s collection batch at the back of this channel's queue.
      const st = channels.get(channelId) ?? { queue: [], busy: false };
      channels.set(channelId, st);
      st.queue.push(makeBatch(message));
      message.channel.sendTyping().catch(() => {});
      pump(channelId);
    } catch (err) {
      console.error('[panda] message handling failed:', err);
    }
  };
}
