import { EmbedBuilder } from 'discord.js';

// Egg-Man-style rich menu: bold category headers, inline-code command names.
export function buildMenuEmbed(client, config) {
  return new EmbedBuilder()
    .setColor(0xb57edc)
    .setTitle('Hello my friend! 🐼')
    .setDescription(
      `Hi, I'm **${config.botName}** — Oscar's AI familiar, rebuilt fully from scratch. ` +
        `**Mention me** (<@${client.user.id}>) or **reply to my messages** and I'll answer. ` +
        `I remember each server separately. Here's everything I can do:`,
    )
    .setThumbnail(client.user.displayAvatarURL({ size: 256 }))
    .addFields(
      {
        name: '🎵 Music Commands',
        value: [
          '`/play <song>` : Play a song or add it to the queue',
          '`/skip` : Skip the current track',
          '`/pause` · `/resume` : Pause / resume playback',
          '`/stop` : Stop and clear the queue',
          '`/queue` : See what’s playing next',
          '_…or just tell me “play …” in chat and I’ll handle it._',
        ].join('\n'),
      },
      {
        name: '🧠 AI Skill Commands',
        value: [
          '`/web_search <query>` : Search the web and cite links',
          '`/web_fetch <url>` : Read a full page',
          '`/image_search <query>` : Find pictures of anything',
          '`/vault_fetch <query>` : Read Oscar’s knowledge vault',
          '`/github <body>` : GitHub API — `endpoint` & `method` are usually inferred (default `GET /user/repos`) *(public GET for all; writes/private Oscar only)*',
          '_…or just ask me in chat — I still use these skills myself, plus `get_user_id` and `react`._',
        ].join('\n'),
      },
      {
        name: '🧹 Context',
        value: [
          '`/clear` : Erase my memory of THIS server',
          '`/clearall` : Erase ALL my memory everywhere *(Oscar only)*',
        ].join('\n'),
      },
      {
        name: '🛠️ Power Tools (Oscar only)',
        value: [
          '`/claude <prompt> [directory]` : Drive Claude Code on Oscar’s Mac',
          '`/self_fix <instruction>` : Patch my own source code, push to GitHub, and restart',
          '`/git_push [message]` : Commit & push my own source changes to GitHub',
          '`/private on|off|status` : Only respond to Oscar',
        ].join('\n'),
      },
      {
        name: '📖 Info',
        value: [
          '`/menu` : Show this menu again',
          '`/usage` : How much money I’ve spent',
          '`/model` : Which AI model I’m running on',
        ].join('\n'),
      },
    )
    .setFooter({
      text: `${config.botName} 🐼 • from-scratch agent • powered by OpenRouter`,
      iconURL: client.user.displayAvatarURL({ size: 64 }),
    });
}
