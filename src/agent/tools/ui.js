import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, StringSelectMenuBuilder } from 'discord.js';
import { randomEmbedColor } from '../../discord/colors.js';
import { redactSecrets } from '../../config.js';

// Every clickable component Panda sends carries a custom id starting with this.
// A click comes back as a message from whoever clicked (clickAsMessage) and is
// answered like any other turn, so no button needs a handler of its own.
export const UI_PREFIX = 'ui:';

export const defs = [
  {
    type: 'function',
    function: {
      name: 'create_poll',
      description:
        'Post a native Discord poll in this channel: a question and 2 to 10 answers people vote on, and Discord counts the votes. Use it when someone wants a vote, or a group has to pick between options.',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'The question, up to 300 characters.' },
          answers: { type: 'array', items: { type: 'string' }, description: '2 to 10 answers, up to 55 characters each.' },
          hours: { type: 'integer', description: 'How long voting stays open, 1 to 768 hours (default 24).' },
          multiple: { type: 'boolean', description: 'Let people pick more than one answer (default false).' },
        },
        required: ['question', 'answers'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_card',
      description:
        'Post an embed card in this channel: a colored box with a title, text, fields and an image, with optional buttons or a dropdown under it. Use it when structure helps: a summary, a comparison, options to choose from, a set of links. A button with a url opens that link. A button without one, and the dropdown, are clickable: a click comes back to you as a message from whoever clicked, and you answer it.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Up to 256 characters.' },
          description: { type: 'string', description: 'Main text in Discord markdown, up to 4096 characters.' },
          color: { type: 'string', description: 'Hex color such as #5865F2 (optional).' },
          url: { type: 'string', description: 'Link for the title (optional).' },
          fields: {
            type: 'array',
            description: 'Up to 25 name/value pairs; inline ones sit side by side.',
            items: {
              type: 'object',
              properties: { name: { type: 'string' }, value: { type: 'string' }, inline: { type: 'boolean' } },
              required: ['name', 'value'],
            },
          },
          image: { type: 'string', description: 'Image URL shown large (optional).' },
          thumbnail: { type: 'string', description: 'Image URL shown small in the corner (optional).' },
          footer: { type: 'string', description: 'Small text at the bottom (optional).' },
          buttons: {
            type: 'array',
            description: 'Up to 5 buttons. Give a url for a link button; leave it out for a clickable one.',
            items: {
              type: 'object',
              properties: { label: { type: 'string', description: 'Up to 80 characters.' }, url: { type: 'string' } },
              required: ['label'],
            },
          },
          menu: {
            type: 'object',
            description: 'A clickable dropdown of choices (optional).',
            properties: {
              placeholder: { type: 'string' },
              options: { type: 'array', items: { type: 'string' }, description: '2 to 25 choices, up to 100 characters each.' },
            },
            required: ['options'],
          },
        },
      },
    },
  },
];

const isHttp = (url) => /^https?:\/\/\S+$/i.test(String(url ?? ''));
const texts = (list) => (Array.isArray(list) ? list : []).map((t) => String(t ?? '').trim()).filter(Boolean);

// Sent from the tool, so it skips the reply path: scrub it the same way.
const send = (channel, payload) => channel.send(JSON.parse(redactSecrets(JSON.stringify(payload))));

// Neither tool throws: Discord's own validation errors go back to the model to fix.
export async function createPoll({ question = '', answers = [], hours = 24, multiple = false } = {}, invocation) {
  const channel = invocation.message?.channel;
  if (!channel?.send) return 'Polls only work in chat.';
  const choices = texts(answers);
  if (!String(question).trim() || choices.length < 2 || choices.length > 10) return 'A poll needs a question and 2 to 10 answers.';
  try {
    await send(channel, {
      poll: {
        question: { text: String(question).trim() },
        answers: choices.map((text) => ({ text })),
        duration: Math.min(768, Math.max(1, Math.round(Number(hours)) || 24)),
        allowMultiselect: Boolean(multiple),
      },
    });
    invocation.posted = true;
    return 'Poll posted; Discord counts the votes. Only add text if it says something the poll does not.';
  } catch (err) {
    return `Discord rejected the poll: ${String(err.message || err).slice(0, 200)}`;
  }
}

