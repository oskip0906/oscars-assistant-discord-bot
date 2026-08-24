import { chatCompletion } from './openrouter.js';

// Long-term memory holds EXCHANGES, not prompts. Storing only what people asked
// meant the summary preserved every question and none of the answers: a fact
// Panda established, a link it found, a decision it made all fell out of memory
// the moment they left the verbatim window.
//
// Exchanges accumulate for free; only once COMPACT_THRESHOLD of them have piled
// up does the model get called to fold them in — roughly 1 eviction cycle in 10.

const MAX_SUMMARY_CHARS = 1500;

const SYSTEM_PROMPT = [
  'You maintain the long-term memory of a Discord conversation.',
  'You are given the current memory and the exchanges that have accumulated since the last compaction, each as a question (Q) and the answer that was given (A).',
  'Return the updated memory as plain prose. Return ONLY the memory text.',
  '',
  'Keep: who the people are and what they care about, decisions made, facts established, preferences stated, tasks that are still open, and anything the bot promised to do.',
  'Answers matter as much as questions — what was established is usually the part worth remembering.',
  'Drop: greetings, thanks, goodbyes, acknowledgements, and any exchange where nothing was decided or learned. Two bots being polite to each other is not memory.',
  `Stay under ${MAX_SUMMARY_CHARS} characters. When it would run over, drop the oldest and least consequential details rather than truncating mid-sentence.`,
].join('\n');

const squash = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

// One entry per user message, paired with the reply it actually got. The LAST
// assistant message before the next user turn is the real answer; the earlier
// ones are tool-call narration ("let me look that up") and are not worth
// remembering. Tool results never enter memory: they are raw page text, and
// whatever mattered in them is already in the answer.
export function collectExchanges(messages) {
  const exchanges = [];
  for (let i = 0; i < (messages?.length || 0); i++) {
    if (messages[i]?.role !== 'user') continue;
    const question = squash(messages[i].content);
    if (!question) continue;

    let answer = '';
    for (let j = i + 1; j < messages.length && messages[j]?.role !== 'user'; j++) {
      if (messages[j]?.role === 'assistant' && squash(messages[j].content)) answer = squash(messages[j].content);
    }
    // A question that never got an answer is still worth keeping — it is
    // usually the one thing left open.
    exchanges.push(answer ? `Q: ${question}\nA: ${answer}` : `Q: ${question}`);
  }
  return exchanges;
}

// The prompt promises not to truncate mid-sentence, so the code must not either.
function fitSummary(text) {
  const clean = String(text || '').trim();
  if (clean.length <= MAX_SUMMARY_CHARS) return clean;
  const head = clean.slice(0, MAX_SUMMARY_CHARS);
  const end = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '));
  return (end > MAX_SUMMARY_CHARS * 0.5 ? head.slice(0, end + 1) : `${head.trimEnd()}…`).trim();
}

export async function foldIntoSummary({ previous = '', pending = [], apiKey, model, chat = chatCompletion }) {
  if (!pending.length) return previous;

  const list = pending.map((entry, i) => `${i + 1}. ${entry}`).join('\n');
  const message = await chat({
    apiKey,
    model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          previous ? `Current memory:\n${previous}` : 'Current memory: (empty)',
          '',
          'Exchanges since last compaction:',
          list,
        ].join('\n'),
      },
    ],
  });
  const updated = String(message?.content || '').trim();
  return updated ? fitSummary(updated) : previous;
}

// One compaction at a time per context. rememberEvicted is deliberately not
// awaited by the caller (the reply must not wait on a summary), so without this
// two turns evicting in quick succession both read the same `previous`, both
// fold, and the second write silently discards the first batch entirely.
// Same shape as enqueueContext in messageHandler.js.
const compactions = new Map();
function serialize(key, task) {
  const next = (compactions.get(key) || Promise.resolve()).then(task, task);
  compactions.set(
    key,
    next.finally(() => {
      if (compactions.get(key) === next) compactions.delete(key);
    }),
  );
  return next;
}

export function rememberEvicted({ store, key, evicted, config, chat = chatCompletion }) {
  if (!evicted?.length || !store?.addPending || !store?.consumePending || !config?.openrouterApiKey) return Promise.resolve();

  let shouldCompact = false;
  for (const exchange of collectExchanges(evicted)) {
    if (store.addPending(key, exchange)) shouldCompact = true;
  }
  if (!shouldCompact) return Promise.resolve();

  // Read, fold and write all inside the queue, so `previous` is whatever the
  // previous compaction actually wrote.
  return serialize(key, async () => {
    const pending = store.consumePending(key);
    if (!pending.length) return;
    try {
      const summary = await foldIntoSummary({
        previous: store.summary?.(key) || '',
        pending,
        apiKey: config.openrouterApiKey,
        model: config.model,
        chat,
      });
      if (summary && summary !== store.summary?.(key)) {
        store.setSummary(key, summary);
        console.log(`[panda] memory for ${key}: compacted ${pending.length} exchange(s) into a ${summary.length}-char summary`);
      }
    } catch (err) {
      // Put them back rather than dropping them on a transient API failure.
      store.restorePending?.(key, pending);
      console.error('[panda] memory summarisation failed:', err.message);
    }
  });
}
