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
import { clearPersonaCache } from '../agent/systemPrompt.js';
import { runResearch } from '../agent/research/pipeline.js';
import { renderMessages } from '../agent/research/render.js';
import fs from 'node:fs';
import path from 'node:path';

export const commandDefs = [
  new SlashCommandBuilder().setName('menu').setDescription('Show everything Panda can do'),
  new SlashCommandBuilder().setName('usage').setDescription('Show how much money Panda has spent'),
  new SlashCommandBuilder().setName('model').setDescription('Show which AI model Panda is running on'),
  new SlashCommandBuilder()
    .setName('set_model')
    .setDescription('Set the OpenRouter model Panda runs on and restart (owner only)')
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
    .addStringOption((o) => o.setName('query').setDescription('What to search for').setRequired(true)),
  new SlashCommandBuilder()
    .setName('web_fetch')
    .setDescription('Fetch and read the full content of a web page')
    .addStringOption((o) => o.setName('url').setDescription('Full URL (http:// or https://)').setRequired(true)),
  new SlashCommandBuilder()
    .setName('image_search')
    .setDescription('Search for images')
    .addStringOption((o) => o.setName('query').setDescription('What to find pictures of').setRequired(true)),
  new SlashCommandBuilder()
    .setName('vault_fetch')
    .setDescription("Read Oscar's knowledge vault")
    .addStringOption((o) => o.setName('query').setDescription('What to look for in the vault')),
  new SlashCommandBuilder()
    .setName('research')
    .setDescription('Deep research: plan, crawl, verify, and report with sources')
    .addStringOption((o) => o.setName('query').setDescription('What to research').setRequired(true))
    .addStringOption((o) =>
      o
        .setName('depth')
        .setDescription('How hard to dig (default: normal)')
        .addChoices(
          { name: 'quick', value: 'quick' },
          { name: 'normal', value: 'normal' },
          { name: 'deep', value: 'deep' },
        ),
    ),
  new SlashCommandBuilder()
    .setName('github')
    .setDescription('Call the GitHub API (writes/private repos are owner only)')
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
  new SlashCommandBuilder()
    .setName('set_rule')
    .setDescription('Set a rule that Panda always follows — writes to instructions.md (owner only)')
    .addStringOption((o) =>
      o.setName('rule').setDescription('The rule text (can be any instruction you want Panda to obey)').setRequired(true),
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

export function createInteractionHandler({ client, config, contextStore, player, privateMode, state = selfFixState }) {
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
      if (interaction.commandName === 'set_model' || interaction.commandName === 'set_dev_model') {
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
      // An array means the caller already decided the message boundaries
      // (research sends one message per section); only split a part that is
      // too long on its own.
      const parts = (Array.isArray(text) ? text : [text]).flatMap((piece) =>
        chunkMessage(suppressLinkEmbeds(String(piece))),
      );
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

      if (name === 'set_model') {
        if (!isOwner) {
          return await interaction.reply({ content: '⛔ Owner only.', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply();
        const result = await switchModel({ model: interaction.options.getString('model', true), config });
        await interaction.editReply({ content: result.summary, allowedMentions: { parse: [] } });
        if (result.restart) {
          console.log('[panda] /set_model requested restart — exiting with code 42');
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

      if (name === 'research') {
        await interaction.deferReply();
        const depth = interaction.options.getString('depth') || 'normal';

        // A deep run is minutes long. Editing the deferred reply as each stage
        // lands is the difference between "working" and "hung" — throttled,
        // because Discord rate-limits edits far below the rate stages finish.
        let lastEdit = 0;
        const onProgress = (text) => {
          const now = Date.now();
          if (now - lastEdit < 2000) return;
          lastEdit = now;
          interaction.editReply({ content: `🔬 ${text}` }).catch(() => {});
        };

        const report = await runResearch({
          query: interaction.options.getString('query', true),
          depth,
          config,
          onProgress,
        });
        return await sendToolResult(renderMessages(report));
      }

      if (name === 'web_search') {
        return await runTool(webSearch, {
          query: interaction.options.getString('query', true),
          count: undefined,
        });
      }

      if (name === 'web_fetch') {
        return await runTool(webFetch, {
          url: interaction.options.getString('url', true),
          max_chars: undefined,
        });
      }

      if (name === 'image_search') {
        await interaction.deferReply();
        const result = await imageSearch(
          {
            query: interaction.options.getString('query', true),
            count: undefined,
          },
          buildInvocation(),
        );
        // imageSearch returns { embeds, text } — send the embeds directly
        // like /menu does, falling back to the text representation.
        if (result && typeof result === 'object' && result.embeds?.length) {
          await interaction.editReply({ embeds: result.embeds });
        } else {
          await sendToolResult(result?.text ?? result);
        }
        return;
      }

      if (name === 'vault_fetch') {
        return await runTool(vaultFetch, {
          path: undefined,
          query: interaction.options.getString('query') ?? undefined,
        });
      }

      if (name === 'github') {
        if (!isOwner) {
          return await interaction.reply({ content: '⛔ Owner only.', flags: MessageFlags.Ephemeral });
        }
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

      // --- set_rule (owner-only, writes instructions.md) ---------------
      if (name === 'set_rule') {
        if (!isOwner) {
          return await interaction.reply({ content: '⛔ Owner only.', flags: MessageFlags.Ephemeral });
        }
        const ruleText = interaction.options.getString('rule', true).trim();
        if (!ruleText) {
          return await interaction.reply({ content: '⚠️ Provide a rule to set.', flags: MessageFlags.Ephemeral });
        }
        try {
          const filePath = path.join(config.contextFilesDir, 'instructions.md');
          fs.mkdirSync(path.dirname(filePath), { recursive: true });
          fs.writeFileSync(filePath, ruleText);
          // Clear the persona cache so the new rule takes effect in the next reply.
          clearPersonaCache();
        } catch (err) {
          return await interaction.reply({
            content: `⚠️ Could not write instructions.md: ${err.message}`,
            flags: MessageFlags.Ephemeral,
          });
        }
        return await interaction.reply({
          content: `✅ Rule set. Panda will now follow this rule at all times:\n>>> ${ruleText}`,
          flags: MessageFlags.Ephemeral,
        });
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
