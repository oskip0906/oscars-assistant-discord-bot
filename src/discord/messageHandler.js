import { runAgent } from '../agent/agent.js';
import { formatEnvelope } from './envelope.js';
import { chunkMessage } from './chunk.js';
import { PRIVATE_MESSAGE } from '../privateMode.js';
import { selfFixState, SELF_FIX_MESSAGE } from '../selfFixState.js';
import { decide } from '../agent/jev.js';
import { saveMessages } from '../agent/historyStore.js';
import { attachmentParts, gifPreviews } from './attachments.js';
import { modelInputs } from './model.js';

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

// Waiting batches per channel. A trigger past this is dropped (spam guard).
const MAX_QUEUE = 5;

// Sign-offs. A conversation with another bot runs as long as it has something to
// say; it ends when the other bot says one of these. A wave costs one reaction
// and ends the exchange, where a reply restarts it.
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

// Words that may mean Panda without a ping: its name, "Oscar's assistant", "the
// bot". A hit only makes the message a candidate; the agent's Jev call decides
// whether to answer (see triage in agent.js). Only messages that trigger Panda
// reach Jev, so ordinary chatter never leaves the server.
export function mentionsPanda(text, config) {
  const name = String(config.botName || 'Panda').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b(${name}|assistant|bot|oscar['’]?s)\\b`, 'i').test(String(text ?? ''));
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
// guild can't race the stored memory.
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

export function createMessageHandler({ client, config, contextStore, player, privateMode, selfFix = selfFixState, runAgentImpl = runAgent, decideImpl = decide }) {
  // channelId -> { queue: Batch[], busy: boolean }
  // Batch = { claimantId, messages: Message[], closed: boolean, collected: Promise }
  const channels = new Map();

  // Channels where a bot signed off; Panda ignores bots there until a human speaks.
  // Kept outside `channels`, which is torn down as soon as its queue drains.
  const signedOff = new Set();

  // direct = pinged, replied to, or DMed; otherwise Panda was only mentioned and may stay out.
  function makeBatch(message, direct) {
    const batch = { claimantId: message.author.id, messages: [message], closed: false, direct };
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
      // A mention-only batch shows no typing until Jev decides Panda should answer.
      let typing = null;
      let accepted = false;
      const startTyping = () => {
        if (typing) return;
        anchor.channel.sendTyping().catch(() => {});
        typing = setInterval(() => anchor.channel.sendTyping().catch(() => {}), 8000);
      };
      if (batch.direct) startTyping();
      try {
        const parts = [];
        const attachments = [];
        for (const m of messages) {
          let ref = null;
          if (m.reference?.messageId) ref = await m.fetchReference().catch(() => null);
          parts.push(formatEnvelope(m, ref));
          // A reply to someone's picture ("what's this?") is about that picture.
          for (const msg of [m, ref]) attachments.push(...(msg?.attachments?.values() ?? []), ...gifPreviews(msg));
        }

        // The turn is only the batch. Earlier messages are read on demand with
        // fetch_history, so a self-contained question carries no history at all.
        const trigger = messages[0].author;
        const triggerName = messages[0].member?.displayName || trigger.displayName || trigger.username;
        const turn = parts.join('\n');
        const combined = [
          `[RESPOND TO THIS — ${triggerName} ${batch.direct ? 'pinged you' : 'mentioned you without a ping, and you chose to step in'}${messages.length > 1 ? `, then sent ${messages.length - 1} more message(s) within 3 seconds` : ''}. This is your actual task. Answer what is actually said here.]`,
          turn,
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
          // Collect any Discord embeds produced by tool calls (e.g. image_search)
          // so they can be sent alongside the text reply.
          embeds: [],
          mayDecline: !batch.direct,
          onAccept: () => {
            accepted = true;
            startTyping();
          },
        };

        // Media goes to the model for this turn only; memory keeps the text,
        // whose attachment URLs expire and would break later turns.
        const media = attachments.length ? await attachmentParts(attachments, await modelInputs(config)) : [];

        let replyText;
        try {
          replyText = await runAgentImpl(invocation, media.length ? [{ type: 'text', text: combined }, ...media] : combined, turn);
        } catch (err) {
          console.error('[panda] agent failed:', err);
          replyText = `⚠️ Something broke on my end: ${String(err.message || err).slice(0, 250)}`;
        }
        // Only mentioned, and Panda stayed out (or failed before deciding): no reply, nothing saved.
        if (!batch.direct && !accepted) return;

        // Send any embeds the tools produced (e.g. from image_search). These go
        // before the text reply so the images appear above the fold.
        if (invocation.embeds.length) {
          try {
            await anchor.channel.send({ embeds: invocation.embeds });
          } catch (err) {
            console.error('[panda] failed to send image embeds:', err);
          }
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

        const sent = [];
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
              sent.push(first ? await anchor.reply(payload) : await anchor.channel.send(payload));
            } catch {
              sent.push(await anchor.channel.send(payload).catch(() => null));
            }
            first = false;
          }
        }

        // Saved after the reply is out, so the database can never delay or break it.
        saveMessages(config, [...messages, ...sent]).catch((err) =>
          console.error('[history] save failed:', String(err.message || err).slice(0, 200)),
        );

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
      // live conversation again, so Panda will talk to bots there again.
      if (!message.author.bot) signedOff.delete(channelId);

      // A sender with a still-collecting batch in this channel gets everything
      // they say folded into it (no mention needed, timer NOT reset).
      const state = channels.get(channelId);
      if (state) {
        const open = state.queue.find((b) => !b.closed && b.claimantId === message.author.id);
        if (open) {
          open.messages.push(message);
          if (message.mentions?.users?.has(client.user.id)) open.direct = true;
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
      const direct = isDM || mentioned || repliedToBot;
      if (!direct && !mentionsPanda(message.content, config)) return;

      // Bot-to-bot: keep going as long as the other bot does, and end it on its
      // sign-off with a wave instead of a reply. Silent toward bots from then on
      // until a human speaks, so its "you too!" doesn't start it again.
      if (message.author.bot) {
        if (signedOff.has(channelId)) return;
        if (await signsOff(message.content, client.user.id, config, decideImpl)) {
          signedOff.add(channelId);
          await message.react('👋').catch(() => {});
          return;
        }
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
      if (st.queue.length >= MAX_QUEUE) {
        console.log(`[panda] queue full in ${channelId}: dropped a trigger from @${message.author.username}`);
        return;
      }
      channels.set(channelId, st);
      st.queue.push(makeBatch(message, direct));
      if (direct) message.channel.sendTyping().catch(() => {});
      pump(channelId);
    } catch (err) {
      console.error('[panda] message handling failed:', err);
    }
  };
}
