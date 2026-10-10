import fs from 'node:fs';
import path from 'node:path';

// Per-server long-term memory: a running summary plus the exchanges waiting to
// be folded into it. There is no verbatim transcript any more: the model reads
// recent messages straight from Discord through fetch_history when it needs them.

// How many unique exchanges accumulate before the model compacts them into the
// summary. Each is stored for free; only 1 turn in 10 costs a call.
const COMPACT_THRESHOLD = 10;

export class ContextStore {
  constructor(dir) {
    this.dir = dir;
    this.cache = new Map();
    fs.mkdirSync(dir, { recursive: true });
  }

  fileFor(key) {
    return path.join(this.dir, String(key).replace(/[^a-zA-Z0-9_-]/g, '_') + '.json');
  }

  // Older files also carry a `messages` transcript; it is ignored and dropped on
  // the next write.
  record(key) {
    if (!this.cache.has(key)) {
      let record = { summary: '', pending: [] };
      try {
        const raw = JSON.parse(fs.readFileSync(this.fileFor(key), 'utf8'));
        // A bare array is a pre-summary transcript: nothing in it to keep.
        if (raw && !Array.isArray(raw))
          record = {
            summary: String(raw.summary || ''),
            // `pendingPrompts` is the pre-exchange field name; carry it over so
            // an existing file keeps what it had accumulated.
            pending: Array.isArray(raw.pending) ? raw.pending : Array.isArray(raw.pendingPrompts) ? raw.pendingPrompts : [],
          };
      } catch {
        /* no file yet, or unreadable — start clean */
      }
      this.cache.set(key, record);
    }
    return this.cache.get(key);
  }

  summary(key) {
    return this.record(key).summary;
  }

  setSummary(key, text) {
    this.record(key).summary = String(text || '').trim();
    this.persist(key);
  }

  // Accumulate one unique exchange, no model call. Returns true when the
  // threshold is met and the caller should compact.
  addPending(key, entry) {
    const record = this.record(key);
    const clean = String(entry ?? '').trim();
    if (!clean || record.pending.includes(clean)) return false;
    record.pending.push(clean);
    this.persist(key);
    return record.pending.length >= COMPACT_THRESHOLD;
  }

  pendingCount(key) {
    return this.record(key).pending.length;
  }

  consumePending(key) {
    const record = this.record(key);
    const pending = record.pending.slice();
    record.pending = [];
    this.persist(key);
    return pending;
  }

  // Compaction failed; put them back at the front so they are folded in next
  // time rather than lost to a transient API error.
  restorePending(key, entries) {
    const record = this.record(key);
    record.pending = [...entries.filter((e) => !record.pending.includes(e)), ...record.pending];
    this.persist(key);
  }

  persist(key) {
    try {
      fs.writeFileSync(this.fileFor(key), JSON.stringify(this.record(key), null, 2));
    } catch (err) {
      console.error('[contextStore] persist failed:', err.message);
    }
  }

  clear(key) {
    this.cache.set(key, { summary: '', pending: [] });
    fs.rmSync(this.fileFor(key), { force: true });
  }

  clearAll() {
    this.cache.clear();
    for (const file of fs.readdirSync(this.dir)) {
      if (file.endsWith('.json')) fs.rmSync(path.join(this.dir, file), { force: true });
    }
  }
}
