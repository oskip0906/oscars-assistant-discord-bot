import { EmbedBuilder } from 'discord.js';
import { randomEmbedColor } from './colors.js';
import { repeatText } from '../reminders.js';

const unix = (date) => Math.floor(new Date(date).getTime() / 1000);

// Every active reminder, soonest first. Discord shows <t:…> in each viewer's own timezone.
export function remindersEmbed(rows) {
  const embed = new EmbedBuilder().setColor(randomEmbedColor()).setTitle('⏰ Active reminders');
  if (!rows.length) return embed.setDescription('No active reminders — add one with `/add_reminder`.');
  const shown = rows.slice(0, 25);
  embed.addFields(
    shown.map((r) => ({
      name: `⏰ ${r.name}`.slice(0, 256),
      value: [
        `<@${r.user_id}> · next <t:${unix(r.next_at)}:F> (<t:${unix(r.next_at)}:R>)`,
        `🔁 ${repeatText(r)}`,
        r.last_error ? `⚠️ Last DM failed: ${r.last_error}` : '',
      ]
        .filter(Boolean)
        .join('\n')
        .slice(0, 1024),
    })),
  );
  return embed.setFooter({ text: rows.length > shown.length ? `Showing ${shown.length} of ${rows.length}` : `${rows.length} reminder(s)` });
}
