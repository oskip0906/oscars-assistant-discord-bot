import { once } from 'node:events';
import { Readable } from 'node:stream';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import {
  AudioPlayerStatus,
  EndBehaviorType,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
} from '@discordjs/voice';
import OpusScript from 'opusscript';
import { prebuffer, spokenPart, toMono, wav, wavStreamToDiscordPcm } from './audio.js';
import { synthesizeStream, transcribe } from './speech.js';

// Voice mode. Panda sits in a voice channel and listens to everyone in it,
// bots included. Each utterance (ended by a pause) is transcribed and posted
// in the channel's own chat as the speaker, then handed to the same message
// handler as typed text (same gate, batching, tools, owner checks and private
// mode). The start of the reply is read aloud. One session
// per server: music (discord-player) and this each own the server's single
// voice adapter, so they never run in the same server at once.

const IDLE_MS = 5 * 60_000;
const QUIET_MS = 1000; // this much silence ends an utterance
const BYTES_PER_SECOND = 48000 * 2 * 2; // 48 kHz, stereo, 16-bit
const MIN_BYTES = 0.6 * BYTES_PER_SECOND; // shorter is a cough or a click, not speech
const MAX_BYTES = 30 * BYTES_PER_SECOND;
// Playback starts with this much audio in hand (48 kHz stereo 16-bit), so it doesn't stutter.
const PREBUFFER_BYTES = 0.3 * BYTES_PER_SECOND;
// Panda waits up to this long for someone to finish before it starts talking.
const FLOOR_WAIT_MS = 2000;
// Played speech arrives as it is made; a hold-up this long (in 20 ms frames)
// is waited out in silence instead of ending the reply.
const MAX_STALL_FRAMES = 250;
const NEEDED = ['ViewChannel', 'Connect', 'Speak', 'SendMessages'];
const WEBHOOK_NAME = 'Panda voice';
// Transcripts post as "Slopbot (speaker)" rather than as the speaker alone
// (DerpZ's workaround); Discord caps webhook usernames at 80 characters.
const SENDER_NAME = 'Slopbot';
export function transcriptUsername(name) {
  const max = 80 - `${SENDER_NAME} ()`.length;
  return `${SENDER_NAME} (${name.length > max ? `${name.slice(0, max - 1)}…` : name})`;
}

// guildId -> session
const sessions = new Map();
// channelId -> the channel's "Panda voice" webhook; the ids are how the message
// handler tells the transcripts it posted from anyone else's messages.
const webhooks = new Map();
const webhookIds = new Set();
// { client, config, privateMode, onMessage, player }, set once at boot.
let app = {};

export function initVoice(deps) {
  app = deps;
}

export const isVoiceActive = (guildId) => sessions.has(guildId);
export const isVoiceWebhook = (webhookId) => webhookIds.has(webhookId);

// Private mode answers only Oscar, so a guest's voice must never be sent off to be transcribed.
const blocked = (userId) => app.privateMode?.isOn() && userId !== app.config.ownerId;

// The channel's "Panda voice" webhook, found or made on first use.
export async function voiceWebhook(channel) {
  let hook = webhooks.get(channel.id);
  if (!hook) {
    const mine = (await channel.fetchWebhooks()).find((w) => w.name === WEBHOOK_NAME && w.owner?.id === app.client.user.id);
    hook = mine ?? (await channel.createWebhook({ name: WEBHOOK_NAME, reason: 'Posts what people say in voice, as them' }));
    webhooks.set(channel.id, hook);
    webhookIds.add(hook.id);
  }
  return hook;
}

// What was said, in the voice channel's chat as "Slopbot (speaker)" with the
// speaker's picture. Without a usable webhook (no Manage Webhooks, say) Panda quotes them.
async function postTranscript(session, member, text) {
  try {
    const hook = await voiceWebhook(session.channel);
    return await hook.send({ content: text, username: transcriptUsername(member.displayName), avatarURL: member.displayAvatarURL(), allowedMentions: { parse: [] } });
  } catch (err) {
    webhooks.delete(session.channel.id); // maybe deleted: look it up again next time
    console.error('[voice] webhook unavailable, posting as Panda:', String(err.message || err).slice(0, 150));
    return session.channel.send({ content: `**${member.displayName}** (from voice): ${text}`, allowedMentions: { parse: [] } });
  }
}

