export const defs = [
  {
    type: 'function',
    function: {
      name: 'get_user_id',
      description:
        "Look up any guild member's numeric id in this server by (partial) name — PEOPLE AND BOTS ALIKE. Bots are ordinary members and are pinged the same way, so use this whenever you are asked to ping or mention a bot rather than saying you cannot. Accepts a bare name, an @name, a <@id> mention, or a raw id. Ping format: <@id>.",
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
  // The model routinely passes back what it saw on screen: "@SomeBot", a raw
  // <@123> mention, or the id itself. Searching for those literally finds
  // nothing, and a fruitless lookup is what it then reports as "I can't".
  const raw = String(name || '').trim();
  // Inside <@…> the wrapper already proves it is an id, so any digits count. A
  // bare number has to look like a snowflake before it is treated as one.
  const mention = raw.match(/^<@!?(\d+)>$/) || raw.match(/^(\d{15,})$/);
  if (mention) {
    const id = mention[1];
    const member = await guild.members.fetch(id).catch(() => null);
    const who = member ? `${member.displayName} (@${member.user.username})${member.user.bot ? ' [BOT]' : ''}` : 'that account';
    return `${who} id:${id} — ping with <@${id}>. Bots are pinged exactly like people.`;
  }
  const query = raw.replace(/^@+/, '');
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
    return `No member matching "${query}" is in this server (searched the API and local cache, people and bots alike). The name may be spelled differently — ask which one they mean. This is a spelling miss, not a restriction on pinging.`;
  }
  return [
    ...[...matches.values()].map(
      (m) =>
        `${m.displayName} (@${m.user.username}) id:${m.id}${m.user.bot ? ' [BOT]' : ''} — ping with <@${m.id}>`,
    ),
    'Every id above is pingable with <@id>, bots included.',
  ].join('\n');
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
