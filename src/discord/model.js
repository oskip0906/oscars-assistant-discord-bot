import fs from 'node:fs';
import path from 'node:path';
import { EmbedBuilder } from 'discord.js';

// The model the RUNNING process uses is config.model (loaded from .env at
// startup). Re-read .env live so we can flag an edited-but-not-applied value.
export function readEnvModel(config) {
  try {
    const raw = fs.readFileSync(path.join(config.projectRoot, '.env'), 'utf8');
    const line = raw.split('\n').find((l) => l.trim().startsWith('OPENROUTER_MODEL='));
    if (!line) return null;
    const value = line.slice(line.indexOf('=') + 1).split('#')[0].trim();
    return value || null;
  } catch {
    return null;
  }
}

export function buildModelEmbed(client, config) {
  const envModel = readEnvModel(config);
  const pendingChange = envModel && envModel !== config.model;

  return new EmbedBuilder()
    .setColor(0xb57edc)
    .setTitle('🧠 Model')
    .setThumbnail(client.user.displayAvatarURL({ size: 256 }))
    .addFields({
      name: '🐼 Currently running',
      value: [
        `\`${config.model}\``,
        ...(pendingChange
          ? [`⚠️ \`.env\` now says \`${envModel}\` — restart me to apply it.`]
          : []),
      ].join('\n'),
      inline: false,
    });
}