// The transcript as the message handler sees it: shaped like a typed message
// from the speaker (see clickAsMessage in agent/tools/ui.js). The author is the
// real speaker, known from Discord's voice connection, so owner checks hold.
export function voiceMessage(posted, member, text, session) {
  const { channel, guild } = session;
  return {
    id: posted.id,
    channelId: channel.id,
    channel,
    guild,
    guildId: guild.id,
    // Jev reads Panda's names from the message's client.
    client: posted.client,
    member,
    author: member.user,
    content: text,
    createdAt: new Date(),
    mentions: { users: new Map() },
    attachments: new Map(),
    embeds: [],
    reference: null,
    react: (emoji) => posted.react(emoji),
    reactions: posted.reactions,
    reply: async (payload) => {
      try {
        return await posted.reply(payload);
      } catch {
        return channel.send(payload);
      }
    },
    fromVoice: true,
    speak: (reply) => session.speak(reply),
  };
}

// --- listening --------------------------------------------------------------

// Everyone in the channel is heard, other bots too; only Panda itself isn't.
function listen(session, userId) {
  if (session.closed || session.capturing.has(userId) || userId === app.client.user?.id) return;
  // Panda's own voice comes back through other people's speakers; don't answer it.
  if (session.player.state.status !== AudioPlayerStatus.Idle) return;
  if (blocked(userId)) return;
  const known = session.guild.members.cache.get(userId);

  touch(session);
  const decoder = new OpusScript(48000, 2, OpusScript.Application.AUDIO);
  const chunks = [];
  let bytes = 0;
  const stream = session.connection.receiver.subscribe(userId, { end: { behavior: EndBehaviorType.AfterSilence, duration: QUIET_MS } });
  session.capturing.set(userId, stream);
  stream.on('data', (packet) => {
    try {
      const pcm = decoder.decode(packet);
      chunks.push(pcm);
      bytes += pcm.length;
    } catch {
      // a damaged packet is a gap in the audio
    }
    if (bytes >= MAX_BYTES) stream.destroy();
  });
  stream.on('error', (err) => console.error('[voice] audio stream failed:', String(err.message || err).slice(0, 150)));
  // 'close' follows every way a stream ends: silence, the cap, an error, leaving.
  stream.once('close', () => {
    decoder.delete();
    if (session.capturing.get(userId) === stream) session.capturing.delete(userId);
    // Cut off at the cap mid-sentence: carry on listening, so the rest isn't lost.
    if (bytes >= MAX_BYTES && session.connection.receiver.speaking.users.has(userId)) listen(session, userId);
    handleSpeech(session, userId, known, Buffer.concat(chunks)).catch((err) =>
      console.error('[voice] could not handle what was said:', String(err.message || err).slice(0, 200)),
    );
  });
}

// Utterances are transcribed side by side but posted in the order they ended,
// each exactly once, so a quick line never jumps ahead of a long one before it.
async function handleSpeech(session, userId, known, pcm) {
  if (session.closed || pcm.length < MIN_BYTES || blocked(userId)) return;
  const started = Date.now();
  const heard = Promise.all([
    known ?? session.guild.members.fetch(userId).catch(() => null),
    transcribe(app.config, wav(toMono(pcm), { sampleRate: 48000, channels: 1 })),
  ]);
  heard.catch(() => {}); // a failure surfaces where it is awaited, never as an unhandled rejection
  const turn = session.heard.then(async () => {
    const [member, text] = await heard;
    if (!member) return null;
    // Timing only, like the turn logs: what people say stays out of the logs.
    console.log(`[voice] ${(pcm.length / BYTES_PER_SECOND).toFixed(1)}s from @${member.user.username} transcribed in ${Date.now() - started}ms`);
    if (session.closed || !/[\p{L}\p{N}]/u.test(text)) return null;
    return { member, text, posted: await postTranscript(session, member, text) };
  });
  session.heard = turn.catch(() => {});
  const said = await turn;
  if (said && !session.closed) await app.onMessage(voiceMessage(said.posted, said.member, said.text, session));
}

