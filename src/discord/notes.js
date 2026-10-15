import { ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, StringSelectMenuBuilder } from 'discord.js';
import { randomEmbedColor } from './colors.js';
import { chunkMessage } from './chunk.js';
import { folderPath } from '../agent/notes.js';

export const NOTES_PREFIX = 'notes:';
const BODY_IN_EMBED = 3500;
const TREE_CHARS = 3800;
const MENU_SIZE = 25;
// shortcut: past 4 menus (100 entries in one folder) the rest are listed but not pickable; page the menus if a folder grows that big.
const MENUS = 4;

const unix = (date) => Math.floor(new Date(date).getTime() / 1000);
const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

// A safe attachment name: no folders, only plain characters, and an extension
// (.md when it has none). Falls back to the note's title.
export function fileNameFor(name, title = 'note') {
  const clean = (text) =>
    String(text ?? '')
      .split(/[\\/]/)
      .pop()
      .replace(/\s+/g, '_')
      .replace(/[^\w.-]/g, '')
      .replace(/^[.-]+/, '')
      .slice(0, 100);
  const picked = clean(name) || clean(title) || 'note';
  return /\.[a-z0-9]{1,10}$/i.test(picked) ? picked : `${picked}.md`;
}

// The note's text as a file to attach: its own file name, or `name`, or one made from its title.
export function noteFile(note, name = null) {
  return new AttachmentBuilder(Buffer.from(note.body, 'utf8'), { name: fileNameFor(name || note.file_name, note.title) });
}

// The note as an embed, plus any body that didn't fit as follow-up messages.
// A file note shows only the start of its text: the file is sent with it (noteFile).
export function noteMessage(note, folders, related = []) {
  const path = folderPath(folders, note.folder_id).join(' / ') || 'Unsorted';
  const head = `*${note.description}*\n📁 ${path} · by <@${note.author_id}> · <t:${unix(note.created_at)}:D>\n\n`;
  const body = note.file_name ? clip(note.body, BODY_IN_EMBED) : note.body;
  const [first, ...rest] = body.length > BODY_IN_EMBED ? chunkMessage(body, BODY_IN_EMBED) : [body];
  const embed = new EmbedBuilder().setColor(randomEmbedColor()).setTitle(clip(`${note.file_name ? '📎' : '📄'} ${note.title}`, 256)).setDescription(head + first);
  if (related.length) embed.addFields({ name: '🔗 Related', value: clip(related.map((r) => `• ${r.title}`).join('\n'), 1024) });
  if (note.file_name) embed.setFooter({ text: `Full text in the attached file ${fileNameFor(note.file_name, note.title)}` });
  else if (rest.length) embed.setFooter({ text: `Continued in ${rest.length} more message(s)` });
  return { embeds: [embed], rest, files: note.file_name ? [noteFile(note)] : [] };
}

// One folder (null = the top) as a browsable embed, one level at a time and
// names only: its sub-folders, then the notes filed directly in it. The first
// page carries the menus, which open a folder or a note; if the names don't
// fit one embed the others come back in `rest`, one message each, so every
// one is listed.
export function folderView({ folders, notes }, folderId = null) {
  const subfolders = folders.filter((f) => (f.parent_id ?? null) === folderId);
  const here = notes.filter((n) => n.folder_id === folderId);

  const lines = [...subfolders.map((f) => `📁 **${f.name}**`), ...here.map((n) => `📄 ${n.title}`)];
  const empty = folderId === null ? 'No notes yet — save one with `/save_note`.' : 'This folder is empty.';
  const pages = lines.length ? chunkMessage(lines.join('\n'), TREE_CHARS) : [empty];

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
    ...subfolders.map((f) => ({ label: clip(`📁 ${f.name}`, 100), value: `f${f.id}` })),
    ...here.map((n) => ({ label: clip(`📄 ${n.title}`, 100), value: `n${n.id}` })),
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
