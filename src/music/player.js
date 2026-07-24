import { Player, onBeforeCreateStream as registerBeforeCreateStream } from 'discord-player';
import { DefaultExtractors } from '@discord-player/extractor';
import { YoutubeiExtractor } from 'discord-player-youtubei';
import { Log } from 'youtubei.js';
import { nowPlayingEmbed } from './embeds.js';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// Absolute path to the yt-dlp binary bundled by youtube-dl-exec.
function resolveYtdlp() {
  try {
    const p = require('youtube-dl-exec/src/constants.js').YOUTUBE_DL_PATH;
    if (p) return p;
  } catch {
    /* fall through */
  }
  return path.join(path.dirname(require.resolve('youtube-dl-exec/package.json')), 'bin', 'yt-dlp');
}
const YTDLP = resolveYtdlp();

// Silence youtubei.js's internal logger. YouTube constantly ships new renderer
// types (OfficialCardView, HorizontalShelfView, …) that the pinned release
// doesn't know about; youtubei.js JIT-generates a working throwaway class and
// carries on, but logs a huge `InnertubeError: <Name> not found!` stack for
// each. Pure noise for us — mute it.
Log.setLevel(Log.Level.NONE);

const isYouTube = (url = '') => /(?:youtube\.com|youtu\.be|music\.youtube\.com)/i.test(url);

// Stream YouTube audio through yt-dlp's stdout. youtubei.js currently can't pull
// YouTube stream URLs (every innertube client returns "streaming data not
// available"), and even when it did, the WEB stream URLs throttled and reset
// mid-song (ECONNRESET → no sound). yt-dlp resolves and pipes the audio itself,
// reliably and without the reset, so we hand its stdout to discord-player (which
// transcodes it through ffmpeg). youtubei is kept only for search/metadata.
// yt-dlp needs a JavaScript runtime to solve YouTube's signature/nsig challenges
// (without one it returns "Requested format is not available"). We already run
// on Node, so point yt-dlp at this exact node binary — no deno/extra install.
const JS_RUNTIME = `node:${process.execPath}`;

function ytdlpStream(url, cookieArgs = []) {
  const proc = spawn(
    YTDLP,
    [
      '-f',
      'bestaudio[ext=webm]/bestaudio/best',
      '-o',
      '-', // write audio to stdout
      '--no-playlist',
      '--no-warnings',
      '--quiet',
      '--force-ipv4',
      '--js-runtimes',
      JS_RUNTIME,
      ...cookieArgs,
      url,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  // Watchdog: if yt-dlp produces no audio within 20s (hung auth, network stall,
  // etc.) kill it and surface an error so playback fails fast instead of the bot
  // hanging on "thinking" forever. Once audio starts, let it run the whole song.
  let started = false;
  let errTail = '';
  const watchdog = setTimeout(() => {
    if (!started) {
      console.error('[player] yt-dlp watchdog: no audio within 20s — killing');
      proc.kill('SIGKILL');
      proc.stdout.destroy(new Error('yt-dlp produced no audio (timed out)'));
    }
  }, 20_000);

  proc.stdout.once('data', () => {
    started = true;
    clearTimeout(watchdog);
  });
  proc.stderr.on('data', (d) => {
    errTail = (errTail + d).slice(-300); // keep last bit for diagnostics
  });
  proc.on('error', (err) => {
    clearTimeout(watchdog);
    console.error('[player] yt-dlp spawn error:', err.message);
    proc.stdout.destroy(err);
  });
  proc.on('close', (code) => {
    clearTimeout(watchdog);
    if (code && !started) {
      console.error(`[player] yt-dlp exited ${code}: ${errTail}`);
      proc.stdout.destroy(new Error(`yt-dlp failed (exit ${code})`));
    }
  });
  proc.stdout.on('error', () => {}); // guard against EPIPE when a track is skipped
  return proc.stdout;
}

export async function createPlayer(client, opts = {}) {
  const player = new Player(client);
  await player.extractors.loadMulti(DefaultExtractors);
  // generateWithPoToken keeps youtubei's search/metadata path healthy; actual
  // audio is streamed via yt-dlp below.
  await player.extractors.register(YoutubeiExtractor, { generateWithPoToken: true });

  // Cookie auth for yt-dlp. YouTube bot-walls unauthenticated extraction under
  // load ("Sign in to confirm you're not a bot"); a cookies file (or browser)
  // makes playback reliable. Prefer an explicit file; fall back to a browser.
  const cookieArgs = opts.cookiesFile
    ? ['--cookies', opts.cookiesFile]
    : opts.cookiesFromBrowser
      ? ['--cookies-from-browser', opts.cookiesFromBrowser]
      : [];
  if (cookieArgs.length) console.log(`[player] yt-dlp cookies: ${cookieArgs[0]} ${cookieArgs[1]}`);

  // Override the stream source for YouTube tracks: return yt-dlp's stdout so
  // discord-player never touches youtubei's broken streaming path. Returning
  // null falls back to the default extractor (e.g. for SoundCloud).
  //
  // MUST be registered via the exported global setter (or Player options) — a
  // queue reads the hook from the global registry at creation time, so assigning
  // `player.onBeforeCreateStream` after construction is silently ignored and
  // playback falls through to youtubei's broken stream (ECONNRESET, no audio).
  registerBeforeCreateStream(async (track) => {
    if (isYouTube(track.url) || track.source === 'youtube') {
      try {
        console.log(`[player] streaming via yt-dlp: ${track.title}`);
        return ytdlpStream(track.url, cookieArgs);
      } catch (err) {
        console.error('[player] yt-dlp stream failed:', err.message);
        return null;
      }
    }
    return null;
  });

  // --- Temporary deep debug: shows exactly where audio dies (voice connect →
  // opus → encryption → stream). Enable with MUSIC_DEBUG=1.
  if (process.env.MUSIC_DEBUG === '1') {
    console.log('[music] opus module:', (() => {
      try { return require('@discord-player/opus').OpusEncoder ? 'ok' : '?'; } catch { return 'FAIL'; }
    })());
    player.on('debug', (m) => console.log('[player:debug]', String(m).slice(0, 300)));
    player.events.on('debug', (q, m) => console.log('[queue:debug]', String(m).slice(0, 300)));
    player.events.on('connection', () => console.log('[music] ▶ voice CONNECTED'));
    player.events.on('connectionError', (_q, e) => console.error('[music] ✗ connectionError:', e.message));
    player.events.on('disconnect', () => console.log('[music] voice disconnected'));
    player.events.on('playerFinish', (_q, t) => console.log('[music] ✔ finished:', t.title));
    player.events.on('audioTrackAdd', (_q, t) => console.log('[music] track queued:', t.title));
  }

  player.events.on('playerStart', (queue, track) => {
    console.log('[music] ▶ playerStart:', track.title);
    queue.metadata?.channel?.send({ embeds: [nowPlayingEmbed(queue)] }).catch(() => {});
  });
  player.events.on('emptyQueue', (queue) => {
    queue.metadata?.channel?.send('✅ Queue finished.').catch(() => {});
  });

  // A track can still fail (network hiccup). Don't die silently — tell the
  // channel and move on to the next track.
  player.events.on('playerError', (queue, err, track) => {
    console.error('[player] playback error:', err.message);
    const next = queue?.tracks?.size > 0;
    queue?.metadata?.channel
      ?.send(
        `⚠️ Hit a snag playing **${track?.title ?? 'that track'}** (${short(err)}).` +
          (next ? ' Skipping to the next one.' : ' Try again in a moment.'),
      )
      .catch(() => {});
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