// --- speaking ---------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Someone other than Panda has sent audio in the last 100 ms (Discord's speaking map).
const floorTaken = (session) => [...session.connection.receiver.speaking.users.keys()].some((id) => id !== app.client.user?.id && !blocked(id));

// Plays one reply's audio as it arrives and resolves when the player is idle again.
async function play(session, pcm) {
  const finished = once(session.player, AudioPlayerStatus.Idle);
  session.player.play(createAudioResource(Readable.from(pcm), { inputType: StreamType.Raw }));
  await finished;
}

// One reply, in one thunder request streamed into one audio resource: no gap
// and no change of voice between its sentences. Like a person, Panda first
// waits (a little) for whoever is talking to finish. `gen` is the speech
// generation the reply was queued in; hush() moves it on, dropping the reply.
async function say(session, text, gen) {
  const spoken = spokenPart(text);
  if (!spoken) return;
  const abort = new AbortController();
  session.speaking = abort;
  try {
    for (const until = Date.now() + FLOOR_WAIT_MS; !abort.signal.aborted && floorTaken(session) && Date.now() < until; ) await sleep(100);
    if (abort.signal.aborted || gen !== session.speechGen || session.closed) return;
    const audio = await synthesizeStream(app.config, spoken, { signal: abort.signal });
    if (abort.signal.aborted || gen !== session.speechGen || session.closed) return;
    await play(session, prebuffer(wavStreamToDiscordPcm(audio), PREBUFFER_BYTES));
  } catch (err) {
    if (!abort.signal.aborted) throw err; // a reply cut off on purpose is not a failure
  } finally {
    if (session.speaking === abort) session.speaking = null;
  }
}

// Replies are spoken one after another, in the order they arrive; hush() drops
// every one queued before it.
function queueSpeech(session, text) {
  const gen = session.speechGen;
  session.queue = session.queue
    .then(() => (gen === session.speechGen && !session.closed ? say(session, text, gen) : null))
    .catch((err) => console.error('[voice] could not speak the reply:', String(err.message || err).slice(0, 200)))
    .then(() => touch(session));
  return session.queue;
}

// Talked over (or told to stop): Panda stops mid-word, and neither the rest of
// that reply nor any reply waiting behind it is said.
function hush(session) {
  session.speechGen++;
  session.speaking?.abort();
  session.player.stop(true);
}

// "@Panda stop" also stops what Panda is saying in that server's call. True when it was saying something.
export function stopSpeaking(guildId) {
  const session = sessions.get(guildId);
  if (!session?.speaking) return false;
  hush(session);
  return true;
}

// --- the session ------------------------------------------------------------

function touch(session) {
  if (session.closed) return;
  clearTimeout(session.idle);
  session.idle = setTimeout(() => close(session, '👋 Left voice after 5 minutes of quiet.'), IDLE_MS);
}

// Ends a session however it ends; safe to call twice.
function close(session, farewell = '') {
  if (session.closed) return;
  session.closed = true;
  clearTimeout(session.idle);
  if (sessions.get(session.guild.id) === session) sessions.delete(session.guild.id);
  hush(session); // stops the reply being said and its download; replies waiting behind it see the session closed
  // Utterances still being captured end now; their 'close' sees the session closed and drops them.
  for (const stream of session.capturing.values()) stream.destroy();
  if (session.connection.state.status !== VoiceConnectionStatus.Destroyed) session.connection.destroy();
  console.log(`[voice] left ${session.channel.name} in ${session.guild.name}`);
  if (farewell) session.channel.send(farewell).catch(() => {});
}

const readable = (permission) => permission.replace(/(?<=[a-z])(?=[A-Z])/g, ' ');

