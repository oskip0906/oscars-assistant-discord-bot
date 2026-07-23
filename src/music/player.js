import { Player } from 'discord-player';
import { DefaultExtractors } from '@discord-player/extractor';
import { YoutubeiExtractor } from 'discord-player-youtubei';

export async function createPlayer(client) {
  const player = new Player(client);
  await player.extractors.loadMulti(DefaultExtractors);
  // generateWithPoToken: YouTube now gates stream URLs behind a proof-of-origin
  // token; without it playback fails with "No valid URL to decipher". The
  // extractor mints the poToken via bgutils-js/jsdom. Pairs with youtubei.js
  // pinned to ^17 (npm override) — 16.x can't extract the decipher function.
  await player.extractors.register(YoutubeiExtractor, { generateWithPoToken: true });

  player.events.on('playerStart', (queue, track) => {
    queue.metadata?.channel
      ?.send(`🎶 Now playing: **${track.title}** — ${track.author}`)
      .catch(() => {});
  });
  player.events.on('emptyQueue', (queue) => {
    queue.metadata?.channel?.send('✅ Queue finished.').catch(() => {});
  });
  player.events.on('playerError', (_queue, err) => {
    console.error('[player] track error:', err.message);
  });
  player.events.on('error', (_queue, err) => {
    console.error('[player] queue error:', err.message);
  });

  return player;
}
