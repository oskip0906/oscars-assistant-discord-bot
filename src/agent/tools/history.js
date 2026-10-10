import { searchHistory, formatHistory } from '../historyStore.js';

export const defs = [
  {
    type: 'function',
    function: {
      name: 'fetch_history',
      description:
        'Look up earlier conversations in this server from the stored message history — further back than the recent messages you can already see. Use when someone refers to something said before ("what did we decide", "remember when", "last time", "what did X say about Y") or when past context would clearly help. To find what a person said, put their name in `author`, not in `query`: `query` only searches message text. Returns whole conversations, oldest first.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Keywords to search for, e.g. "trip budget". Leave empty for the most recent conversations.',
          },
          author: {
            type: 'string',
            description: 'Only match messages sent by this person (their display name, or part of it), e.g. "DerpZ". Combine with query for "what did X say about Y".',
          },
          scope: {
            type: 'string',
            enum: ['channel', 'server'],
            description: 'Search only this channel (default) or every channel in this server.',
          },
        },
      },
    },
  },
];

// Never fails the turn: no match or a broken lookup both tell the model to go on without it.
export async function fetchHistory({ query = '', author = '', scope = 'channel' } = {}, invocation) {
  const message = invocation.message;
  if (!message) return 'Stored history is only available in chat — answer without it.';
  try {
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
