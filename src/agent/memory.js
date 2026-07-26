import { chatCompletion } from './openrouter.js';

// The running memory of a server. Once a turn ages out of the verbatim window
// it used to be deleted outright — a conversation was either fully remembered
// or entirely forgotten, with nothing in between. It is now folded in here, so
// what was agreed last week survives even after its exact wording is gone.
const MAX_SUMMARY_CHARS = 1500;

const SYSTEM_PROMPT = [
  'You maintain the long-term memory of a Discord conversation.',
  'You are given the current memory and the messages that just aged out of the live transcript.',
  'Return the updated memory as plain prose. Return ONLY the memory text.',
  '',
  'Keep: who the people are and what they care about, decisions made, facts established, preferences stated, tasks that are still open, and anything the bot promised to do.',
  'Drop: greetings, thanks, goodbyes, acknowledgements, and any exchange where nothing was decided or learned. Two bots being polite to each other is not memory.',
  `Stay under ${MAX_SUMMARY_CHARS} characters. When it would run over, drop the oldest and least consequential details rather than truncating mid-sentence.`,
].join('\n');

// Renders an aged-out slice for the summariser. Tool traffic is dropped: the
// call was made, its result is already reflected in what the bot said next.
function transcribe(messages) {
  return messages
    .filter((message) => message.role === 'user' || (message.role === 'assistant' && message.content))
    .map((message) => `${message.role === 'user' ? 'THEM' : 'PANDA'}: ${String(message.content).replace(/\s+/g, ' ').trim()}`)
    .filter((line) => line.length > 6)
    .join('\n')
    .slice(0, 12_000);
}

export async function foldIntoSummary({ previous = '', evicted = [], apiKey, model, chat = chatCompletion }) {
  const transcript = transcribe(evicted);
  if (!transcript) return previous;

  const message = await chat({
    apiKey,
    model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: [previous ? `Current memory:\n${previous}` : 'Current memory: (empty)', '', 'Messages that just aged out:', transcript].join('\n'),
      },
    ],
  });
  const updated = String(message?.content || '').trim();
  return updated ? updated.slice(0, MAX_SUMMARY_CHARS) : previous;
}

// Fire-and-forget from the reply path: a summary that fails or lags must never
// delay an answer or take a turn down with it.
export function rememberEvicted({ store, key, evicted, config, chat = chatCompletion }) {
  if (!evicted?.length || !store?.setSummary || !config?.openrouterApiKey) return Promise.resolve();
  return foldIntoSummary({ previous: store.summary?.(key) || '', evicted, apiKey: config.openrouterApiKey, model: config.model, chat })
    .then((summary) => {
      if (summary && summary !== store.summary?.(key)) {
        store.setSummary(key, summary);
        console.log(`[panda] memory for ${key}: folded ${evicted.length} aged-out message(s) into a ${summary.length}-char summary`);
      }
    })
    .catch((err) => console.error('[panda] memory summarisation failed:', err.message));
}
