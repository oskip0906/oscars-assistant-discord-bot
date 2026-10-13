import { EmbedBuilder } from 'discord.js';
import { randomEmbedColor } from './colors.js';

// Egg-Man-style rich menu, now one embed per section so each card gets its own
// randomly chosen color. The first card is the greeting, the other six are the
// command categories.
function sectionEmbed(title, description, thumbnailUrl) {
  const embed = new EmbedBuilder().setColor(randomEmbedColor()).setTitle(title);
  if (description) embed.setDescription(description);
  if (thumbnailUrl) embed.setThumbnail(thumbnailUrl);
  return embed;
}

export function buildMenuEmbeds(client, config) {
  const avatarUrl = client.user.displayAvatarURL({ size: 256 });

  return [
    sectionEmbed(
      'Hello my friend! 🐼',
      `Hi, I'm **${config.botName}** — Oscar's AI familiar, rebuilt fully from scratch. ` +
        `**Mention me** (<@${client.user.id}>) or **reply to my messages** and I'll answer. ` +
        `I remember what matters from our chats. Here's everything I can do:`,
      avatarUrl,
    ),
    sectionEmbed(
      '🎵 Music Commands',
      [
        '`/play <song>` : Play a song or add it to the queue',
        '`/skip` : Skip the current track',
        '`/pause` · `/resume` : Pause / resume playback',
        '`/stop` : Stop and clear the queue',
        '`/queue` : See what’s playing next',
        '_…or just tell me “play …” in chat and I’ll handle it._',
      ].join('\n'),
    ),
    sectionEmbed(
      '🧠 AI Skill Commands',
      [
        '`/research <query> [depth]` : Deep research — plan, crawl, verify, and report with sources',
        '`/web_search <query>` : Search the web and cite links',
        '`/web_fetch <url>` : Read a full page',
        '`/image_search <query>` : Find pictures of anything',
        '`/reverse_image_search <image|url>` : Search by image — pages with matching pictures, and what it likely shows',
        '`/video_search <query>` : Find videos',
        '`/news_search <query>` : Find recent news',
        '`/wiki_search <query>` : Look something up on Wikipedia',
        '`/create_poll <question> <answers>` : Post a native Discord poll people can vote on',
        '`/create_card <title> [description] ...` : Post a rich embed card with optional buttons and dropdown',
        '_…or just ask me in chat — I still use these skills myself, plus polls, cards with buttons, and reactions._',
      ].join('\n'),
    ),
    sectionEmbed(
      '📝 Notes',
      [
        '`/save_note [minutes]` : Save an organized summary of the last 10 minutes here (or longer), filed into folders',
        '`/display_notes` : Browse every saved note, folder by folder',
        '`/open_note <title>` : Open a note by its title, or the closest match',
        '`/delete_note <note>` : Delete one of your notes',
        '_…or just ask me in chat to save, find or delete a note._',
      ].join('\n'),
    ),
    sectionEmbed(
      '⏰ Reminders',
      [
        '`/add_reminder <name> <repeat> <when> [timezone]` : I ping you in this channel once, or every day, week or month',
        '`/show_reminders` : See every active reminder',
        '`/delete_reminder <reminder>` : Delete one of your reminders',
        '_…or just tell me in chat what to remind you of and when._',
      ].join('\n'),
    ),
    sectionEmbed(
      '🛠️ Power Tools (Oscar only)',
      [
        '`/self_fix <instruction>` : Approve a remote-sandbox self-fix PR, then restart after it merges',
        '`/set_model <model>` : Switch me to another OpenRouter model',
        '`/set_rule <instruction>` : Change my personality or behavior for good',
        '`/private on|off|status` : Only respond to Oscar',
        '`/clear <number|all>` : Delete the newest messages in this channel, or all of them',
      ].join('\n'),
    ),
    sectionEmbed(
      '📖 Info',
      [
        '`/menu` : Show this menu again',
        '`/usage` : How much money I’ve spent',
        '`/model` : Which AI model I’m running on',
        '`/model <model>` : Show OpenRouter info for a specific model — price, context, providers',
      ].join('\n'),
    ),
  ];
}
