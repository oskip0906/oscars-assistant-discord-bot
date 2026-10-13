import { PermissionFlagsBits } from 'discord.js';

// /clear: deletes the newest N messages of a channel, or all of them. Oscar only.
// Messages under 14 days old go 100 at a time through bulk delete; Discord
// refuses that for older ones, so those are deleted one by one, which is slow.

export const PAGE = 100;
// Discord's bulk-delete cutoff is 14 days; stay an hour clear of it so a message
// can't age past it between the fetch and the delete.
const BULK_MAX_AGE = 14 * 24 * 60 * 60 * 1000 - 60 * 60 * 1000;

// What the bot needs in the channel to read its history and delete others' messages.
export const CLEAR_PERMISSIONS = ['ViewChannel', 'ReadMessageHistory', 'ManageMessages'];

// The `amount` option: "all", or a whole number of messages from 1 up.
export function parseClearAmount(raw) {
  const text = String(raw ?? '').trim().toLowerCase();
  if (text === 'all') return { all: true };
  if (/^\d+$/.test(text) && Number(text) >= 1) return { count: Number(text) };
  return { error: 'Give a number of messages (1 or more) or `all`.' };
}

// The permissions the bot lacks to clear `channel`, by name. A channel outside a
// server (a DM) returns null: there the bot can only delete its own messages.
export function missingClearPermissions(channel) {
  const me = channel?.guild?.members?.me;
  if (!me || typeof channel.permissionsFor !== 'function') return null;
  const perms = channel.permissionsFor(me);
  if (!perms) return [...CLEAR_PERMISSIONS];
  return CLEAR_PERMISSIONS.filter((name) => !perms.has(PermissionFlagsBits[name]));
}

// Deletes up to `limit` messages, newest first. Returns { deleted, failed };
// `failed` counts messages Discord would not delete (system messages, say).
// A missing-permission error is thrown, since nothing more would succeed.
export async function clearChannel(channel, { limit = Infinity, now = Date.now, onProgress } = {}) {
  let deleted = 0;
  let failed = 0;
  let before;
  while (deleted + failed < limit) {
    const want = Math.min(PAGE, limit - deleted - failed);
    const page = await channel.messages.fetch({ limit: want, ...(before && { before }) });
    if (!page.size) break;
    const messages = [...page.values()];
    before = messages.at(-1).id;

    const young = messages.filter((m) => now() - m.createdTimestamp < BULK_MAX_AGE);
    const oneByOne = messages.filter((m) => now() - m.createdTimestamp >= BULK_MAX_AGE);
    if (young.length) {
      try {
        await channel.bulkDelete(young.map((m) => m.id));
        deleted += young.length;
      } catch (err) {
        if (err?.code === 50013) throw err;
        // One message Discord won't bulk delete fails the whole batch; retry
        // them singly so only that one is left behind.
        oneByOne.unshift(...young);
      }
    }
    for (const message of oneByOne) {
      try {
        await message.delete();
        deleted++;
      } catch (err) {
        if (err?.code === 50013) throw err;
        failed++;
      }
    }
    await onProgress?.({ deleted, failed });
    if (page.size < want) break;
  }
  return { deleted, failed };
}
