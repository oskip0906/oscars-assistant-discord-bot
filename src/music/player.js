import { Player } from 'discord-player';
import { DefaultExtractors } from '@discord-player/extractor';
import { YoutubeiExtractor } from 'discord-player-youtubei';
import { Log } from 'youtubei.js';

// Silence youtubei.js's internal logger. YouTube constantly ships new renderer
// types (OfficialCardView, HorizontalShelfView, …) that the pinned release
// doesn't know about; youtubei.js JIT-generates a working throwaway class and
// carries on, but logs a huge `InnertubeError: <Name> not found!` stack for
// each one. That output is pure noise for us — extraction still works — so we
// mute it here. (Replaces the whack-a-mole per-renderer parser patch.)
Log.setLevel(Log.Level.NONE);

export async function createPlayer(client) {
  const player = new Player(client);
  await player.extractors.loadMulti(DefaultExtractors);
  // generateWithPoToken: YouTube now gates stream URLs behind a proof-of-origin
  // token; without it playback fails with "No valid URL to decipher". The
  // extractor mints the poToken via bgutils-js/jsdom. Pairs with youtubei.js
  // pinned to ^17 (npm override) — 16.x can't extract the decipher function.
  await player.extractors.register(YoutubeiExtractor, { generateWithPoToken: true });

  player.events.on('playerStart', (queue, track) => {
    queue.metadata?.channel?.send(`🎶 Now playing: **${track.title}** — ${track.author}`).catch(() => {});
  });
  player.events.on('emptyQueue', (queue) => {
    queue.metadata?.channel?.send('✅ Queue finished.').catch(() => {});
  });

  // A track can fail mid-stream (YouTube resets the connection: ECONNRESET /
  // "operation was aborted"). Don't die silently — tell the channel and let the
  // queue move on to the next track so playback keeps going.
  player.events.on('playerError', (queue, err, track) => {
    console.error('[player] playback error:', err.message);
    const next = queue?.tracks?.size > 0;
    queue?.metadata?.channel
      ?.send(
        `⚠️ Hit a snag playing **${track?.title ?? 'that track'}** (${short(err)}).` +
          (next ? ' Skipping to the next one.' : ' Try again in a moment.'),
      )
      .catch(() => {});
    // Nudge to the next track if the node stalled instead of auto-advancing.
    try {
      if (next && queue.node) queue.node.skip();
    } catch {
      /* already advanced */
    }
  });
  player.events.on('error', (_queue, err) => {
    console.error('[player] queue error:', err.message);
  });

  return player;
}

function short(err) {
  const m = String(err?.message || err);
  if (/ECONNRESET/i.test(m)) return 'YouTube reset the connection';
  if (/aborted/i.test(m)) return 'stream aborted';
  return m.slice(0, 60);
}
