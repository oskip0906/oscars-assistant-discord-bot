export const defs = [
  {
    type: 'function',
    function: {
      name: 'get_user_id',
      description:
        "Look up a Discord user's or bot's numeric user id in this server by (partial) name. Use when you need to ping someone whose id is not already inline in the conversation. Ping format: <@id>.",
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Username, display name, or partial name to search for' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'react',
      description:
        "React to the message you're answering with an emoji (unicode like 👋, or a custom emote in <:name:id> form). Call multiple times for multiple reactions. For lightweight social messages (bye, thanks, lol, gg, simple agreement) reacting INSTEAD of replying is best: react, then return an empty final response (no text).",
      parameters: {
        type: 'object',
        properties: {
          emoji: { type: 'string', description: 'The emoji to react with' },
        },
        required: ['emoji'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_message_sender',
      description:
        'Get the user id, username, and display name of whoever sent the message you are currently answering (it is also inline in the message prefix).',
      parameters: { type: 'object', properties: {} },
    },
  },
];

export async function getUserId({ name }, invocation) {
  const guild = invocation.guild;
  if (!guild) return 'Not in a server (this is a DM) — there is no member list to search.';
  const query = String(name || '').trim();
  if (!query) return 'Provide a name to search for.';

  const matches = new Map();
  try {
    const found = await guild.members.search({ query, limit: 10 });
    for (const member of found.values()) matches.set(member.id, member);
  } catch {
    /* REST search unavailable — cache fallback below */
  }
  const lower = query.toLowerCase();
  for (const member of guild.members.cache.values()) {
    if (matches.size >= 15) break;
    if (
      member.user.username.toLowerCase().includes(lower) ||
      (member.displayName || '').toLowerCase().includes(lower)
    ) {
      matches.set(member.id, member);
    }
  }
  if (!matches.size) {
    return `No members matching "${query}" (searched the API and local cache). The name may be spelled differently.`;
  }
  return [...matches.values()]
    .map(
      (m) =>
        `${m.displayName} (@${m.user.username}) id:${m.id}${m.user.bot ? ' [BOT]' : ''} — ping with <@${m.id}>`,
    )
    .join('\n');
}

export async function react({ emoji }, invocation) {
  const trimmed = String(emoji || '').trim();
  if (!trimmed) return 'Provide an emoji to react with.';
  try {
    await invocation.message.react(trimmed);
    invocation.reacted = true;
    return `Reacted with ${trimmed}. If the reaction says it all, return an empty final response (no text).`;
  } catch (err) {
    return `Couldn't react with "${trimmed}": ${String(err.message || err).slice(0, 120)} — use a standard unicode emoji.`;
  }
}

export function getMessageSender(_args, invocation) {
  const author = invocation.message.author;
  return JSON.stringify({
    id: author.id,
    username: author.username,
    displayName: invocation.member?.displayName || author.displayName || author.username,
    bot: author.bot,
    isOwner: author.id === invocation.config.ownerId,
    pingWith: `<@${author.id}>`,
  });
}
