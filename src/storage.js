import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { db, configured } from './db.js';

const MB = 1024 ** 2;
// PMS's free tier caps all of the account's databases at 1 GiB together.
const LIMIT = 1024 * MB;
const PERSONA = 10 * MB;
const REST = LIMIT - PERSONA;

// A section's size is the bytes of its live rows written out as text, which
// drops as soon as rows are deleted. pg_column_size(t.*) would be closer to disk
// but changes with the query plan, so a cleanup could not aim at it exactly.
// shortcut: indexes and row overhead come on top, so db-1 as a whole can pass
// 1 GiB a little before the context section reads full; count them too if PMS
// ever refuses writes first.
export const SECTIONS = {
  persona: { label: 'Persona', budget: PERSONA, tables: ['prompts', 'bot_settings'] },
  context: { label: 'Context', budget: REST * 0.75, tables: ['context_messages'] },
  notes: { label: 'Notes', budget: REST * 0.2, tables: ['notes', 'note_folders', 'note_links', 'note_revisions'] },
  reminders: { label: 'Reminders', budget: REST * 0.05, tables: ['reminders', 'user_settings'] },
};

// Oldest first; inactive reminders go before active ones. Rows are deleted
// until the bytes freed reach $1.
const TRIM = {
  context: 'context_messages',
  notes: 'notes',
  reminders: 'reminders',
};
const TRIM_ORDER = { context: 'created_at, id', notes: 'created_at, id', reminders: 'active, created_at, id' };

export const STORAGE_PREFIX = 'storage:';
const CHECK_EVERY_MS = 10 * 60 * 1000;

const full = new Set(); // sections at 100%: their writes are refused
const alerted = new Set(); // sections whose alert Oscar has not answered yet
const lastCheck = new Map();
let alertOwner = null; // set by watchStorage once Discord is up

export const isFull = (section) => full.has(section);
export const mb = (bytes) => `${(bytes / MB).toFixed(1)} MB`;

export async function measure(config, section) {
  const sum = SECTIONS[section].tables.map((t) => `(select coalesce(sum(octet_length(t::text)), 0) from ${t} t)`).join(' + ');
  const { rows } = await db.query(config, `select (${sum})::bigint as used`);
  return Number(rows[0].used);
}

export async function check(config, section) {
  const used = await measure(config, section);
  lastCheck.set(section, Date.now());
  if (used < SECTIONS[section].budget) {
    full.delete(section);
    alerted.delete(section);
    return used;
  }
  // Persona is never trimmed or blocked: losing set_rule over its backups would be worse.
  if (section !== 'persona') full.add(section);
  if (!alerted.has(section) && alertOwner) {
    alerted.add(section);
    await alertOwner(section, used).catch((err) => console.error('[storage] alert failed:', err.message));
  }
  return used;
}

// Called after every write; measures at most once per CHECK_EVERY_MS per section.
export function noteWrite(config, section) {
  if (!configured(config) || Date.now() - (lastCheck.get(section) || 0) < CHECK_EVERY_MS) return;
  lastCheck.set(section, Date.now());
  check(config, section).catch((err) => console.error(`[storage] ${section} check failed:`, err.message));
}

export function alertPayload(section, used) {
  const { label, budget } = SECTIONS[section];
  if (section === 'persona') {
    return { content: `⚠️ **${label}** storage is over its ${mb(budget)} slice (${mb(used)}). Nothing is deleted automatically; remove old soul backups by hand.` };
  }
  return {
    content: `⚠️ **${label}** storage is full: ${mb(used)} of ${mb(budget)}. Delete the oldest entries to bring it down to 90%? New ${label.toLowerCase()} writes are refused until then.`,
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`${STORAGE_PREFIX}clean:${section}`).setLabel('Delete oldest').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`${STORAGE_PREFIX}skip:${section}`).setLabel('Not now').setStyle(ButtonStyle.Secondary),
      ),
    ],
  };
}

export async function pruneEmptyFolders(config) {
  for (let i = 0; i < 20; i++) {
    const { rowCount } = await db.query(
      config,
      'delete from note_folders f where not exists (select 1 from notes n where n.folder_id = f.id) and not exists (select 1 from note_folders c where c.parent_id = f.id)',
    );
    if (!rowCount) return;
  }
}

// Only ever run from Oscar's "Delete oldest" click. Trims to 90% of the budget.
export async function cleanup(config, section) {
  const table = TRIM[section];
  if (!table) return { deleted: 0, used: await measure(config, section) };
  const excess = (await measure(config, section)) - SECTIONS[section].budget * 0.9;
  let deleted = 0;
  if (excess > 0) {
    const { rowCount } = await db.query(
      config,
      `delete from ${table} where id in (
         select id from (
           select id, sum(octet_length(t::text)) over (order by ${TRIM_ORDER[section]}) - octet_length(t::text) as before
           from ${table} t
         ) s where before < $1
       )`,
      [Math.ceil(excess)],
    );
    deleted = rowCount;
    if (section === 'notes') await pruneEmptyFolders(config);
  }
  alerted.delete(section);
  return { deleted, used: await check(config, section) };
}

// "Not now": the section stays full, and the hourly check asks again.
export function dismiss(section) {
  alerted.delete(section);
}

export function watchStorage(client, config) {
  if (!configured(config)) return;
  alertOwner = async (section, used) => {
    const owner = await client.users.fetch(config.ownerId);
    await owner.send(alertPayload(section, used));
  };
  const all = () => Object.keys(SECTIONS).forEach((s) => check(config, s).catch((err) => console.error(`[storage] ${s} check failed:`, err.message)));
  all();
  setInterval(all, 60 * 60 * 1000).unref();
}

// Tests only.
export function resetStorageState() {
  full.clear();
  alerted.clear();
  lastCheck.clear();
  alertOwner = null;
}
export const setAlertOwner = (fn) => {
  alertOwner = fn;
};
