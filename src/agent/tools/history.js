import { searchHistory, formatHistory } from '../historyStore.js';
import { formatEnvelope } from '../../discord/envelope.js';

const MAX_COUNT = 100;
const MAX_SKIP = 500;

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