export async function sendCard(args = {}, invocation) {
  const channel = invocation.message?.channel;
  if (!channel?.send) return 'Cards only work in chat.';
  const fields = Array.isArray(args.fields) ? args.fields : [];
  if (!args.title && !args.description && !fields.length) return 'A card needs a title, a description or fields.';
  const buttons = (Array.isArray(args.buttons) ? args.buttons : []).filter((b) => String(b?.label ?? '').trim());
  if (buttons.length > 5) return 'A card takes at most 5 buttons.';
  const badLink = buttons.find((b) => b.url && !isHttp(b.url));
  if (badLink) return `Button "${badLink.label}" needs an http(s) url, or no url to make it clickable.`;
  const choices = args.menu ? texts(args.menu.options) : [];
  if (args.menu && (choices.length < 2 || choices.length > 25)) return 'A dropdown needs 2 to 25 choices.';

  try {
    const embed = new EmbedBuilder().setColor(args.color || randomEmbedColor());
    if (args.title) embed.setTitle(String(args.title));
    if (args.description) embed.setDescription(String(args.description));
    if (isHttp(args.url)) embed.setURL(args.url);
    if (fields.length) embed.addFields(fields.map((f) => ({ name: String(f.name), value: String(f.value), inline: Boolean(f.inline) })));
    if (isHttp(args.image)) embed.setImage(args.image);
    if (isHttp(args.thumbnail)) embed.setThumbnail(args.thumbnail);
    if (args.footer) embed.setFooter({ text: String(args.footer) });

    const rows = [];
    if (buttons.length) {
      rows.push(
        new ActionRowBuilder().addComponents(
          buttons.map((b, i) => {
            const button = new ButtonBuilder().setLabel(String(b.label).trim().slice(0, 80));
            return b.url ? button.setStyle(ButtonStyle.Link).setURL(b.url) : button.setStyle(ButtonStyle.Secondary).setCustomId(`${UI_PREFIX}b${i}`);
          }),
        ),
      );
    }
    if (choices.length) {
      const menu = new StringSelectMenuBuilder()
        .setCustomId(`${UI_PREFIX}menu`)
        .setPlaceholder(String(args.menu.placeholder || 'Pick one').slice(0, 150))
        .addOptions(choices.map((label, i) => ({ label: label.slice(0, 100), value: String(i) })));
      rows.push(new ActionRowBuilder().addComponents(menu));
    }

    await send(channel, { embeds: [embed.toJSON()], components: rows.map((r) => r.toJSON()), allowedMentions: { parse: [] } });
    invocation.posted = true;
    const clickable = buttons.some((b) => !b.url) || choices.length;
    return `Card posted.${clickable ? ' A click will come back to you as a message from whoever clicked.' : ''} Only add text if it says something the card does not.`;
  } catch (err) {
    return `Discord rejected the card: ${String(err.message || err).slice(0, 200)}`;
  }
}

// A click on one of Panda's buttons or menus, shaped as a message from whoever
// clicked. It replies to the card, so the model sees what was clicked on, and it
// goes through the message handler like typed text: same batching, Jev, owner
// checks and private mode. Replies go out as follow-ups to the click.
export function clickAsMessage(interaction) {
  const card = interaction.message;
  const picked = interaction.isStringSelectMenu?.()
    ? interaction.values.map((v) => interaction.component?.options?.find((o) => o.value === v)?.label ?? v).join(', ')
    : (interaction.component?.label ?? interaction.customId);
  return {
    id: interaction.id,
    channelId: interaction.channelId,
    channel: interaction.channel,
    guild: interaction.guild,
    guildId: interaction.guildId,
    member: interaction.member,
    author: interaction.user,
    content: `[clicked "${picked}"]`,
    createdAt: new Date(interaction.createdTimestamp),
    mentions: { users: new Map() },
    attachments: new Map(),
    embeds: [],
    reference: { messageId: card.id },
    fetchReference: async () => card,
    react: (emoji) => card.react(emoji),
    // The card's own reactions, so a click never adds a second one from Panda (reactions.js).
    reactions: card.reactions,
    reply: (payload) => interaction.followUp(payload),
  };
}
