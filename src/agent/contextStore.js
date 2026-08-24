import fs from 'node:fs';
import path from 'node:path';

// How many messages are kept word for word. Everything older is folded into the
// running summary instead of being deleted, so a conversation from last week is
// still *known* even once its exact wording is gone.
const MAX_MESSAGES = 40;

// How many unique exchanges accumulate before the model compacts them into the
// summary. Each is stored for free; only 1 eviction cycle in 10 costs a call.
const COMPACT_THRESHOLD = 10;

// Split a transcript so the kept part fits in `max` messages and starts on a
// role:'user' boundary — otherwise an assistant tool_calls message can survive
// without its tool results (or vice versa) and the API rejects the history.
// The evicted half is returned rather than dropped: it is what gets summarised.
export function splitAtBoundary(messages, max = MAX_MESSAGES) {
  if (messages.length <= max) return { kept: messages, evicted: [] };
  let i = messages.length - max;
  while (i < messages.length && messages[i].role !== 'user') i++;
  // No user message in range. Returning kept:[] here threw the whole
  // conversation away — which a couple of tool-heavy turns back to back can
  // trigger. Keep everything instead and let the window overshoot until the
  // next user turn gives us a clean cut; every turn starts with one, so the
  // overshoot lasts exactly one turn.
  if (i >= messages.length) return { kept: messages, evicted: [] };
  return { kept: messages.slice(i), evicted: messages.slice(0, i) };
}

export function trimToBoundary(messages, max = MAX_MESSAGES) {
  return splitAtBoundary(messages, max).kept;
}

// Turns stored while the history block was being persisted carry ten already
// stored messages each, which the model then reads back as prior conversation.
// Strip them on load so an existing transcript heals itself instead of needing
// to be wiped.
const STORED_HISTORY_BLOCK = /\[HISTORY CONTEXT[\s\S]*?\[END HISTORY CONTEXT\]\n?/g;
export function stripStoredHistoryBlock(message) {
  if (message?.role !== 'user' || typeof message.content !== 'string') return message;
  if (!message.content.includes('[HISTORY CONTEXT')) return message;
  return { ...message, content: message.content.replace(STORED_HISTORY_BLOCK, '').trim() };
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

  // Files written before summaries existed are a bare array. Read them as a
  // record with an empty summary rather than throwing the conversation away.
  record(key) {
    if (!this.cache.has(key)) {
      let record = { summary: '', messages: [], pending: [] };
      try {
        const raw = JSON.parse(fs.readFileSync(this.fileFor(key), 'utf8'));
        if (Array.isArray(raw)) record = { summary: '', messages: raw, pending: [] };
        else if (raw && Array.isArray(raw.messages))
          record = {
            summary: String(raw.summary || ''),
            messages: raw.messages,
            // `pendingPrompts` is the pre-exchange field name; carry it over so
            // an existing file keeps what it had accumulated.
            pending: Array.isArray(raw.pending) ? raw.pending : Array.isArray(raw.pendingPrompts) ? raw.pendingPrompts : [],
          };
      } catch {
        /* no file yet, or unreadable — start clean */
      }
      record.messages = record.messages.map(stripStoredHistoryBlock);
      this.cache.set(key, record);
    }
    return this.cache.get(key);
  }

  get(key) {
    return this.record(key).messages;
  }

  summary(key) {
    return this.record(key).summary;
  }

  setSummary(key, text) {
    this.record(key).summary = String(text || '').trim();
    this.persist(key);
  }

  // Returns the messages that aged out of the verbatim window, for the caller
  // to fold into the summary.
  append(key, newMessages) {
    const record = this.record(key);
    const { kept, evicted } = splitAtBoundary(record.messages.concat(newMessages));
    record.messages = kept;
    this.persist(key);
    return evicted;
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
    this.cache.set(key, { summary: '', messages: [], pending: [] });
    fs.rmSync(this.fileFor(key), { force: true });
  }

  clearAll() {
    this.cache.clear();
    for (const file of fs.readdirSync(this.dir)) {
      if (file.endsWith('.json')) fs.rmSync(path.join(this.dir, file), { force: true });
    }
  }
}
