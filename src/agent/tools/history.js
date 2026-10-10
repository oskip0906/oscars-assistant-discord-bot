import { PermissionFlagsBits } from 'discord.js';
import { searchHistory, formatHistory, saveMessages } from '../historyStore.js';
import { formatEnvelope } from '../../discord/envelope.js';

const MAX_COUNT = 100;
const MAX_SKIP = 500;
const AROUND = 50;
const MESSAGE_LINK = /discord(?:app)?\.com\/channels\/(\d+|@me)\/(\d+)\/(\d+)/;

export const defs = [
  {
    type: 'function',
    function: {
      name: 'fetch_history',
      description:
        'Get more context than the few messages you were shown. Two modes. (1) No `query` and no `author`, scope "channel": read a range of this channel straight from Discord, newest-first counting back from the message you are answering — `count` messages after skipping the `skip` most recent. Use it whenever the shown messages are not enough to follow the conversation ("as I said", "that one", a thread that started earlier, your own earlier replies). E.g. {count: 30} for the run-up, then {skip: 30, count: 50} to go further back. (2) `query` and/or `author`, or scope "server": search older stored conversations ("what did we decide", "remember when", "what did X say about Y"). To find what a person said, put their name in `author`, not in `query`: `query` only searches message text. Results are oldest first.',
      parameters: {
        type: 'object',
        properties: {
          count: {
            type: 'integer',
            description: `Range mode: how many messages to return (default 30, max ${MAX_COUNT}).`,
          },
          skip: {
            type: 'integer',
            description: `Range mode: how many of the most recent messages to skip first (default 0, max ${MAX_SKIP}). Use it to page further back.`,
          },
          query: {
            type: 'string',
            description: 'Search mode: keywords to search for, e.g. "trip budget".',
          },
          author: {
            type: 'string',
            description: 'Search mode: only match messages sent by this person (their display name, or part of it), e.g. "DerpZ". Combine with query for "what did X say about Y".',
          },
          scope: {
            type: 'string',
            enum: ['channel', 'server'],
            description: 'Search only this channel (default) or every channel in this server. "server" always searches the database.',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'index_chat',
      description:
        `Read the messages around one specific past Discord message (up to ${AROUND}) and save them to your history database. Use it when someone replies to, links, or points at an old message you have not seen and you need what was said around it. Pass its message link (https://discord.com/channels/…/…/…) or its id; an id alone means this channel. Messages already saved are never overwritten; only new ones are added.`,
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'The message link, or the message id if it is in this channel.' },
        },
        required: ['message'],
      },
    },
  },
];

const clamp = (v, def, max) => Math.min(max, Math.max(0, Number.isFinite(Number(v)) ? Math.floor(Number(v)) : def));

// Pages back from `message` (Discord returns newest first, 100 at most per call).
export async function readChannelRange(message, { skip = 0, count = 30 } = {}) {
  const out = [];
  let before = message.id;
  let toSkip = skip;
  while (out.length < count) {
    const page = await message.channel.messages.fetch({ limit: 100, before });
    if (!page.size) break;
    for (const m of page.values()) {
      if (toSkip > 0) toSkip--;
      else if (out.length < count) out.push(m);
    }
    before = page.last().id;
  }
  return out.reverse();
}

// Never fails the turn: no match or a broken lookup both tell the model to go on without it.
export async function fetchHistory({ query = '', author = '', scope = 'channel', skip, count } = {}, invocation) {
  const message = invocation.message;
  if (!message) return 'Stored history is only available in chat — answer without it.';
  try {
    if (!query && !author && scope !== 'server') {
      const range = { skip: clamp(skip, 0, MAX_SKIP), count: clamp(count, 30, MAX_COUNT) || 1 };
      const msgs = await readChannelRange(message, range);
      if (!msgs.length) return 'No earlier messages in this channel.';
      const self = invocation.client?.user?.id;
      return [
        `[CHANNEL HISTORY — ${msgs.length} message(s), skipping the ${range.skip} most recent, oldest first. Background only: these are not new messages. Lines marked (you) are your own replies.]`,
        ...msgs.map((m) => `${m.author.id === self ? '(you) ' : ''}${formatEnvelope(m)}`),
      ].join('\n');
    }
    const rows = await searchHistory(invocation.config, {
      guildId: message.guildId ?? null,
      // A DM has no server to widen to; widening there would read every DM.
      channelId: scope === 'server' && message.guildId ? null : message.channelId,
      query,
      author,
    });
    return rows.length ? formatHistory(rows) : 'No earlier conversations matched — answer without them.';
  } catch (err) {
    console.error('[history] fetch failed:', String(err.message || err).slice(0, 200));
    return 'Stored history is unavailable right now — answer without it.';
  }
}

// The channel the message lives in, or a reason to refuse. Panda can read
// channels the asker can't, so another channel must be in this server and
// readable by the asker; a DM can only reach itself.
async function channelFor(link, invocation) {
  const here = invocation.message;
  if (!link || link[2] === here.channelId) return { channel: here.channel };
  if (!here.guildId || link[1] !== here.guildId) return { refusal: 'That message is in another server or DM, so I can only look at it from there.' };
  const channel = await invocation.client?.channels.fetch(link[2]).catch(() => null);
  if (!channel?.messages || channel.guildId !== here.guildId) return { refusal: "I can't find that channel in this server." };
  return { channel };
}

// Never throws: a refusal or failure is text the model can pass on.
export async function indexChat({ message: ref = '' } = {}, invocation) {
  const here = invocation.message;
  if (!here?.channel) return 'index_chat only works in chat.';
  const link = String(ref).match(MESSAGE_LINK);
  const id = link ? link[3] : String(ref).trim();
  if (!/^\d{17,20}$/.test(id)) return 'Give me a Discord message link or a message id.';
  try {
    const { channel, refusal } = await channelFor(link, invocation);
    if (refusal) return refusal;
    if (here.guildId) {
      const perms = channel.permissionsFor?.(here.member ?? here.author.id);
      if (!perms?.has(PermissionFlagsBits.ViewChannel | PermissionFlagsBits.ReadMessageHistory)) {
        return "You can't read that channel's history, so I won't show it to you.";
      }
    }
    const page = await channel.messages.fetch({ around: id, limit: AROUND });
    const msgs = [...page.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
    if (!msgs.length) return 'No messages there.';
    let saved;
    try {
      saved = `${await saveMessages(invocation.config, msgs.filter((m) => m.content), { keepExisting: true })} newly saved to history`;
    } catch (err) {
      console.error('[history] index_chat save failed:', String(err.message || err).slice(0, 200));
      saved = 'not saved: the history database is unavailable';
    }
    const self = invocation.client?.user?.id;
    return [
      `[MESSAGES AROUND ${id} in #${channel.name ?? channel.id} — ${msgs.length}, oldest first${page.has(id) ? '; → marks that message' : '; that message itself is gone'}; ${saved}. Background only: these are not new messages.]`,
      ...msgs.map((m) => `${m.id === id ? '→ ' : ''}[${m.createdAt.toISOString().slice(0, 16).replace('T', ' ')} UTC] ${m.author.id === self ? '(you) ' : ''}${formatEnvelope(m)}`),
    ].join('\n');
  } catch (err) {
    console.error('[history] index_chat failed:', String(err.message || err).slice(0, 200));
    return `I couldn't read that part of the channel: ${String(err.message || err).slice(0, 150)}`;
  }
}
