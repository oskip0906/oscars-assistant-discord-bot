import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { buildMenuEmbed } from './menu.js';
import { buildUsageEmbed } from './usage.js';
import { buildModelEmbed, switchModel, modelChoices, writeEnvModel } from './model.js';
import { chunkMessage } from './chunk.js';
import { suppressLinkEmbeds } from './messageHandler.js';
import { PRIVATE_MESSAGE } from '../privateMode.js';
import * as actions from '../music/actions.js';
import { addedEmbed, queueEmbed } from '../music/embeds.js';
import { webSearch, webFetch, imageSearch } from '../agent/tools/search.js';
import { vaultFetch, githubCall, createPr, writableRepoChoices } from '../agent/tools/github.js';
import { selfFix, parseApprovalButtonId } from '../agent/tools/source.js';
import { selfFixState } from '../selfFixState.js';
import { setDevelopmentModel } from '../configManager.js';

export const commandDefs = [
  new SlashCommandBuilder().setName('menu').setDescription('Show everything Panda can do'),
  new SlashCommandBuilder().setName('usage').setDescription('Show how much money Panda has spent'),
  new SlashCommandBuilder().setName('model').setDescription('Show which AI model Panda is running on'),
  new SlashCommandBuilder()
    .setName('switch_model')
    .setDescription('Switch Panda to another OpenRouter model and restart (owner only)')
    .addStringOption((o) =>
      o
        .setName('model')
        .setDescription('OpenRouter model id — start typing to search')
        .setRequired(true)
        .setAutocomplete(true),
    ),
  new SlashCommandBuilder()
    .setName('set_dev_model')
    .setDescription('Set the OpenRouter model used for development tasks like self_fix (owner only)')
    .addStringOption((o) =>
      o.setName('model').setDescription('OpenRouter model id — start typing to search').setRequired(true).setAutocomplete(true),
    ),
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
    .setName('run_dev')
    .setDescription('Run an approved remote development task and open a PR (owner only)')
    .addStringOption((o) => o.setName('instruction').setDescription('What to build, change, or fix').setRequired(true))
    .addStringOption((o) =>
      o
        .setName('repo')
        .setDescription('Target owner/repo; defaults to Panda’s own repository'),
    ),
  new SlashCommandBuilder()
    .setName('toggle_response')
    .setDescription('Toggle whether Panda responds to a given user id (owner only)')
    .addStringOption((o) =>
      o.setName('user_id').setDescription('The Discord user id to toggle responses for').setRequired(true),
    ),
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

// Answering a button click has a 3-second budget, after which the interaction
// token is dead and every reply on it throws 10062 "Unknown interaction". That
// throw used to escape the handler and surface as a client error while the click
// itself was perfectly good, so fall back to editing the message with the bot
// token, which has neither the 3-second budget nor the 15-minute expiry.
async function answerApproval(interaction, content) {
  try {
    await interaction.update({ content, components: [] });
  } catch (err) {
    if (err?.code !== 10062 && err?.code !== 40060) {
      console.error('[panda] could not answer a development approval:', err.message);
    }
    await interaction.message?.edit({ content, components: [] }).catch(() => {});
  }
}

export function createInteractionHandler({ client, config, contextStore, player, privateMode, toggledResponses, state = selfFixState }) {
  return async (interaction) => {
    if (interaction.isButton?.()) {
      const approval = parseApprovalButtonId(interaction.customId);
      if (!approval) return;
      if (interaction.user.id !== config.ownerId) {
        return await interaction
          .reply({ content: '⛔ Only Oscar can approve development work.', flags: MessageFlags.Ephemeral })
          .catch(() => {});
      }
      if (!state.matchesPendingApproval(interaction.user.id, approval.id)) {
        // Say which of the two it is. "Expired" was neither true nor useful:
        // approvals have no deadline, and the usual cause is a card left over
        // from before a restart, which no amount of waiting will revive.
        const why = approval.fromThisBoot
          ? '🚫 This request was already answered, or a newer one took its place. Send it again for a fresh card.'
          : '🔁 This card is from before my last restart, so the request behind it is gone. Send it again and I will post a fresh one.';
        await interaction.reply({ content: why, flags: MessageFlags.Ephemeral }).catch(() => {});
        // Retire the dead card so it cannot be clicked a second time.
        await interaction.message?.edit({ components: [] }).catch(() => {});
        return;
      }
      // Answer before consuming. submitApproval resolves the promise the
      // development run is waiting on, and that run resumes — issuing its own
      // OpenRouter and GitHub calls — ahead of this reply reaching Discord.
      await answerApproval(
        interaction,
        approval.approved ? '✅ Development task approved. Starting the remote sandbox…' : '🚫 Development task cancelled.',
      );
      if (!state.submitApproval(interaction.user.id, approval.id, approval.approved)) {
        // A newer request superseded this one in the moment Discord was answered.
        await interaction.message
          ?.edit({ content: '🚫 A newer request took over before this one could start. Nothing ran.', components: [] })
          .catch(() => {});
      }
      return;
    }

    // Autocomplete is a separate interaction type with a 3s budget and no
    // deferral — answer it from the cached catalog and return.
    if (interaction.isAutocomplete()) {
      if (interaction.user.id !== config.ownerId) return await interaction.respond([]).catch(() => {});
      const focused = interaction.options.getFocused(true);
      if (interaction.commandName === 'switch_model' || interaction.commandName === 'set_dev_model') {
        const choices = await modelChoices(config, focused.value);
        return await interaction.respond(choices).catch(() => {});
      }
      if (interaction.commandName !== 'run_dev' || focused.name !== 'repo') return await interaction.respond([]).catch(() => {});
      const choices = await writableRepoChoices(config, focused.value);
      return await interaction.respond(choices).catch(() => {});
    }

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
    // A deferred interaction token dies 15 minutes in. /self_fix and /run_dev now
    // wait on Oscar's approval button with no deadline, and the sandbox run takes
    // minutes more, so the answer routinely arrives after the token is gone —
    // post it in the channel rather than dropping it.
    const sendToolResult = async (text) => {
      const parts = chunkMessage(suppressLinkEmbeds(String(text)));
      const channel = interaction.channel;
      let live = true;
      for (const [index, part] of parts.entries()) {
        const payload = { content: part, allowedMentions: { parse: [] } };
        if (live) {
          try {
            await (index === 0 ? interaction.editReply(payload) : interaction.followUp(payload));
            continue;
          } catch (err) {
            if (err?.code !== 10062 && err?.code !== 50027 && err?.code !== 10015) throw err;
            live = false;
          }
        }
        await channel?.send(payload).catch(() => {});
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

      if (name === 'toggle_response') {
        if (!isOwner) {
          return await interaction.reply({ content: '⛔ Owner only.', flags: MessageFlags.Ephemeral });
        }
        const userId = interaction.options.getString('user_id', true).trim();
        if (!/^\d{5,25}$/.test(userId)) {
          return await interaction.reply({
            content: '⚠️ `user_id` must be a numeric Discord user id.',
            flags: MessageFlags.Ephemeral,
          });
        }
        const nowIgnored = toggledResponses.toggle(userId);
        return await interaction.reply({
          content: nowIgnored
            ? `🔇 I’ll now **ignore** messages from <@${userId}> (id \`${userId}\`).`
            : `🔊 I’ll **respond** to <@${userId}> (id \`${userId}\`) again.`,
          flags: MessageFlags.Ephemeral,
          allowedMentions: { parse: [] },
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

      if (name === 'switch_model') {
        if (!isOwner) {
          return await interaction.reply({ content: '⛔ Owner only.', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply();
        const result = await switchModel({ model: interaction.options.getString('model', true), config });
        await interaction.editReply({ content: result.summary, allowedMentions: { parse: [] } });
        if (result.restart) {
          // Same restart path as self_fix: exit 42, and the supervisor pulls and
          // reboots — which is what actually loads the new OPENROUTER_MODEL.
          console.log('[panda] /switch_model requested restart — exiting with code 42');
          setTimeout(() => process.exit(42), 1500);
        }
        return;
      }

      if (name === 'set_dev_model') {
        if (!isOwner) {
          return await interaction.reply({ content: '⛔ Owner only.', flags: MessageFlags.Ephemeral });
        }
        const model = interaction.options.getString('model', true).trim();
        if (!model) {
          return await interaction.reply({
            content: '⚠️ Provide a non-empty OpenRouter model id.',
            flags: MessageFlags.Ephemeral,
          });
        }
        const applied = setDevelopmentModel(model);
        // Persisted as well as applied: self_fix restarts the bot, so a choice
        // that lived only in memory was lost exactly when the next development
        // run needed it, silently falling back to the default.
        const written = writeEnvModel(config, applied, 'OPENROUTER_DEV_MODEL');
        return await interaction.reply({
          content: [
            `🛠️ Development-task model set to \`${applied}\`. self_fix and /run_dev use it from now on.`,
            written.ok ? '' : `⚠️ It is live, but I could not save it — a restart will lose it. ${written.error}`,
          ]
            .filter(Boolean)
            .join('\n'),
          flags: MessageFlags.Ephemeral,
          allowedMentions: { parse: [] },
        });
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
        // Every GitHub surface is Oscar-only, reads included: this command runs
        // on his PAT, and even a GET can pull back private-repo data.
        if (!isOwner) {
          return await interaction.reply({ content: '⛔ Owner only.', flags: MessageFlags.Ephemeral });
        }
        // `endpoint` and `method` are no longer user-facing. Default to the most
        // common read action (list the caller's repos). A body-only invocation
        // still resolves to a safe GET.
        const endpoint = '/user/repos';
        const method = 'GET';
        const bodyRaw = interaction.options.getString('body');

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
        const result = await githubCall({ method, endpoint, body, auth: true }, buildInvocation());
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

      if (name === 'run_dev') {
        if (!isOwner) {
          return await interaction.reply({ content: '⛔ Owner only.', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply();
        const repo = interaction.options.getString('repo') || config.developmentSandboxRepo;
        const result = await createPr(
          { repo, instruction: interaction.options.getString('instruction', true) },
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
