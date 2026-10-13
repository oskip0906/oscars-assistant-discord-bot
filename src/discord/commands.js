import { MessageFlags } from 'discord.js';
import { commandDefs } from './commandDefs.js';
import { buildMenuEmbeds } from './menu.js';
import { buildUsageEmbed } from './usage.js';
import { buildModelEmbed, switchModel, modelChoices } from './model.js';
import { chunkMessage } from './chunk.js';
import { suppressLinkEmbeds } from './messageHandler.js';
import { PRIVATE_MESSAGE } from '../privateMode.js';
import { updatePresence } from '../presence.js';
import * as actions from '../music/actions.js';
import { addedEmbed, queueEmbed } from '../music/embeds.js';
import { buildSearchQuery } from '../agent/research/searchQuery.js';
import { webSearch, webFetch, imageSearch, reverseImageSearch, videoSearch, newsSearch, wikiSearch } from '../agent/tools/search.js';
import { selfFix, parseApprovalButtonId } from '../agent/tools/source.js';
import { selfFixState } from '../selfFixState.js';
import { runResearch } from '../agent/research/pipeline.js';
import { renderReport } from '../agent/research/render.js';
import { redactSecrets } from '../config.js';
import { setRule } from '../agent/tools/rules.js';
import { UI_PREFIX, clickAsMessage, createPoll, sendCard } from '../agent/tools/ui.js';
import { saveNote, windowMessages, loadTree, openNote, getNote, relatedNotes, noteChoices, deleteNote, folderPath } from '../agent/notes.js';
import { NOTES_PREFIX, noteMessage, folderView, deleteNoteConfirm } from './notes.js';
import { addReminder, activeReminders, reminderChoices, deleteReminder, timezoneChoices, repeatText } from '../reminders.js';
import { remindersEmbed } from './reminders.js';
import { indexChannel, INDEX_OWNER_ID } from './indexChannel.js';
import { parseClearAmount, missingClearPermissions, clearChannel } from './clear.js';
import { STORAGE_PREFIX, cleanup, dismiss, SECTIONS, mb } from '../storage.js';

export { commandDefs };

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

// A folder of the notes browser: its first page through `send` (update or
// editReply), then every further page as a follow-up.
async function showFolder(interaction, tree, folderId, send) {
  const { rest, ...first } = folderView(tree, folderId);
  await interaction[send](first);
  for (const part of rest) await interaction.followUp(part);
}

