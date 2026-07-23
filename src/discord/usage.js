import { EmbedBuilder } from 'discord.js';

// Live usage straight from OpenRouter — no local tracking. The /key endpoint
// reports spend for exactly the API key the bot runs on (shown as Panda's
// usage; the key's name is never displayed).
async function fetchJson(url, config) {
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${config.openrouterApiKey}` } });
    if (!res.ok) return null;
    return (await res.json()).data || null;
  } catch {
    return null;
  }
}

const usd = (n) => `$${(Number(n) || 0).toFixed(4)}`;

export async function buildUsageEmbed(client, config) {
  const key = await fetchJson('https://openrouter.ai/api/v1/key', config);

  return new EmbedBuilder()
    .setColor(0xb57edc)
    .setTitle('💸 Usage & Spend')
    .setThumbnail(client.user.displayAvatarURL({ size: 256 }))
    .addFields({
      name: '🐼 Panda',
      value: key
        ? [
            `**Today:** ${usd(key.usage_daily)}`,
            `**This week:** ${usd(key.usage_weekly)}`,
            `**This month:** ${usd(key.usage_monthly)}`,
            `**All-time:** ${usd(key.usage)}`,
            ...(key.limit != null
              ? [`**Budget:** ${usd(key.limit_remaining)} left of ${usd(key.limit)} (${key.limit_reset || 'fixed'})`]
              : []),
          ].join('\n')
        : '_Couldn’t reach OpenRouter for usage right now._',
      inline: false,
    });
}
