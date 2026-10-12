import { saveContext } from '../agent/historyStore.js';
import { configured } from '../db.js';
import { isFull } from '../storage.js';

// /index_channel: copy a channel's whole history into context_messages, the
// store fetch_history reads. Rows are keyed by Discord message id, so a repeat
// run inserts nothing new.

export const INDEX_OWNER_ID = '767525911695851550';
export const PAGE = 100;
export const MAX_MESSAGES = 10000;
const MAX_RETRIES = 5;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

// Returns { indexed, skipped, fetched, capped }. `indexed` counts rows that were
// new, `skipped` those already stored (or with nothing to store, like an image-only post).
export async function indexChannel(config, channel, { save = saveContext, max = MAX_MESSAGES, sleep = wait, onProgress } = {}) {
  if (!configured(config)) throw new Error('the context database is not configured');
  if (isFull('context')) throw new Error('the context storage is full; approve a cleanup first');
  let before;
  let fetched = 0;
  let indexed = 0;
  while (fetched < max) {
    const page = await fetchPage(channel, { limit: Math.min(PAGE, max - fetched), ...(before && { before }) }, sleep);
    if (!page.size) break;
    const messages = [...page.values()];
    fetched += messages.length;
    indexed += await save(config, messages);
    before = messages.reduce((a, m) => (BigInt(m.id) < BigInt(a.id) ? m : a)).id;
    await onProgress?.({ fetched, indexed });
    if (page.size < PAGE) break;
  }
  return { fetched, indexed, skipped: fetched - indexed, capped: fetched >= max };
}