export function createInteractionHandler({ client, config, player, privateMode, state = selfFixState, onMessage }) {
  return async (interaction) => {
    // A click on a button or menu Panda sent (send_card). Acknowledge now, since
    // Discord's 3-second deadline would pass during batching, then hand it to the
    // message handler as a message from whoever clicked.
    if ((interaction.isButton?.() || interaction.isStringSelectMenu?.()) && interaction.customId?.startsWith(UI_PREFIX)) {
      await interaction.deferUpdate().catch(() => {});
      if (interaction.channel && onMessage) await onMessage(clickAsMessage(interaction));
      return;
    }

    // Oscar's answer to a "storage is full" DM.
    if (interaction.isButton?.() && interaction.customId?.startsWith(STORAGE_PREFIX)) {
      const [, action, section] = interaction.customId.split(':');
      if (interaction.user.id !== config.ownerId || !SECTIONS[section]) {
        return await interaction.reply({ content: '⛔ Only Oscar can answer this.', flags: MessageFlags.Ephemeral }).catch(() => {});
      }
      const { label } = SECTIONS[section];
      if (action !== 'clean') {
        dismiss(section);
        return await answerApproval(interaction, `⏸️ Left **${label}** as it is. It stays full, and I'll ask again in an hour.`);
      }
      await answerApproval(interaction, `🧹 Deleting the oldest **${label}** entries…`);
      try {
        const { deleted, used } = await cleanup(config, section);
        await interaction.message?.edit(`✅ Deleted ${deleted} of the oldest **${label}** entries. It now holds ${mb(used)} of ${mb(SECTIONS[section].budget)}.`);
      } catch (err) {
        await interaction.message?.edit(`❌ Cleanup failed, nothing more was deleted: ${redactSecrets(err.message).slice(0, 200)}`).catch(() => {});
      }
      return;
    }

    // The notes browser (display_notes) and the delete confirmation (delete_note).
    if ((interaction.isButton?.() || interaction.isStringSelectMenu?.()) && interaction.customId?.startsWith(NOTES_PREFIX)) {
      if (privateMode?.isOn() && interaction.user.id !== config.ownerId) {
        return await interaction.reply({ content: PRIVATE_MESSAGE, flags: MessageFlags.Ephemeral }).catch(() => {});
      }
      try {
        const [, action, arg] = interaction.customId.split(':');
        if (action === 'keep') return await interaction.update({ content: '👍 Kept it.', components: [] });
        if (action === 'del') {
          const title = await deleteNote(config, Number(arg), interaction.user.id, interaction.user.id === config.ownerId);
          return await interaction.update({ content: title ? `🗑️ Deleted **${title}**.` : 'That note is gone, or it isn’t yours to delete.', components: [] });
        }
        if (action === 'up') return await showFolder(interaction, await loadTree(config), arg === 'root' ? null : Number(arg), 'update');
        if (action === 'nav') {
          const value = interaction.values?.[0] || '';
          const id = Number(value.slice(1));
          if (value.startsWith('f')) return await showFolder(interaction, await loadTree(config), id, 'update');
          const note = await getNote(config, id);
          if (!note) return await interaction.reply({ content: 'That note was deleted.', flags: MessageFlags.Ephemeral });
          const { folders } = await loadTree(config);
          const { embeds, rest, files } = noteMessage(note, folders, await relatedNotes(config, id));
          await interaction.reply({ embeds, files, allowedMentions: { parse: [] } });
          for (const part of rest) await interaction.followUp({ content: part, allowedMentions: { parse: [] } });
        }
      } catch (err) {
        console.error('[notes] interaction failed:', err.message);
        await interaction.reply({ content: `⚠️ ${redactSecrets(err.message).slice(0, 200)}`, flags: MessageFlags.Ephemeral }).catch(() => {});
      }
      return;
    }

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
      const focused = interaction.options.getFocused(true);
      const owner = interaction.user.id === config.ownerId;
      const short = (text) => (text.length > 100 ? `${text.slice(0, 99)}…` : text);
      try {
        let choices = [];
        if (interaction.commandName === 'set_model') {
          choices = owner ? await modelChoices(config, focused.value) : [];
        } else if (interaction.commandName === 'open_note') {
          choices = (await noteChoices(config, focused.value)).map((n) => ({ name: short(n.title), value: short(n.title) }));
        } else if (interaction.commandName === 'delete_note') {
          choices = (await noteChoices(config, focused.value, owner ? null : interaction.user.id)).map((n) => ({ name: short(n.title), value: String(n.id) }));
        } else if (interaction.commandName === 'delete_reminder') {
          choices = (await reminderChoices(config, focused.value, interaction.user.id, owner)).map((r) => ({
            name: short(`${r.name} — ${r.active ? `next ${new Date(r.next_at).toISOString().slice(0, 16).replace('T', ' ')} UTC` : 'done'}`),
            value: String(r.id),
          }));
        } else if (interaction.commandName === 'add_reminder' && focused.name === 'timezone') {
          choices = timezoneChoices(focused.value).map((tz) => ({ name: tz, value: tz }));
        }
        return await interaction.respond(choices).catch(() => {});
      } catch (err) {
        console.error('[panda] autocomplete failed:', err.message);
        return await interaction.respond([]).catch(() => {});
      }
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
    // to post progress into.
    const buildInvocation = () => ({
      config,
      client,
      isOwner: interaction.user.id === config.ownerId,
      // Some tools (self_fix) post progress via message.channel.send;
      // fall back to a no-op channel if the interaction has no cached channel.
      message: { channel: interaction.channel ?? { send: async () => {} } },
    });

    // Tools return plain strings that can exceed Discord's 2000-char cap and
    // may contain bare URLs. Chunk + suppress link embeds like the chat path.
    // A deferred interaction token dies 15 minutes in, and a slow tool can
    // outlast it — post the answer in the channel rather than dropping it.
    const sendToolResult = async (text) => {
      // An array means the caller already decided the message boundaries;
      // only split a part that is too long on its own.
      const parts = (Array.isArray(text) ? text : [text]).flatMap((piece) =>
        chunkMessage(suppressLinkEmbeds(redactSecrets(piece))),
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
    // `args` may be a function: it runs after the defer, so slow work (like
    // writing a search query) can't blow Discord's 3-second reply window.
    const runTool = async (fn, args) => {
      await interaction.deferReply();
      const result = await fn(typeof args === 'function' ? await args() : args, buildInvocation());
      await sendToolResult(result);
    };

    try {
      const name = interaction.commandName;

      // Private mode gates non-owner interactions too (it's a private
      // conversation with Oscar — nothing else goes through).
      const isOwner = interaction.user.id === config.ownerId;
      if (name === 'index_channel') {
        if (interaction.user.id !== INDEX_OWNER_ID) {
          return await interaction.reply({ content: '⛔ Only Oscar can use this', flags: MessageFlags.Ephemeral });
        }
        if (!interaction.channel?.messages) {
          return await interaction.reply({ content: 'I can only index a channel I can read.', flags: MessageFlags.Ephemeral });
        }
        await interaction.reply({ content: '📥 Indexing this channel’s history…', flags: MessageFlags.Ephemeral });
        const label = interaction.channel.name ? `#${interaction.channel.name}` : 'this channel';
        let lastEdit = 0;
        try {
          const done = await indexChannel(config, interaction.channel, {
            onProgress: async ({ fetched }) => {
              if (Date.now() - lastEdit < 5000) return;
              lastEdit = Date.now();
              await interaction.editReply(`📥 Indexing ${label}… ${fetched} messages read so far.`).catch(() => {});
            },
          });
          return await interaction.editReply(
            `✅ Indexed **${done.indexed}** messages from ${label}; **${done.skipped}** were already present or had no text.` +
              (done.capped ? ` Stopped at the ${done.fetched}-message safety cap; run it again to carry on from there.` : ''),
          );
        } catch (err) {
          return await interaction.editReply(`❌ Indexing ${label} failed: ${redactSecrets(err.message).slice(0, 200)}`);
        }
      }

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
        const saved = await privateMode.set(state === 'on');
        if (!saved.ok) {
          return await interaction.reply({
            content: `❌ ${saved.error} Private mode is still **${saved.on ? 'ON' : 'OFF'}**.`,
            flags: MessageFlags.Ephemeral,
          });
        }
        updatePresence(client, privateMode);
        return await interaction.reply({
          content:
            state === 'on'
              ? '🔒 Private mode **ON** — I’ll only respond to you now; everyone else gets turned away.'
              : '🔓 Private mode **OFF** — I’m back to talking with everyone.',
          flags: MessageFlags.Ephemeral,
        });
      }

      if (name === 'menu') {
        return await interaction.reply({ embeds: buildMenuEmbeds(client, config) });
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
        const result = await switchModel({
          model: interaction.options.getString('model', true),
          provider: interaction.options.getString('provider') ?? '',
          config,
        });
        return await interaction.editReply({ content: result.summary, allowedMentions: { parse: [] } });
      }

      if (name === 'clear') {
        if (!isOwner) {
          return await interaction.reply({ content: '⛔ Only Oscar can use this', flags: MessageFlags.Ephemeral });
        }
        const amount = parseClearAmount(interaction.options.getString('amount', true));
        if (amount.error) return await interaction.reply({ content: `⚠️ ${amount.error}`, flags: MessageFlags.Ephemeral });
        const missing = missingClearPermissions(interaction.channel);
        if (!interaction.channel?.messages || missing === null) {
          return await interaction.reply({ content: '🚫 I can’t clear messages here: I can only delete messages in a server channel.', flags: MessageFlags.Ephemeral });
        }
        if (missing.length) {
          return await interaction.reply({
            content: `🚫 I can’t clear messages here: I don’t have the ${missing.map((p) => `**${p}**`).join(', ')} permission${missing.length > 1 ? 's' : ''} in this channel.`,
            flags: MessageFlags.Ephemeral,
          });
        }
        const what = amount.all ? 'every message in this channel' : `the newest ${amount.count} message${amount.count > 1 ? 's' : ''}`;
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        let lastEdit = 0;
        try {
          const done = await clearChannel(interaction.channel, {
            limit: amount.all ? Infinity : amount.count,
            onProgress: async ({ deleted }) => {
              if (Date.now() - lastEdit < 5000) return;
              lastEdit = Date.now();
              await interaction.editReply(`🧹 Clearing ${what}… ${deleted} deleted so far.`).catch(() => {});
            },
          });
          return await interaction
            .editReply(
              `🧹 Deleted **${done.deleted}** message${done.deleted === 1 ? '' : 's'}.` +
                (done.failed ? ` **${done.failed}** couldn’t be deleted (Discord doesn’t allow it for some system messages).` : ''),
            )
            .catch(() => {});
        } catch (err) {
          const why = err?.code === 50013 ? 'I don’t have permission to delete messages here.' : redactSecrets(err.message).slice(0, 200);
          return await interaction.editReply(`🚫 I can’t clear messages here: ${why}`).catch(() => {});
        }
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
        return await sendToolResult(renderReport(report));
      }

      if (name === 'web_search') {
        return await runTool(webSearch, async () => ({
          query: await buildSearchQuery({ request: interaction.options.getString('query', true), kind: 'web', config }),
          count: undefined,
        }));
      }

      for (const [cmd, fn, kind] of [['video_search', videoSearch, 'video'], ['news_search', newsSearch, 'news'], ['wiki_search', wikiSearch, 'wiki']]) {
        if (name === cmd) {
          return await runTool(fn, async () => ({
            query: await buildSearchQuery({ request: interaction.options.getString('query', true), kind, config }),
            count: undefined,
          }));
        }
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
            query: await buildSearchQuery({ request: interaction.options.getString('query', true), kind: 'image', config }),
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

      if (name === 'reverse_image_search') {
        const image = interaction.options.getAttachment('image')?.url || interaction.options.getString('url');
        if (!image) return await interaction.reply({ content: 'Attach a picture or give its URL.', flags: MessageFlags.Ephemeral });
        return await runTool(reverseImageSearch, { image, count: undefined });
      }

      if (name === 'self_fix') {
        if (!isOwner) {
          return await interaction.reply({ content: '⛔ Owner only.', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply();
        const invocation = buildInvocation();
        await sendToolResult(selfFix({ instruction: interaction.options.getString('instruction', true) }, invocation));
        return;
      }

      // --- Notes and reminders (anyone) ---------------------------------

      if (name === 'save_note') {
        if (!interaction.channel?.messages) {
          return await interaction.reply({ content: 'I can only save a note from a channel I can read.', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply();
        const messages = await windowMessages(interaction.channel, undefined, interaction.options.getInteger('minutes'));
        const saved = await saveNote(config, { messages, authorId: interaction.user.id });
        if (saved.error) return await interaction.editReply(`⚠️ ${saved.error}`);
        return await interaction.editReply({
          content: `📝 Saved **${saved.note.title}** in 📁 ${saved.path.join(' / ')}\n> ${saved.note.description}\nOpen it with \`/open_note\`.`,
          allowedMentions: { parse: [] },
        });
      }

      if (name === 'display_notes') {
        await interaction.deferReply();
        return await showFolder(interaction, await loadTree(config), null, 'editReply');
      }

      if (name === 'open_note') {
        await interaction.deferReply();
        const note = await openNote(config, interaction.options.getString('title', true));
        if (!note) return await interaction.editReply('No note matches that. Browse them with `/display_notes`.');
        const { folders } = await loadTree(config);
        const { embeds, rest, files } = noteMessage(note, folders, await relatedNotes(config, note.id));
        await interaction.editReply({ embeds, files, allowedMentions: { parse: [] } });
        for (const part of rest) await interaction.followUp({ content: part, allowedMentions: { parse: [] } });
        return;
      }

      if (name === 'delete_note') {
        const raw = interaction.options.getString('note', true).trim();
        // Picked from the list it is an id; typed by hand it is a title.
        const note = /^\d+$/.test(raw) ? await getNote(config, Number(raw)) : await openNote(config, raw);
        if (!note || (note.author_id !== interaction.user.id && !isOwner)) {
          return await interaction.reply({ content: 'I can’t find a note of yours with that title.', flags: MessageFlags.Ephemeral });
        }
        const { folders } = await loadTree(config);
        const confirm = deleteNoteConfirm(note);
        confirm.content += `\n📁 ${folderPath(folders, note.folder_id).join(' / ')}`;
        return await interaction.reply({ ...confirm, flags: MessageFlags.Ephemeral });
      }

      if (name === 'add_reminder') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const added = await addReminder(config, {
          userId: interaction.user.id,
          channelId: interaction.guildId ? interaction.channelId : null,
          name: interaction.options.getString('name', true),
          repeat: interaction.options.getString('repeat', true),
          when: interaction.options.getString('when', true),
          timezone: interaction.options.getString('timezone'),
        });
        if (added.error) return await interaction.editReply(`⚠️ ${added.error}`);
        const at = Math.floor(new Date(added.next_at).getTime() / 1000);
        return await interaction.editReply(
          `⏰ Got it: **${added.name}**, ${repeatText(added)}. ${interaction.guildId ? `I'll ping you here` : `I'll DM you`} first <t:${at}:F> (<t:${at}:R>).`,
        );
      }

      if (name === 'show_reminders') {
        await interaction.deferReply();
        return await interaction.editReply({ embeds: [remindersEmbed(await activeReminders(config))], allowedMentions: { parse: [] } });
      }

      if (name === 'delete_reminder') {
        const raw = interaction.options.getString('reminder', true).trim();
        if (!/^\d+$/.test(raw)) {
          return await interaction.reply({ content: 'Pick the reminder from the list as you type.', flags: MessageFlags.Ephemeral });
        }
        const removed = await deleteReminder(config, Number(raw), interaction.user.id, isOwner);
        return await interaction.reply({
          content: removed ? `🗑️ Deleted the reminder **${removed}**.` : 'That reminder is gone, or it isn’t yours to delete.',
          flags: MessageFlags.Ephemeral,
          allowedMentions: { parse: [] },
        });
      }

      if (name === 'set_rule') {
        if (!isOwner) {
          return await interaction.reply({ content: '⛔ Owner only.', flags: MessageFlags.Ephemeral });
        }
        return await runTool(setRule, { instruction: interaction.options.getString('instruction', true) });
      }

      if (name === 'create_poll') {
        await interaction.deferReply();
        const question = interaction.options.getString('question', true);
        const answersRaw = interaction.options.getString('answers', true);
        const answers = answersRaw.split('|').map((s) => s.trim()).filter(Boolean);
        const hours = interaction.options.getInteger('hours');
        const multiple = interaction.options.getBoolean('multiple');
        const args = { question, answers };
        if (hours != null) args.hours = hours;
        if (multiple != null) args.multiple = multiple;
        const result = await createPoll(args, buildInvocation());
        await sendToolResult(result);
        return;
      }

      if (name === 'create_card') {
        await interaction.deferReply();
        const title = interaction.options.getString('title', true);
        const description = interaction.options.getString('description');
        const color = interaction.options.getString('color');
        const url = interaction.options.getString('url');
        const image = interaction.options.getString('image');
        const thumbnail = interaction.options.getString('thumbnail');
        const footer = interaction.options.getString('footer');
        const fieldsRaw = interaction.options.getString('fields');
        const buttonsRaw = interaction.options.getString('buttons');
        const menuRaw = interaction.options.getString('menu');

        const args = { title };
        if (description) args.description = description;
        if (color) args.color = color;
        if (url) args.url = url;
        if (image) args.image = image;
        if (thumbnail) args.thumbnail = thumbnail;
        if (footer) args.footer = footer;
        if (fieldsRaw) {
          args.fields = fieldsRaw.split('|').map((s) => {
            const [name, ...rest] = s.split(':');
            return { name: (name || '').trim(), value: rest.join(':').trim() };
          }).filter((f) => f.name && f.value);
        }
        if (buttonsRaw) {
          args.buttons = buttonsRaw.split('|').map((s) => ({ label: s.trim() })).filter((b) => b.label);
        }
        if (menuRaw) {
          args.menu = { options: menuRaw.split('|').map((s) => s.trim()).filter(Boolean) };
        }

        const result = await sendCard(args, buildInvocation());
        await sendToolResult(result);
        return;
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
      const payload = { content: `⚠️ ${redactSecrets(err.message || err).slice(0, 250)}` };
      try {
        if (interaction.deferred || interaction.replied) await interaction.followUp(payload);
        else await interaction.reply(payload);
      } catch {
        /* interaction already dead */
      }
    }
  };
}
