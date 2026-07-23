// Shared music helpers used by both slash commands and the play_music AI tool.

export async function playQuery(player, voiceChannel, textChannel, query, requestedBy) {
  try {
    const { track, queue } = await player.play(voiceChannel, query, {
      requestedBy,
      nodeOptions: {
        metadata: { channel: textChannel },
        volume: 60,
        selfDeaf: true,
        leaveOnEmpty: true,
        leaveOnEmptyCooldown: 60_000,
        leaveOnEnd: true,
        leaveOnEndCooldown: 120_000,
      },
    });
    const queued = queue?.currentTrack && queue.currentTrack.id !== track.id;
    return `🎶 ${queued ? `Queued (position ${queue.tracks.size})` : 'Playing'}: **${track.title}** by ${track.author} \`${track.duration}\``;
  } catch (err) {
    return `❌ Couldn't play "${query}": ${String(err.message || err).slice(0, 200)}`;
  }
}

const getQueue = (player, guildId) => player.nodes.get(guildId);

export function skip(player, guildId) {
  const queue = getQueue(player, guildId);
  if (!queue?.currentTrack) return 'Nothing is playing.';
  const title = queue.currentTrack.title;
  queue.node.skip();
  return `⏭️ Skipped **${title}**.`;
}

export function pause(player, guildId) {
  const queue = getQueue(player, guildId);
  if (!queue?.currentTrack) return 'Nothing is playing.';
  queue.node.setPaused(true);
  return '⏸️ Paused.';
}

export function resume(player, guildId) {
  const queue = getQueue(player, guildId);
  if (!queue?.currentTrack) return 'Nothing is playing.';
  queue.node.setPaused(false);
  return '▶️ Resumed.';
}

export function stop(player, guildId) {
  const queue = getQueue(player, guildId);
  if (!queue) return 'Nothing is playing.';
  queue.delete();
  return '⏹️ Stopped and cleared the queue.';
}

export function queueInfo(player, guildId) {
  const queue = getQueue(player, guildId);
  if (!queue?.currentTrack) return 'Nothing is playing.';
  const lines = [
    `▶️ Now playing: **${queue.currentTrack.title}** by ${queue.currentTrack.author} \`${queue.currentTrack.duration}\`${queue.node.isPaused() ? ' (paused)' : ''}`,
  ];
  const upNext = queue.tracks.toArray().slice(0, 10);
  if (upNext.length) {
    lines.push('', '**Up next:**');
    upNext.forEach((t, i) => lines.push(`${i + 1}. ${t.title} \`${t.duration}\``));
    if (queue.tracks.size > 10) lines.push(`…and ${queue.tracks.size - 10} more`);
  }
  return lines.join('\n');
}