// Join the voice channel `member` is in. Returns what to tell the person.
export async function joinVoice(member) {
  if (!app.config?.pmsAiKey) return "Voice isn't set up (PMS_AI_KEY is missing).";
  const channel = member.voice?.channel;
  if (!channel) return 'Join a voice channel first, then ask me again.';
  if (channel.type !== ChannelType.GuildVoice) return `I can't join stage channels yet. Join a regular voice channel instead of **${channel.name}**.`;
  const { guild } = member;
  const perms = channel.permissionsFor(guild.members.me);
  const missing = NEEDED.filter((name) => !perms?.has(PermissionFlagsBits[name]));
  if (missing.length) return `I can't use **${channel.name}**: I'm missing the ${missing.map(readable).join(', ')} permission${missing.length > 1 ? 's' : ''} there.`;

  const current = sessions.get(guild.id);
  if (current?.channel.id === channel.id) return `I'm already in **${channel.name}**.`;
  if (current) close(current);
  // Music is stopped first: it would otherwise take the server's voice adapter from this.
  const music = app.player?.nodes.get(guild.id);
  music?.delete();

  const connection = joinVoiceChannel({ channelId: channel.id, guildId: guild.id, adapterCreator: guild.voiceAdapterCreator, selfDeaf: false, selfMute: false });
  const player = createAudioPlayer({ behaviors: { maxMissedFrames: MAX_STALL_FRAMES } });
  // capturing: userId -> the utterance stream being recorded; heard: the transcripts' posting order;
  // speaking: the AbortController of the reply being said; speechGen: moved on by hush(), dropping replies queued before it.
  const session = {
    guild, channel, connection, player, capturing: new Map(), idle: null, closed: false, queue: Promise.resolve(), heard: Promise.resolve(),
    speaking: null, speechGen: 0, speak: (reply) => queueSpeech(session, reply),
  };
  sessions.set(guild.id, session); // from now on music is refused here too
  // Without listeners an 'error' event would crash the bot.
  connection.on('error', (err) => console.error('[voice] connection error:', String(err.message || err).slice(0, 150)));
  player.on('error', (err) => console.error('[voice] playback error:', String(err.message || err).slice(0, 150)));
  connection.once(VoiceConnectionStatus.Destroyed, () => close(session));
  // Discord moving Panda to another channel looks like a disconnect that
  // reconnects on its own; one that doesn't within 5 s is a real one (a kick).
  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([entersState(connection, VoiceConnectionStatus.Signalling, 5_000), entersState(connection, VoiceConnectionStatus.Connecting, 5_000)]);
    } catch {
      close(session);
    }
  });
  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
  } catch (err) {
    console.error(`[voice] could not connect to ${channel.name} in ${guild.name}:`, String(err.message || err));
    close(session);
    return `❌ Couldn't connect to **${channel.name}**: Discord's voice server didn't answer in time.`;
  }
  connection.subscribe(player);
  connection.receiver.speaking.on('start', (userId) => listen(session, userId));
  touch(session);
  console.log(`[voice] joined ${channel.name} in ${guild.name}`);
  await channel
    .send({
      content: `🎙️ I'm in **${channel.name}**. Everything said here is transcribed into this chat, and I answer here and out loud. I leave after 5 minutes of quiet, or use \`/voice leave\`.`,
      allowedMentions: { parse: [] },
    })
    .catch(() => {});
  return `🎙️ Joined **${channel.name}**.${music ? ' I stopped the music.' : ''}`;
}

export function leaveVoice(guildId) {
  const session = sessions.get(guildId);
  if (!session) return "I'm not in a voice channel here.";
  close(session);
  return `👋 Left **${session.channel.name}**.`;
}

export function voiceStatus(guildId) {
  const session = sessions.get(guildId);
  return session ? `🎙️ In **${session.channel.name}**, listening. I leave after 5 minutes of quiet.` : "I'm not in a voice channel here.";
}

// /voice and the voice tool: `action` is join, leave or status.
export async function voiceCommand(action, member) {
  const guildId = member?.guild?.id;
  if (!guildId) return 'Voice only works in a server.';
  if (action === 'join') return joinVoice(member);
  if (action === 'leave') return leaveVoice(guildId);
  return voiceStatus(guildId);
}
