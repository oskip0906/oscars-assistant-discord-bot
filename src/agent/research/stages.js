import { askJson } from './askJson.js';

// Every stage is a prompt plus a shape predicate. None of them plans, decides
// what to read next, or judges when the run is done — that is pipeline.js, in
// plain JavaScript, because those are the decisions a weak model gets wrong.

const isText = (value) => typeof value === 'string' && value.trim().length > 0;
const squash = (value) => String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();

export async function planQuestions({ query, count, config }) {
  const value = await askJson({
    config,
    system: 'You break a research question into independent sub-questions. Reply with ONLY a JSON object — no prose, no code fences.',
    user: [
      `Research question: ${query}`,
      '',
      `Return: {"subQuestions":[{"question":"...","query":"..."}]} with exactly ${count} entries.`,
      '- "question" is one specific factual sub-question worth answering on its own.',
      '- "query" is a short web search query (3-8 words) likely to answer it.',
      '- If the research question names specific things (organizations, people, products, places), every one of them MUST appear by name in at least one sub-question, and in that entry search query too. Never drop one.',
      '- When several named things are being compared, give each its own entry rather than one generic entry that names none of them.',
      '- Otherwise cover different angles, and never repeat the same angle in two entries.',
    ].join('\n'),
    isValid: (v) =>
      Array.isArray(v?.subQuestions) &&
      v.subQuestions.length > 0 &&
      v.subQuestions.every((q) => isText(q?.question) && isText(q?.query)),
  });

  // A model that cannot produce the shape twice still gets a usable run: the
  // question as asked, searched as written, is a valid one-entry plan.
  if (!value) return [{ id: 'q1', question: query, query }];

  return value.subQuestions.slice(0, count).map((q, i) => ({
    id: `q${i + 1}`,
    question: q.question.trim(),
    query: q.query.trim(),
  }));
}

export async function extractClaims({ question, page, config, maxClaims = 5 }) {
  const body = String(page.content || '').slice(0, 8000);
  if (body.length < 200) return [];

  const value = await askJson({
    config,
    system:
      'You extract verifiable facts from ONE web page. Use only what the page says — never your own knowledge. Reply with ONLY a JSON object.',
    user: [
      `Sub-question: ${question}`,
      '',
      `Page title: ${page.title}`,
      '--- PAGE START ---',
      body,
      '--- PAGE END ---',
      '',
      `Return: {"claims":[{"text":"...","quote":"..."}]} with at most ${maxClaims} entries.`,
      '- "text" is one factual sentence that helps answer the sub-question.',
      '- "quote" is a sentence copied EXACTLY, word for word, from the page above.',
      '- If the page does not address the sub-question, return {"claims":[]}.',
    ].join('\n'),
    isValid: (v) => Array.isArray(v?.claims) && v.claims.every((c) => isText(c?.text) && typeof c?.quote === 'string'),
  });
  if (!value) return [];

  return verifyClaims(value.claims.slice(0, maxClaims), body);
}

// The hallucination filter, and the reason a weak model is safe here: a claim
// whose supporting quote is not actually on the page is dropped by code rather
// than trusted on the model's word. Pure and exported so the rule is testable
// without a live model.
export function verifyClaims(rawClaims, body) {
  const haystack = squash(body);
  return (rawClaims || [])
    .filter((c) => {
      const quote = squash(c?.quote);
      return quote.length >= 20 && haystack.includes(quote);
    })
    .map((c) => ({ text: String(c.text).trim(), quote: String(c.quote).trim() }));
}

export async function synthesizeSection({ question, claims, config }) {
  const value = await askJson({
    config,
    system: 'You write one short section of a research report using ONLY the claims given. Reply with ONLY a JSON object.',
    user: [
      `Sub-question: ${question}`,
      '',
      'Claims:',
      claims.map((c) => `${c.id}: ${c.text}`).join('\n'),
      '',
      'Return: {"heading":"...","facts":["...","..."],"body":"..."}',
      '- "heading" is a short title, at most 6 words.',
      '- "facts" is 2-3 very short scannable lines, each under 55 characters, no trailing punctuation.',
      '- "body" is 2-4 sentences answering the sub-question.',
      '- In "body", write the claim id in square brackets right after each statement it supports, like: Queries are mixed with other traffic [c3].',
      '- Every sentence in "body" needs at least one claim id.',
      '- Use ONLY the claims above. Add nothing from your own knowledge, and never write a URL.',
    ].join('\n'),
    isValid: (v) => isText(v?.heading) && isText(v?.body),
  });

  // Degraded but honest: the verified claims themselves, each still carrying
  // the marker that will resolve to its source. A failed synthesis costs
  // polish, never the findings or their attribution.
  if (!value) {
    const used = claims.slice(0, 4);
    return {
      heading: question,
      facts: used.slice(0, 2).map((c) => c.text),
      body: used.map((c) => `${c.text} [${c.id}]`).join(' '),
      degraded: true,
    };
  }

  return {
    heading: value.heading.trim(),
    facts: (Array.isArray(value.facts) ? value.facts : []).filter(isText).slice(0, 3).map((f) => f.trim()),
    body: value.body.trim(),
    degraded: false,
  };
}

export async function summarize({ query, claims, config }) {
  const value = await askJson({
    config,
    system: 'You write the opening summary of a research report using ONLY the claims given. Reply with ONLY a JSON object.',
    user: [
      `Research question: ${query}`,
      '',
      'Claims:',
      claims.map((c) => `${c.id}: ${c.text}`).join('\n'),
      '',
      'Return: {"facts":["...","..."],"summary":"..."}',
      '- "facts" is 2-3 very short scannable lines, each under 55 characters, no trailing punctuation.',
      '- "summary" is 2-4 sentences directly answering the research question.',
      '- In "summary", write the claim id in square brackets right after each statement it supports, like: It is open source [c2].',
      '- Use ONLY the claims above. Add nothing from your own knowledge, and never write a URL.',
      '- If the claims do not answer the question, say so plainly.',
    ].join('\n'),
    isValid: (v) => isText(v?.summary),
  });
  if (!value) return { facts: [], summary: '' };
  return {
    facts: (Array.isArray(value.facts) ? value.facts : []).filter(isText).slice(0, 3).map((f) => f.trim()),
    summary: value.summary.trim(),
  };
}

// The one adaptive decision in the pipeline, and deliberately the narrowest:
// which search terms to try for a sub-question the first round failed to
// answer. Rewriting a failed query is a task a weak model handles; deciding
// what is worth researching is not, so it never gets asked that.
export async function gapQueries({ question, tried, config, count = 2 }) {
  const value = await askJson({
    config,
    system: 'You rewrite failed web search queries. Reply with ONLY a JSON object.',
    user: [
      `Sub-question that is still unanswered: ${question}`,
      `Search queries already tried (they did not work): ${tried.join(' | ')}`,
      '',
      `Return: {"queries":["...","..."]} with ${count} entries.`,
      '- Each is a short web search query (3-8 words).',
      '- Use different wording, synonyms, or a narrower angle than the queries above.',
    ].join('\n'),
    isValid: (v) => Array.isArray(v?.queries) && v.queries.some(isText),
  });
  if (!value) return [];
  return value.queries.filter(isText).slice(0, count).map((q) => q.trim());
}
