import fs from 'node:fs';
import path from 'node:path';

// A pending approval lives in memory, and a Discord button never expires. Once
// the approval waits with no deadline, a restart mid-wait leaves a card that
// still looks live sitting in the channel forever — click it and the run behind
// it no longer exists. Remembering where the card was posted lets the next boot
// go back and retire it, so there is nothing dead left to click.
//
// Nothing here may throw: it runs either side of a source change landing, and a
// failure to tidy a card must never stop the bot from booting.
export class ApprovalCard {
  constructor(dataDir) {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
    } catch {
      /* fall through — every method below tolerates an unusable file */
    }
    this.file = path.join(dataDir, 'pending-approval.json');
  }

  remember(channelId, messageId) {
    if (!channelId || !messageId) return;
    try {
      fs.writeFileSync(this.file, JSON.stringify({ channelId, messageId }));
    } catch (err) {
      console.error('[approvalCard] could not record the pending card:', err.message);
    }
  }

  forget() {
    try {
      fs.rmSync(this.file, { force: true });
    } catch {
      /* already gone */
    }
  }

  read() {
    try {
      const { channelId, messageId } = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return channelId && messageId ? { channelId, messageId } : null;
    } catch {
      return null;
    }
  }

  // Called once the client is ready. Strips the buttons off a card this process
  // cannot honour and says why, then forgets it either way — a card that cannot
  // be found is not worth retrying on every boot.
  async retireStale(client, { content = '🔁 I restarted while this was waiting, so the request behind it is gone. Send it again for a fresh card.' } = {}) {
    const pending = this.read();
    this.forget();
    if (!pending || !client) return false;
    try {
      const channel = await client.channels.fetch(pending.channelId);
      const message = await channel?.messages?.fetch(pending.messageId);
      if (!message) return false;
      await message.edit({ content, components: [] });
      console.log(`[panda] retired an approval card left over from before the restart (${pending.messageId})`);
      return true;
    } catch (err) {
      console.error('[approvalCard] could not retire the stale card:', err.message);
      return false;
    }
  }
}
