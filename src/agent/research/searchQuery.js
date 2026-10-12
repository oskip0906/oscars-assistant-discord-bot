import { askJson } from './askJson.js';

const KINDS = {
  web: 'a web search engine',
  video: 'YouTube',
  news: 'a news search engine',
  wiki: 'Wikipedia',
  image: 'Google Images',
};

// Slash commands hand us what the user typed, which is often a sentence or a
// question, not something a search engine does well with. Ask the model for a
// proper keyword query; on any failure, search the text as written.
export async function buildSearchQuery({ request, kind = 'web', config, ask = askJson }) {
  const text = String(request || '').trim();
  if (!text) return text;
  const value = await ask({
    config,
    system: 'You turn a user request into one good search query. Reply with ONLY a JSON object — no prose, no code fences.',
    user: [
      `The user wants to search ${KINDS[kind] || KINDS.web} for: ${text}`,
      '',
      'Return: {"query":"..."}',
      '- A short keyword query (2-8 words) that a search engine would answer well.',
      '- Keep every name, product, place and year from the request exactly as written.',
      '- Drop filler such as "can you", "please", "tell me about", "find me".',
      '- Do not add facts, names or words the request does not imply.',
    ].join('\n'),
    isValid: (v) => typeof v?.query === 'string' && v.query.trim().length > 0 && v.query.length <= 200,
  });
  return value ? value.query.trim() : text;
}
