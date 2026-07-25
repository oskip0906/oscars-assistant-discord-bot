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

// When a trigger message points back at earlier conversation, or is too
// short/ambiguous to stand on its own, we widen the model input to include
// recent channel history so the agent has something concrete to reason about.
// (Normal, self-contained messages skip this and keep the default behavior.)
const HISTORY_LIMIT = 10;

// Phrases that signal the sender is referring to earlier conversation.
const CONTEXT_REFERENCE_RE =
  /\b(what about that|you said|you mentioned|you told me|as (?:i|we) (?:said|mentioned|discussed)|earlier|last time|previously|previous (?:topic|message|conversation|chat)|our (?:last|previous) (?:topic|conversation|chat|discussion)|regarding (?:our|the last|that)|remember (?:when|that|how|our)|like i said|as before|back then|that thing (?:we|you)|going back to)\b/i;

// Short/low-signal messages that only make sense with surrounding context.
const AMBIGUOUS_PHRASES = new Set([
  'hello', 'hi', 'hey', 'hiya', 'heya', 'yo', 'sup', 'hola',
  'yes', 'yeah', 'yep', 'yup', 'ya', 'no', 'nope', 'nah',
  'ok', 'okay', 'k', 'kk', 'sure', 'fine', 'right',
  'what', 'why', 'how', 'who', 'when', 'where', 'huh', 'wat', 'wut', 'eh',
  'continue', 'go on', 'more', 'and', 'so', 'then', 'well', 'again',
  'thanks', 'thank you', 'ty', 'thx',
  'lol', 'lmao', 'nice', 'cool', 'wow', 'oh', 'ah', 'hmm', 'hm', 'yo?',
  'help', '?', '??', '???',
]);
// A single-word message no longer than this is treated as ambiguous.
const AMBIGUOUS_MAX_WORD_LEN = 12;

// Strip the bot's own mention so detection sees only what the sender "said".
function stripBotMention(text, clientUserId) {
  return String(text ?? '')
    .replace(new RegExp(`<@!?${clientUserId}>`, 'g'), ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizePhrase(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^\w\s?]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function referencesPastConversation(text) {
  return CONTEXT_REFERENCE_RE.test(text);
}

function isAmbiguous(text) {
  const norm = normalizePhrase(text);
  if (!norm) return true; // bare mention / nothing but the ping
  if (AMBIGUOUS_PHRASES.has(norm)) return true;
  const words = norm.split(/\s+/);
  if (words.length === 1 && norm.length <= AMBIGUOUS_MAX_WORD_LEN) return true;
  return false;
}

// Decide whether this turn should ingest recent channel history alongside the
// current (and any coalesced) messages.
function needsHistory(rawText, clientUserId) {
  const stripped = stripBotMention(rawText, clientUserId);
  return referencesPastConversation(stripped) || isAmbiguous(stripped);
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

export function createMessageHandler({ client, config, contextStore, player, privateMode, toggledResponses, selfFix = selfFixState, runAgentImpl = runAgent }) {
  // channelId -> { queue: Batch[], busy: boolean }
  // Batch = { claimantId, messages: Message[], closed: boolean, collected: Promise }
  const channels = new Map();

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
        // If the turn refers back to earlier conversation or is too ambiguous
        // to stand alone, prepend recent channel history (oldest first) to the
        // stack so the agent has context. Self-contained messages skip this.
        let historyParts = [];
        const rawText = messages.map((m) => m.content || '').join(' ');
        if (needsHistory(rawText, client.user.id)) {
          const batchIds = new Set(messages.map((m) => m.id));
          try {
            const fetched = await anchor.channel.messages.fetch({ limit: HISTORY_LIMIT });
            historyParts = [...fetched.values()]
              .filter((m) => !batchIds.has(m.id)) // drop the current/coalesced messages
              .reverse() // Discord returns newest-first; the stack wants oldest-first
              .map((m) => formatEnvelope(m));
          } catch (err) {
            console.error('[panda] history fetch failed:', err);
          }
          if (historyParts.length) {
            historyParts.unshift('[recent channel history for context, oldest first]');
          }
        }

        // Concatenate history + every buffered message into one model input.
        const parts = [];
        for (const m of messages) {
          let ref = null;
          if (m.reference?.messageId) ref = await m.fetchReference().catch(() => null);
          parts.push(formatEnvelope(m, ref));
        }
        const combined = [...historyParts, ...parts].join('\n');

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

      // Toggled-off users: their messages are never routed to the model, so the
      // bot simply doesn't respond to them (no batch, no reply — silence).
      if (toggledResponses?.has(message.author.id)) return;

      const channelId = message.channelId;

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

      // Self-fix in progress: the bot is rewriting its own source and must not
      // route anything to the model. Triggers get the hardcoded busy string and
      // nothing else — once per sender, so a multi-minute fix can't flood the
      // channel. Sits after trigger qualification on purpose: people who aren't
      // talking to the bot get silence, not busy spam.
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
