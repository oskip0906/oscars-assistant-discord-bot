import { EmbedBuilder } from 'discord.js';
import { randomEmbedColor } from '../discord/colors.js';

const num = (n) => Number(n || 0).toLocaleString('en-US');
const cap = (s) => (s ? String(s).charAt(0).toUpperCase() + String(s).slice(1) : 'Unknown');
const trunc = (s, n = 58) => {
  const str = String(s || 'Unknown');
  return str.length > n ? `${str.slice(0, n - 1)}…` : str;
};
const safeUrl = (u) => (/^https?:\/\//i.test(u || '') ? u : null);
const mention = (t) => (t.requestedBy ? `<@${t.requestedBy.id}>` : '—');

function humanDuration(ms) {
  const total = Math.round((ms || 0) / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h ? `${h}h ${m}m` : m ? `${m}m ${s}s` : `${s}s`;
}

// Rich "Now Playing" card — linked title, thumbnail, progress bar, metadata.
export function nowPlayingEmbed(queue) {
  const t = queue.currentTrack;
  const paused = queue.node.isPaused();
  const bar = queue.node.createProgressBar({ length: 16, timecodes: true }) || '';

  const embed = new EmbedBuilder()
    .setColor(randomEmbedColor())
    .setAuthor({ name: paused ? '⏸️ Paused' : '🎶 Now Playing' })
    .setTitle(trunc(t.title))
    .setDescription(`by **${t.author}**${bar ? `\n\n${bar}` : ''}\n\n🔗 ${t.url}`)
    .addFields(
      { name: 'Duration', value: `\`${t.duration || '—'}\``, inline: true },
      { name: 'Requested by', value: mention(t), inline: true },
      { name: 'Source', value: cap(t.source), inline: true },
    );

  const url = safeUrl(t.url);
  if (url) embed.setURL(url);
  if (t.thumbnail) embed.setThumbnail(t.thumbnail);
  if (t.views) embed.addFields({ name: 'Views', value: num(t.views), inline: true });

  const up = queue.tracks.size;
  if (up) embed.addFields({ name: 'Up next', value: `${up} track${up > 1 ? 's' : ''} — \`/queue\``, inline: true });

  embed.setFooter({ text: `Volume ${queue.node.volume}%${queue.repeatMode ? ' • loop on' : ''}` });
  return embed;
}

// "Added to Queue" confirmation card for a newly-queued track.
export function addedEmbed(track, position) {
  const embed = new EmbedBuilder()
    .setColor(randomEmbedColor())
    .setAuthor({ name: '➕ Added to Queue' })
    .setTitle(trunc(track.title))
    .setDescription(`by **${track.author}**\n\n🔗 ${track.url}`)
    .addFields(
      { name: 'Duration', value: `\`${track.duration || '—'}\``, inline: true },
      { name: 'Position', value: `#${position}`, inline: true },
      { name: 'Requested by', value: mention(track), inline: true },
    );
  const url = safeUrl(track.url);
  if (url) embed.setURL(url);
  if (track.thumbnail) embed.setThumbnail(track.thumbnail);
  return embed;
}

// Full queue listing — now playing + numbered up-next with links.
export function queueEmbed(queue) {
  const t = queue.currentTrack;
  const up = queue.tracks.toArray();
  const listed = up
    .slice(0, 10)
    .map((tr, i) => `\`${String(i + 1).padStart(2, ' ')}.\` **[${trunc(tr.title, 48)}](${tr.url})** \`${tr.duration}\` · ${mention(tr)}`);
  if (up.length > 10) listed.push(`…and **${up.length - 10}** more`);

  const totalMs = up.reduce((s, tr) => s + (tr.durationMS || 0), 0) + (t?.durationMS || 0);

  const nowLine = t
    ? `**▶️ Now Playing**\n**[${trunc(t.title, 48)}](${t.url})** \`${t.duration}\`${queue.node.isPaused() ? ' *(paused)*' : ''} · ${mention(t)}\n\n`
    : '';

  const embed = new EmbedBuilder()
    .setColor(randomEmbedColor())
    .setTitle('🎶 Queue')
    .setDescription(nowLine + (listed.length ? `**Up Next**\n${listed.join('\n')}` : '_Nothing queued — add more with `/play`._'))
    .setFooter({
      text: `${up.length} in queue • ~${humanDuration(totalMs)} total • volume ${queue.node.volume}%`,
    });
  if (t?.thumbnail) embed.setThumbnail(t.thumbnail);
  return embed;
}
