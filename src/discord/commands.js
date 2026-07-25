import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { buildMenuEmbed } from './menu.js';
import { buildUsageEmbed } from './usage.js';
import { buildModelEmbed } from './model.js';
import { chunkMessage } from './chunk.js';
import { suppressLinkEmbeds } from './messageHandler.js';
import { PRIVATE_MESSAGE } from '../privateMode.js';
import * as actions from '../music/actions.js';
import { addedEmbed, queueEmbed } from '../music/embeds.js';
import { webSearch, webFetch, imageSearch } from '../agent/tools/search.js';
import { vaultFetch, githubCall } from '../agent/tools/github.js';
import { selfFix, gitPush } from '../agent/tools/source.js';

export const commandDefs = [
  new SlashCommandBuilder().setName('menu').setDescription('Show everything Panda can do'),
  new SlashCommandBuilder().setName('usage').setDescription('Show how much money Panda has spent'),
  new SlashCommandBuilder().setName('model').setDescription('Show which AI model Panda is running on'),
  new SlashCommandBuilder()
    .setName('play')
    .setDescription('Play a song (or add it to the queue)')
    .addStringOption((o) => o.setName('query').setDescription('Song name, artist, or URL').setRequired(true)),
  new SlashCommandBuilder().setName('skip').setDescription('Skip the current track'),
  new SlashCommandBuilder().setName('pause').setDescription('Pause playback'),
  new SlashCommandBuilder().setName('resume').setDescription('Resume playback'),
  new SlashCommandBuilder().setName('stop').setDescription('Stop playback and clear the queue'),
  new SlashCommandBuilder().setName('queue').setDescription('Show the current queue'),
  new SlashCommandBuilder().setName('clear').setDescription("Erase Panda's memory of this server"),
  new SlashCommandBuilder().setName('clearall').setDescription('Erase ALL of Panda’s memory (owner only)'),
  new SlashCommandBuilder()
    .setName('web_search')
    .setDescription('Search the web and get cited links')
    // Only `query` is user-facing; result `count` is left to the tool default.
    .addStringOption((o) => o.setName('query').setDescription('What to search for').setRequired(true)),
  new SlashCommandBuilder()
    .setName('web_fetch')
    .setDescription('Fetch and read the full content of a web page')
    // Only `url` is user-facing; `max_chars` is left to the tool default.
    .addStringOption((o) => o.setName('url').setDescription('Full URL (http:// or https://)').setRequired(true)),
  new SlashCommandBuilder()
    .setName('image_search')
    .setDescription('Search for images')
    // Only `query` is user-facing; result `count` is left to the tool default.
    .addStringOption((o) => o.setName('query').setDescription('What to find pictures of').setRequired(true)),
  new SlashCommandBuilder()
    .setName('vault_fetch')
    .setDescription("Read Oscar's knowledge vault")
    // Only `query` is user-facing; `path` is resolved programmatically.
    .addStringOption((o) => o.setName('query').setDescription('What to look for in the vault')),
  new SlashCommandBuilder()
    .setName('github')
    .setDescription('Call the GitHub API (writes/private repos are owner only)')
    // Only `body` is user-facing; `endpoint`/`method` are resolved
    // programmatically (default: GET /user/repos when only a body is given).
    .addStringOption((o) => o.setName('body').setDescription('Optional JSON body / request details')),
  new SlashCommandBuilder()
    .setName('self_fix')
    .setDescription('Patch Panda’s own source code and restart (owner only)')
    .addStringOption((o) => o.setName('instruction').setDescription('What to change/fix about the bot').setRequired(true)),
  new SlashCommandBuilder()
    .setName('git_push')
    .setDescription("Commit & push Panda's own source changes to GitHub (owner only)")
    .addStringOption((o) => o.setName('message').setDescription('Commit message (optional)')),
  new SlashCommandBuilder()
    .setName('private')
    .setDescription('Private mode: Panda only responds to Oscar (owner only)')
    .addStringOption((o) =>
      o
        .setName('state')
        .setDescription('Turn private mode on, off, or check status')
        .setRequired(true)
        .addChoices(
          { name: 'on', value: 'on' },
          { name: 'off', value: 'off' },
          { name: 'status', value: 'status' },
        ),
    ),
].map((b) => b.toJSON());

const WRITE_METHODS = ['POST', 'PATCH', 'PUT', 'DELETE'];

