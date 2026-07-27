import fs from 'node:fs';
import path from 'node:path';

// How many messages are kept word for word. Everything older is folded into the
// running summary instead of being deleted, so a conversation from last week is
// still *known* even once its exact wording is gone.
const MAX_MESSAGES = 40;

// How many unique user prompts we accumulate before the model compacts them
// into the summary. Every prompt is saved directly; only 1 in 10 eviction cycles
// triggers a model call.
const PROMPT_COMPACT_THRESHOLD = 10;

// Split a transcript so the kept part fits in `max` messages and starts on a
// role:'user' boundary — otherwise an assistant tool_calls message can survive
// without its tool results (or vice versa) and the API rejects the history.
// The evicted half is returned rather than dropped: it is what gets summarised.
export function splitAtBoundary(messages, max = MAX_MESSAGES) {
  if (messages.length <= max) return { kept: messages, evicted: [] };
  let i = messages.length - max;
  while (i < messages.length && messages[i].role !== 'user') i++;
  if (i >= messages.length) return { kept: [], evicted: messages }; // no clean boundary in range
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
      let record = { summary: '', messages: [], pendingPrompts: [] };
      try {
        const raw = JSON.parse(fs.readFileSync(this.fileFor(key), 'utf8'));
        if (Array.isArray(raw)) record = { summary: '', messages: raw, pendingPrompts: [] };
        else if (raw && Array.isArray(raw.messages)) record = { summary: String(raw.summary || ''), messages: raw.messages, pendingPrompts: Array.isArray(raw.pendingPrompts) ? raw.pendingPrompts : [] };
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

  // Accumulate a unique user prompt directly, without a model call.  Returns
  // true when the threshold is met and the caller should compact.
  addPrompt(key, content) {
    const record = this.record(key);
    const clean = String(content).replace(/\s+/g, ' ').trim();
    if (!clean) return false;
    if (record.pendingPrompts.includes(clean)) return false;
    record.pendingPrompts.push(clean);
    this.persist(key);
    return record.pendingPrompts.length >= PROMPT_COMPACT_THRESHOLD;
  }

  promptsPending(key) {
    return this.record(key).pendingPrompts.length;
  }

  // Consume all pending prompts (for compaction) and return them.
  consumePrompts(key) {
    const record = this.record(key);
    const prompts = record.pendingPrompts.slice();
    record.pendingPrompts = [];
    this.persist(key);
    return prompts;
  }

  persist(key) {
    try {
      fs.writeFileSync(this.fileFor(key), JSON.stringify(this.record(key), null, 2));
    } catch (err) {
      console.error('[contextStore] persist failed:', err.message);
    }
  }

  clear(key) {
    this.cache.set(key, { summary: '', messages: [], pendingPrompts: [] });
    fs.rmSync(this.fileFor(key), { force: true });
  }

  clearAll() {
    this.cache.clear();
    for (const file of fs.readdirSync(this.dir)) {
      if (file.endsWith('.json')) fs.rmSync(path.join(this.dir, file), { force: true });
    }
  }
}
