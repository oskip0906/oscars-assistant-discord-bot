// Shared music helpers used by both slash commands and the play_music AI tool.

// Returns { ok:true, track, queued, position } or { ok:false, error }.
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
    const queued = Boolean(queue?.currentTrack && queue.currentTrack.id !== track.id);
    return { ok: true, track, queued, position: queued ? queue.tracks.size : 0 };
  } catch (err) {
    return { ok: false, error: `❌ Couldn't play "${query}": ${String(err.message || err).slice(0, 200)}` };
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