export function createInteractionHandler({ client, config, contextStore, player, privateMode }) {
  return async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    // Discord gives 3s to acknowledge an interaction. One delivered while the
    // bot was down (e.g. during a self_fix restart) can arrive already near/past
    // that deadline — any deferReply/reply then throws 10062 "Unknown
    // interaction". Drop it up front instead of failing a doomed API call.
    if (Date.now() - interaction.createdTimestamp > 2600) return;

    // Minimal invocation shim so the shared tool functions (which were written
    // for the message pipeline) work when driven by a slash command. Only the
    // fields the tools actually read are provided: config, isOwner, a channel
    // to post progress into, and requestRestart (self_fix flips it).
    const buildInvocation = () => ({
      config,
      client,
      isOwner: interaction.user.id === config.ownerId,
      // Some tools (self_fix) post progress via message.channel.send;
      // fall back to a no-op channel if the interaction has no cached channel.
      message: { channel: interaction.channel ?? { send: async () => {} } },
      requestRestart: false,
    });

    // Tools return plain strings that can exceed Discord's 2000-char cap and
    // may contain bare URLs. Chunk + suppress link embeds like the chat path.
    const sendToolResult = async (text) => {
      const parts = chunkMessage(suppressLinkEmbeds(String(text)));
      await interaction.editReply({ content: parts[0], allowedMentions: { parse: [] } });
      for (let i = 1; i < parts.length; i++) {
        await interaction.followUp({ content: parts[i], allowedMentions: { parse: [] } });
      }
    };

    // Defer, run a tool, stream the result back.
    const runTool = async (fn, args) => {
      await interaction.deferReply();
      const result = await fn(args, buildInvocation());
      await sendToolResult(result);
    };

    try {
      const name = interaction.commandName;

      // Private mode gates non-owner interactions too (it's a private
      // conversation with Oscar — nothing else goes through).
      const isOwner = interaction.user.id === config.ownerId;
      if (name !== 'private' && privateMode?.isOn() && !isOwner) {
        return await interaction.reply({
          content: PRIVATE_MESSAGE,
          flags: MessageFlags.Ephemeral,
        });
      }

      if (name === 'private') {
        if (!isOwner) {
          return await interaction.reply({ content: '⛔ Owner only.', flags: MessageFlags.Ephemeral });
        }
        const state = interaction.options.getString('state', true);
        if (state === 'status') {
          return await interaction.reply({
            content: `🔒 Private mode is currently **${privateMode.isOn() ? 'ON' : 'OFF'}**.`,
            flags: MessageFlags.Ephemeral,
          });
        }
        privateMode.set(state === 'on');
        return await interaction.reply({
          content:
            state === 'on'
              ? '🔒 Private mode **ON** — I’ll only respond to you now; everyone else gets turned away.'
              : '🔓 Private mode **OFF** — I’m back to talking with everyone.',
          flags: MessageFlags.Ephemeral,
        });
      }

      if (name === 'menu') {
        return await interaction.reply({ embeds: [buildMenuEmbed(client, config)] });
      }

      if (name === 'usage') {
        await interaction.deferReply();
        const embed = await buildUsageEmbed(client, config);
        return await interaction.editReply({ embeds: [embed] });
      }

      if (name === 'model') {
        return await interaction.reply({ embeds: [buildModelEmbed(client, config)] });
      }

      if (name === 'clear') {
        const key = interaction.guildId ?? `dm:${interaction.user.id}`;
        contextStore.clear(key);
        return await interaction.reply('🧹 My memory of this server has been wiped. Fresh start!');
      }

      if (name === 'clearall') {
        if (interaction.user.id !== config.ownerId) {
          return await interaction.reply({ content: '⛔ Owner only.', flags: MessageFlags.Ephemeral });
        }
        contextStore.clearAll();
        return await interaction.reply('🧹 ALL context in every server and DM has been erased.');
      }

      // --- Tool slash commands (work in servers and DMs) ---------------

      if (name === 'web_search') {
        // `count` is hidden from the UI — let the tool apply its own default.
        return await runTool(webSearch, {
          query: interaction.options.getString('query', true),
          count: undefined,
        });
      }

      if (name === 'web_fetch') {
        // `max_chars` is hidden from the UI — let the tool apply its own default.
        return await runTool(webFetch, {
          url: interaction.options.getString('url', true),
          max_chars: undefined,
        });
      }

      if (name === 'image_search') {
        // `count` is hidden from the UI — let the tool apply its own default.
        return await runTool(imageSearch, {
          query: interaction.options.getString('query', true),
          count: undefined,
        });
      }

      if (name === 'vault_fetch') {
        // `path` is hidden from the UI — resolved programmatically by the tool
        // (a query-only fetch searches the vault rather than reading a fixed path).
        return await runTool(vaultFetch, {
          path: undefined,
          query: interaction.options.getString('query') ?? undefined,
        });
      }

      if (name === 'github') {
        // `endpoint` and `method` are no longer user-facing. Default to the most
        // common read action (list the caller's repos). A body-only invocation
        // still resolves to a safe GET.
        const endpoint = '/user/repos';
        const method = 'GET';
        const bodyRaw = interaction.options.getString('body');

        // Writes (POST/PATCH/PUT/DELETE) act with Oscar's PAT — owner only.
        if (WRITE_METHODS.includes(method) && !isOwner) {
          return await interaction.reply({
            content: '⛔ Write methods (POST/PATCH/PUT/DELETE) are owner only.',
            flags: MessageFlags.Ephemeral,
          });
        }
        let body;
        if (bodyRaw) {
          try {
            body = JSON.parse(bodyRaw);
          } catch {
            return await interaction.reply({
              content: '⚠️ `body` must be valid JSON.',
              flags: MessageFlags.Ephemeral,
            });
          }
        }
        await interaction.deferReply();
        // Owner → authenticated (full access, incl. private repos). Non-owner →
        // unauthenticated, so only public repos resolve; Oscar's private repos
        // 404 because his PAT is never attached.
        const result = await githubCall({ method, endpoint, body, auth: isOwner }, buildInvocation());
        return await sendToolResult(result);
      }

      if (name === 'self_fix') {
        if (!isOwner) {
          return await interaction.reply({ content: '⛔ Owner only.', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply();
        const invocation = buildInvocation();
        const result = await selfFix({ instruction: interaction.options.getString('instruction', true) }, invocation);
        await sendToolResult(result);
        if (invocation.requestRestart) {
          console.log('[panda] /self_fix requested restart — exiting with code 42');
          setTimeout(() => process.exit(42), 1500);
        }
        return;
      }

      if (name === 'git_push') {
        if (!isOwner) {
          return await interaction.reply({ content: '⛔ Owner only.', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply();
        const result = await gitPush(
          { message: interaction.options.getString('message') ?? undefined },
          buildInvocation(),
        );
        return await sendToolResult(result);
      }

      // Music commands below
      if (!interaction.guild) {
        return await interaction.reply({ content: 'Music only works in a server.', flags: MessageFlags.Ephemeral });
      }
      if (!player) {
        return await interaction.reply({ content: '❌ The music player failed to initialize.', flags: MessageFlags.Ephemeral });
      }

      if (name === 'play') {
        const voiceChannel = interaction.member?.voice?.channel;
        if (!voiceChannel) {
          return await interaction.reply({ content: '🔇 Join a voice channel first.', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply();
        const r = await actions.playQuery(
          player,
          voiceChannel,
          interaction.channel,
          interaction.options.getString('query', true),
          interaction.user,
        );
        if (!r.ok) return await interaction.editReply(r.error);
        // Queued → show the "Added to Queue" card. Playing now → the playerStart
        // event posts the full Now Playing embed, so just ack the interaction.
        if (r.queued) return await interaction.editReply({ embeds: [addedEmbed(r.track, r.position)] });
        return await interaction.editReply(`▶️ Playing **${r.track.title}** 🎶`);
      }

      const guildId = interaction.guild.id;
      if (name === 'skip') return await interaction.reply(actions.skip(player, guildId));
      if (name === 'pause') return await interaction.reply(actions.pause(player, guildId));
      if (name === 'resume') return await interaction.reply(actions.resume(player, guildId));
      if (name === 'stop') return await interaction.reply(actions.stop(player, guildId));
      if (name === 'queue') {
        const q = player.nodes.get(guildId);
        if (!q?.currentTrack) return await interaction.reply('Nothing is playing.');
        return await interaction.reply({ embeds: [queueEmbed(q)] });
      }
    } catch (err) {
      // 10062 Unknown interaction / 40060 already acknowledged → the token is
      // dead (usually a stale interaction from a restart). Nothing to say back.
      if (err?.code === 10062 || err?.code === 40060) return;
      console.error('[panda] interaction failed:', err);
      const payload = { content: `⚠️ ${String(err.message || err).slice(0, 250)}` };
      try {
        if (interaction.deferred || interaction.replied) await interaction.followUp(payload);
        else await interaction.reply(payload);
      } catch {
        /* interaction already dead */
      }
    }
  };
}
