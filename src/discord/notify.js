import { chunkMessage } from './chunk.js';

// Direct, un-modelled notifications to Oscar. Nothing here goes near the agent:
// self_fix ends with the bot restarting, and a report that had to survive a
// round-trip through the model could be reworded, delayed, or dropped entirely.
// This just puts the text in his DMs.
//
// Never throws. A closed DM channel or a dead client must not take down the
// caller, which is usually mid-way through shipping a fix.
export async function dmOwner(client, ownerId, content) {
  const text = String(content ?? '').trim();
  if (!text || !client || !ownerId) return false;

  try {
    const user = await client.users.fetch(ownerId);
    for (const part of chunkMessage(text)) {
      await user.send(part);
    }
    return true;
  } catch (err) {
    console.error('[notify] could not DM the owner:', err.message);
    return false;
  }
}
