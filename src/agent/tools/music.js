import * as actions from '../../music/actions.js';
import { addedEmbed, queueEmbed, nowPlayingEmbed } from '../../music/embeds.js';

export const defs = [
  {
    type: 'function',
    function: {
      name: 'play_music',
      description:
        'Control music playback in the voice channel of the user talking to you. Route ANY music phrasing here: "play X" / "I want to play: X" → action=play with query. Also skip / pause / resume / stop / queue (show queue) / nowplaying.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['play', 'skip', 'pause', 'resume', 'stop', 'queue', 'nowplaying'],
            description: 'What to do (default play)',
          },
          query: { type: 'string', description: 'Song name, artist, or URL — required for action=play' },
        },
      },
    },
  },
];

export async function playMusic({ action = 'play', query }, invocation) {
  const { guild, player } = invocation;
  if (!guild) return 'Music only works in a server, not in DMs.';
  if (!player) return 'The music player failed to initialize — playback is unavailable right now.';

  switch (action) {
    case 'play': {
      if (!query) return 'Need a song name or URL to play.';
      const voiceChannel = invocation.member?.voice?.channel;
      if (!voiceChannel) {
        return `${invocation.message.author.username} is not in a voice channel — they need to join one first.`;
      }
      const r = await actions.playQuery(player, voiceChannel, invocation.message.channel, query, invocation.message.author);
      if (!r.ok) return r.error;
      if (r.queued) {
        await invocation.message.channel.send({ embeds: [addedEmbed(r.track, r.position)] }).catch(() => {});
        return `Added **${r.track.title}** to the queue at position ${r.position}. (Posted a card in the channel — no need to repeat the details.)`;
      }
      // Playing now: the playerStart event posts the Now Playing embed itself.
      return `Now playing **${r.track.title}** by ${r.track.author}. (A Now Playing card is shown in the channel — don't repeat the details.)`;
    }
    case 'skip':
      return actions.skip(player, guild.id);
    case 'pause':
      return actions.pause(player, guild.id);
    case 'resume':
      return actions.resume(player, guild.id);
    case 'stop':
      return actions.stop(player, guild.id);
    case 'queue':
    case 'nowplaying': {
      const q = player.nodes.get(guild.id);
      if (!q?.currentTrack) return 'Nothing is playing right now.';
      const embed = action === 'nowplaying' ? nowPlayingEmbed(q) : queueEmbed(q);
      await invocation.message.channel.send({ embeds: [embed] }).catch(() => {});
      return `Posted the ${action === 'nowplaying' ? 'now-playing' : 'queue'} card in the channel. (Don't repeat the details in text.)`;
    }
    default:
      return `Unknown music action "${action}".`;
  }
}
