import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, StringSelectMenuBuilder } from 'discord.js';
import { randomEmbedColor } from './colors.js';
import { chunkMessage } from './chunk.js';
import { childrenOf, folderPath } from '../agent/notes.js';

export const NOTES_PREFIX = 'notes:';
const BODY_IN_EMBED = 3500;
const TREE_CHARS = 3800;
const MENU_SIZE = 25;
// shortcut: past 4 menus (100 entries in one folder) the rest are listed but not pickable; page the menus if a folder grows that big.
const MENUS = 4;

const unix = (date) => Math.floor(new Date(date).getTime() / 1000);
const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

// The note as an embed, plus any body that didn't fit as follow-up messages.
export function noteMessage(note, folders, related = []) {
  const path = folderPath(folders, note.folder_id).join(' / ') || 'Unsorted';
  const head = `*${note.description}*\n📁 ${path} · by <@${note.author_id}> · <t:${unix(note.created_at)}:D>\n\n`;
  const [first, ...rest] = note.body.length > BODY_IN_EMBED ? chunkMessage(note.body, BODY_IN_EMBED) : [note.body];
  const embed = new EmbedBuilder().setColor(randomEmbedColor()).setTitle(clip(`📄 ${note.title}`, 256)).setDescription(head + first);
  if (related.length) embed.addFields({ name: '🔗 Related', value: clip(related.map((r) => `• ${r.title}`).join('\n'), 1024) });
  if (rest.length) embed.setFooter({ text: `Continued in ${rest.length} more message(s)` });
  return { embeds: [embed], rest };
}

// One folder (null = the top) as a browsable embed: the whole subtree, split
// into pages when it is too long for one embed. The first page carries the
// menus, which open a folder or a note; the others come back in `rest`, one
// message each, so every note is listed.
export function folderView({ folders, notes }, folderId = null) {
  const kids = childrenOf(folders);
  const notesIn = new Map();
  for (const n of notes) {
    if (!notesIn.has(n.folder_id)) notesIn.set(n.folder_id, []);
    notesIn.get(n.folder_id).push(n);
  }
  const count = (id) => (notesIn.get(id)?.length || 0) + (kids.get(id) || []).reduce((sum, f) => sum + count(f.id), 0);

  const lines = [];
  const walk = (id, depth) => {
    for (const f of kids.get(id) || []) {
      lines.push(`${' '.repeat(depth)}📁 **${f.name}** (${count(f.id)})`);
      walk(f.id, depth + 1);
    }
    for (const n of notesIn.get(id) || []) lines.push(`${' '.repeat(depth)}📄 ${n.title} — ${n.description}`);
  };
  walk(folderId, 0);
  const pages = lines.length ? chunkMessage(lines.join('\n'), TREE_CHARS) : ['No notes yet — save one with `/save_note`.'];

  const title = clip(folderId === null ? '📚 Notes' : `📁 ${folderPath(folders, folderId).join(' / ')}`, 256);
  const color = randomEmbedColor();
  const summary = `${notes.length} note(s) in ${folders.length} folder(s)`;
  const page = (text, i) =>
    new EmbedBuilder()
      .setColor(color)
      .setTitle(i === 0 ? title : clip(`${title} (continued)`, 256))
      .setDescription(text)
      .setFooter({ text: `${summary}${pages.length > 1 ? ` • page ${i + 1}/${pages.length}` : ''}${i === 0 ? ' • pick a folder or note below' : ''}` });

  // Discord caps a menu at 25 options and a message at 5 rows, so the entries
  // are spread over up to MENUS menus, leaving a row for the Up button.
  const options = [
    ...(kids.get(folderId) || []).map((f) => ({ label: clip(`📁 ${f.name}`, 100), value: `f${f.id}`, ...(f.description && { description: clip(f.description, 100) }) })),
    ...(notesIn.get(folderId) || []).map((n) => ({ label: clip(`📄 ${n.title}`, 100), value: `n${n.id}`, ...(n.description && { description: clip(n.description, 100) }) })),
  ];
  const components = [];
  for (let i = 0; i < options.length && components.length < MENUS; i += MENU_SIZE) {
    const slice = options.slice(i, i + MENU_SIZE);
    const menus = Math.min(MENUS, Math.ceil(options.length / MENU_SIZE));
    components.push(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`${NOTES_PREFIX}nav${components.length ? `:${components.length}` : ''}`)
          .setPlaceholder(menus > 1 ? `Open a folder or note (${i + 1}–${i + slice.length})` : 'Open a folder or note')
          .addOptions(slice),
      ),
    );
  }
  if (folderId !== null) {
    const parent = folders.find((f) => f.id === folderId)?.parent_id ?? null;
    components.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`${NOTES_PREFIX}up:${parent ?? 'root'}`).setLabel('⬆ Up').setStyle(ButtonStyle.Secondary),
      ),
    );
  }
  return { embeds: [page(pages[0], 0)], components, rest: pages.slice(1).map((text, i) => ({ embeds: [page(text, i + 1)] })) };
}

export function deleteNoteConfirm(note) {
  return {
    content: `Delete the note **${note.title}**? This can't be undone.`,
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`${NOTES_PREFIX}del:${note.id}`).setLabel('Delete').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`${NOTES_PREFIX}keep`).setLabel('Keep it').setStyle(ButtonStyle.Secondary),
      ),
    ],
  };
}
