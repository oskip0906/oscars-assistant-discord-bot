// Model-facing inbound envelope. Conventions proven on the openclaw box:
// - sender's numeric id is inline (pingable with <@id>, zero lookups)
// - inbound <@NNN> mentions keep their id as "@Name (id:NNN)"
export function formatEnvelope(message, refMsg = null) {
  const author = message.author;
  const display = message.member?.displayName || author.displayName || author.username;

  let content = String(message.content || '');
  content = content.replace(/<@!?(\d+)>/g, (raw, id) => {
    const user = message.mentions?.users?.get(id);
    return user ? `@${user.username} (id:${id})` : raw;
  });

  const header = [`${display} (@${author.username}, id:${author.id})`];
  if (author.bot) header.push('[BOT]');
  if (refMsg?.author) {
    const quote = String(refMsg.content || '')
      .replace(/\s+/g, ' ')
      .slice(0, 180);
    header.push(`(replying to @${refMsg.author.username} (id:${refMsg.author.id}): "${quote}")`);
  }

  const attachments = [...(message.attachments?.values() ?? [])].map(
    (a) => `[attachment: ${a.name} ${a.url}]`,
  );

  return `${header.join(' ')}: ${[content, ...attachments].filter(Boolean).join(' ')}`.trim();
}
