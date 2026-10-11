// Model-facing inbound envelope. Conventions:
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
    // A card (send_card) has no text of its own; its title says what it was.
    const quote = String(refMsg.content || refMsg.embeds?.[0]?.title || refMsg.embeds?.[0]?.description || '')
      .replace(/\s+/g, ' ')
      .slice(0, 180);
    // The message id lets the model pull in what surrounded it with index_chat.
    header.push(`(replying to message ${refMsg.id} from @${refMsg.author.username} (id:${refMsg.author.id}): "${quote}")`);
  }

  const attachments = [...(message.attachments?.values() ?? [])].map(
    (a) => `[attachment: ${a.name} ${a.url}]`,
  );

  return `${header.join(' ')}: ${[content, ...attachments].filter(Boolean).join(' ')}`.trim();
}
