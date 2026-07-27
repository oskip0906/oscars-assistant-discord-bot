import { chatCompletion } from './openrouter.js';

// Memory now only stores user prompts instead of the entire message history.
// Prompts are saved directly, and once 10 unique prompts have accumulated the
// model compacts them into the running summary — so only 1 in every 10
// eviction cycles triggers a model call.

const MAX_SUMMARY_CHARS = 1500;

const SYSTEM_PROMPT = [
  'You maintain the long-term memory of a Discord conversation.',
  'You are given the current memory and a list of user prompts that have accumulated since the last compaction.',
  'Return the updated memory as plain prose. Return ONLY the memory text.',
  '',
  'Keep: who the people are and what they care about, decisions made, facts established, preferences stated, tasks that are still open, and anything the bot promised to do.',
  'Drop: greetings, thanks, goodbyes, acknowledgements, and any exchange where nothing was decided or learned. Two bots being polite to each other is not memory.',
  `Stay under ${MAX_SUMMARY_CHARS} characters. When it would run over, drop the oldest and least consequential details rather than truncating mid-sentence.`,
].join('\n');

// Extract unique user prompt texts from evicted messages.
function collectPrompts(messages) {
  return messages
    .filter((m) => m.role === 'user' && m.content)
    .map((m) => String(m.content).replace(/\s+/g, ' ').trim())
    .filter((line) => line.length > 0);
}

export async function foldIntoSummary({ previous = '', pendingPrompts = [], apiKey, model, chat = chatCompletion }) {
  if (!pendingPrompts.length) return previous;

  const promptList = pendingPrompts.map((p, i) => `${i + 1}. ${p}`).join('\n');

  const message = await chat({
    apiKey,
    model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: [previous ? `Current memory:\n${previous}` : 'Current memory: (empty)', '', 'User prompts since last compaction:', promptList].join('\n'),
      },
    ],
  });
  const updated = String(message?.content || '').trim();
  return updated ? updated.slice(0, MAX_SUMMARY_CHARS) : previous;
}

// Accumulate prompts from evicted messages directly.  Only when 10 unique
// prompts have been collected do we call the model to compact them into the
// summary — 1 in 10 times.
export function rememberEvicted({ store, key, evicted, config, chat = chatCompletion }) {
  if (!evicted?.length || !store?.addPrompt || !store?.consumePrompts || !config?.openrouterApiKey) return Promise.resolve();

  // Save each unique user prompt directly.  addPrompt returns true when the
  // threshold is met.
  let shouldCompact = false;
  for (const prompt of collectPrompts(evicted)) {
    if (store.addPrompt(key, prompt)) shouldCompact = true;
  }

  if (!shouldCompact) return Promise.resolve();

  const pendingPrompts = store.consumePrompts(key);
  if (!pendingPrompts.length) return Promise.resolve();

  return foldIntoSummary({ previous: store.summary?.(key) || '', pendingPrompts, apiKey: config.openrouterApiKey, model: config.model, chat })
    .then((summary) => {
      if (summary && summary !== store.summary?.(key)) {
        store.setSummary(key, summary);
        console.log(`[panda] memory for ${key}: compacted ${pendingPrompts.length} user prompts into a ${summary.length}-char summary`);
      }
    })
    .catch((err) => console.error('[panda] memory summarisation failed:', err.message));
}
