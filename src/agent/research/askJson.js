import { chatCompletion } from '../openrouter.js';

// Weak models wrap JSON in fences, prefix it with prose, and trail commas.
// Recover what we can from the text before spending a retry on it.
export function parseJson(raw) {
  const text = String(raw || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  const candidates = [text, slice(text, '{', '}'), slice(text, '[', ']')];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

function slice(text, open, close) {
  const start = text.indexOf(open);
  const end = text.lastIndexOf(close);
  return start !== -1 && end > start ? text.slice(start, end + 1) : null;
}

// One narrow job in, schema-valid JSON out — or null. Retries once with the
// failure handed back; a model that cannot produce the shape twice will not
// produce it on the third try, and every caller has a fallback for null.
//
// This is the whole reason the pipeline survives a weak model: no stage ever
// consumes free-form text, so no stage can be derailed by one.
export async function askJson({ config, system, user, isValid, model }) {
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];

  for (let attempt = 0; attempt < 2; attempt++) {
    let content;
    try {
      const message = await chatCompletion({
        apiKey: config.openrouterApiKey,
        model: model || config.model,
        messages,
      });
      content = message?.content ?? '';
    } catch {
      return null;
    }

    const value = parseJson(content);
    if (value !== null && isValid(value)) return value;

    messages.push({ role: 'assistant', content: String(content).slice(0, 400) });
    messages.push({
      role: 'user',
      content: 'That was not the JSON I asked for. Reply with ONLY the JSON object described — no prose, no explanation, no code fences.',
    });
  }
  return null;
}
