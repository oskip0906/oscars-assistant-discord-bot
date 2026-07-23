import fs from 'node:fs';
import path from 'node:path';

const MAX_MESSAGES = 60;

// Trim the front of a transcript so it fits in `max` messages while starting on a
// role:'user' boundary — otherwise an assistant tool_calls message can survive
// without its tool results (or vice versa) and the API rejects the history.
export function trimToBoundary(messages, max = MAX_MESSAGES) {
  if (messages.length <= max) return messages;
  let i = messages.length - max;
  while (i < messages.length && messages[i].role !== 'user') i++;
  if (i >= messages.length) return []; // no clean boundary in range: drop history
  return messages.slice(i);
}

export class ContextStore {
  constructor(dir) {
    this.dir = dir;
    this.cache = new Map();
    fs.mkdirSync(dir, { recursive: true });
  }

  fileFor(key) {
    return path.join(this.dir, String(key).replace(/[^a-zA-Z0-9_-]/g, '_') + '.json');
  }

  get(key) {
    if (!this.cache.has(key)) {
      let messages = [];
      try {
        messages = JSON.parse(fs.readFileSync(this.fileFor(key), 'utf8'));
        if (!Array.isArray(messages)) messages = [];
      } catch {
        messages = [];
      }
      this.cache.set(key, messages);
    }
    return this.cache.get(key);
  }

  append(key, newMessages) {
    const merged = trimToBoundary(this.get(key).concat(newMessages));
    this.cache.set(key, merged);
    try {
      fs.writeFileSync(this.fileFor(key), JSON.stringify(merged, null, 2));
    } catch (err) {
      console.error('[contextStore] persist failed:', err.message);
    }
  }

  clear(key) {
    this.cache.set(key, []);
    fs.rmSync(this.fileFor(key), { force: true });
  }

  clearAll() {
    this.cache.clear();
    for (const file of fs.readdirSync(this.dir)) {
      if (file.endsWith('.json')) fs.rmSync(path.join(this.dir, file), { force: true });
    }
  }
}
