import { saveContext, indexProgress } from '../agent/historyStore.js';
import { configured } from '../db.js';
import { isFull } from '../storage.js';

// Copies a channel's history into context_messages, the store fetch_history
// reads: for /index_channel, and whenever a fetch_history search finds nothing.
// Rows are keyed by Discord message id, so re-reading inserts nothing new. Where
// a run got to is saved per channel (context_channels), so the next one reads
// only what is new since, then carries on back from where the last one stopped,
// instead of starting over from the newest message every time.

export const INDEX_OWNER_ID = '767525911695851550';
export const PAGE = 100;
export const MAX_MESSAGES = 10000;
const MAX_RETRIES = 5;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const newer = (a, b) => BigInt(a) > BigInt(b);

// discord.js already queues behind Discord's rate limits; this covers a 429 that
// still surfaces, honouring its retry-after (seconds, or ms on some errors).
async function fetchPage(channel, options, sleep) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await channel.messages.fetch(options);
    } catch (err) {
      const limited = err?.status === 429 || err?.code === 429 || err?.httpStatus === 429;
      if (!limited || attempt >= MAX_RETRIES) throw err;
      const after = Number(err.retryAfter ?? err.retry_after ?? err.data?.retry_after);
      const ms = Number.isFinite(after) && after > 0 ? (after < 100 ? after * 1000 : after) : 1000 * 2 ** attempt;
      await sleep(Math.min(ms, 60000));
    }
  }
}

// Returns { indexed, skipped, fetched, capped, complete }. `indexed` counts rows
// that were new, `skipped` those already stored (or with nothing to store, like
// an image-only post). `capped` means `max` or `ms` ran out first: the next run
// continues. `complete` means everything back to the channel's first message is in.
export async function indexChannel(
  config,
  channel,
  { save = saveContext, progress = indexProgress, max = MAX_MESSAGES, ms = Infinity, now = Date.now, sleep = wait, onProgress } = {},
) {
  if (!configured(config)) throw new Error('the context database is not configured');
  if (isFull('context')) throw new Error('the context storage is full; approve a cleanup first');
  const channelId = channel.id;
  const st = { newest_id: null, oldest_id: null, complete: false, ...((await progress.load(config, channelId)) ?? {}) };
  const deadline = now() + ms;
  let fetched = 0;
  let indexed = 0;
  const outOfBudget = () => fetched >= max || now() >= deadline || isFull('context');

  // Pages back from `before` (the newest message when unset). `onPage` gets each
  // page newest first and returns false to stop. Resolves to true when it reached
  // the channel's first message.
  async function walk(before, onPage) {
    while (!outOfBudget()) {
      const page = await fetchPage(channel, { limit: Math.min(PAGE, max - fetched), ...(before && { before }) }, sleep);
      if (!page.size) return true;
      const messages = [...page.values()].sort((a, b) => (newer(a.id, b.id) ? -1 : 1));
      fetched += messages.length;
      if (!(await onPage(messages))) return false;
      await onProgress?.({ fetched, indexed });
      before = messages.at(-1).id;
      if (page.size < PAGE) return true;
    }
    return false;
  }

  // 1. What was said since the last run, down to its newest message.
  let short = false;
  if (st.newest_id) {
    let top = null;
    let reached = false;
    await walk(undefined, async (messages) => {
      top ??= messages[0].id;
      const fresh = messages.filter((m) => newer(m.id, st.newest_id));
      indexed += await save(config, fresh);
      reached = fresh.length < messages.length;
      return !reached;
    });
    // A run cut short leaves a gap below `top`, so it is only recorded once joined up.
    if (reached || top === null) {
      if (top) st.newest_id = top;
      await progress.save(config, channelId, st);
    } else short = true;
  }

  // 2. Older history, from where the last run stopped back to the first message.
  if (!st.complete && !outOfBudget()) {
    st.complete = await walk(st.oldest_id ?? undefined, async (messages) => {
      indexed += await save(config, messages);
      st.newest_id ??= messages[0].id;
      st.oldest_id = messages.at(-1).id;
      await progress.save(config, channelId, st);
      return true;
    });
    await progress.save(config, channelId, st);
  }

  return { fetched, indexed, skipped: fetched - indexed, capped: short || !st.complete, complete: st.complete };
}
