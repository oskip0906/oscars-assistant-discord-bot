import fs from 'node:fs';
import path from 'node:path';

// Set of user IDs whose messages Panda ignores entirely: their triggers are
// never routed to the model, so the bot simply doesn't respond to them.
// Persisted (one user id per line) so the state survives restarts and self_fix
// reloads, mirroring PrivateMode's flag-file approach.
export class ToggledResponses {
  constructor(dataDir) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.file = path.join(dataDir, 'toggled-responses.list');
    this.ids = new Set();
    try {
      for (const line of fs.readFileSync(this.file, 'utf8').split(/\r?\n/)) {
        const id = line.trim();
        if (id) this.ids.add(id);
      }
    } catch {
      /* no list file yet → empty set */
    }
  }

  has(userId) {
    return this.ids.has(String(userId));
  }

  // Flip a user id on/off. Returns the new state (true = now ignored).
  toggle(userId) {
    const id = String(userId);
    const nowOn = !this.ids.has(id);
    if (nowOn) this.ids.add(id);
    else this.ids.delete(id);
    this.persist();
    return nowOn;
  }

  persist() {
    try {
      fs.writeFileSync(this.file, [...this.ids].join('\n'));
    } catch (err) {
      console.error('[toggledResponses] persist failed:', err.message);
    }
  }
}
