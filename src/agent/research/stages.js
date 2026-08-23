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
      '- If the question lists topics to cover (cost, requirements, process, timeline...), every listed topic MUST be covered by some entry.',
      '- Otherwise cover different angles, and never repeat the same angle in two entries.',
      '- Each "question" is used verbatim as a section heading, so write it to read well as one: specific, self-contained, under 80 characters.',
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

export async function synthesizeSection({ query, question, claims, config, ask = askJson }) {
  const value = await ask({
    config,
    system: 'You write one short section of a research report using ONLY the claims given. Reply with ONLY a JSON object.',
    user: [
      `The reader's original question: ${query}`,
      `This section covers one part of it: ${question}`,
      '',
      'Claims:',
      claims.map((c) => `${c.id}: ${c.text}`).join('\n'),
      '',
      'Return: {"facts":["...","..."],"body":"..."}',
      '- "facts" is 2-3 very short scannable lines, each under 60 characters, no trailing punctuation.',
      '- "body" is 3-5 sentences answering this section, written so it also serves the original question.',
      '- Name the thing each statement is about (the organization, product, place) instead of "the program" or "it". A reader must never have to guess which one a sentence means.',
      '- In "body", write the claim id in square brackets right after each statement it supports, like: Queries are mixed with other traffic [c3].',
      '- Every sentence in "body" needs at least one claim id.',
      '- Use ONLY the claims above. Add nothing from your own knowledge, and never write a URL.',
      '- Do not mention the research process, the claims, or what was unavailable. Just report what is known.',
    ].join('\n'),
    isValid: (v) => isText(v?.body),
  });

  // Degraded but honest: the verified claims themselves, each still carrying
  // the marker that will resolve to its source. A failed synthesis costs
  // polish, never the findings or their attribution.
  if (!value) {
    const used = claims.slice(0, 4);
    return {
      facts: used.slice(0, 2).map((c) => c.text),
      body: used.map((c) => `${c.text} [${c.id}]`).join(' '),
      degraded: true,
    };
  }

  return {
    facts: (Array.isArray(value.facts) ? value.facts : []).filter(isText).slice(0, 3).map((f) => f.trim()),
    body: value.body.trim(),
    degraded: false,
  };
}

// The last stage, and the only one that sees the report whole. It runs AFTER
// the sections rather than beside them so it answers what was asked from
// finished, claim-grounded prose instead of from a truncated dump of claims —
// which is the difference between "here is what we found" and an answer.
export async function answerQuestion({ query, sections, unanswered = [], config, ask = askJson }) {
  const value = await ask({
    config,
    system: 'You answer a research question using ONLY the report sections given. Reply with ONLY a JSON object.',
    user: [
      `The question to answer: ${query}`,
      '',
      'Verified report sections:',
      sections.map((s) => `### ${s.question}\n${s.body}`).join('\n\n'),
      '',
      unanswered.length ? `No sources were found for: ${unanswered.join(' | ')}` : 'Every angle returned findings.',
      '',
      'Return: {"facts":["...","..."],"answer":"..."}',
      '- "facts" is 3-4 very short scannable lines, each under 60 characters, no trailing punctuation.',
      '- "answer" is 4-8 sentences answering the question above directly and completely.',
      '- Address every part the question asks about. If it names several things, say something about each of them by name.',
      '- If the sections are missing something the question asked for, say which in one short clause — then move on. Never fill the hole from your own knowledge.',
      '- Keep the [c1] style claim ids on any statement you carry over from a section. Never write a URL.',
      '- Write for the reader, not about the run: no "the available claims", no "the sources say", no mention of sections or research.',
    ].join('\n'),
    isValid: (v) => isText(v?.answer),
  });

  // A failed answer stage must not behead the report: the opening sentence of
  // each section, markers intact, is a plain but true answer.
  if (!value) return { answer: sections.map(firstSentence).filter(Boolean).join(' '), facts: [] };

  return {
    facts: (Array.isArray(value.facts) ? value.facts : []).filter(isText).slice(0, 4).map((f) => f.trim()),
    answer: value.answer.trim(),
  };
}

function firstSentence(section) {
  const body = String(section?.body || '').trim();
  const end = body.search(/(?<=[.!?])\s/);
  return end === -1 ? body : body.slice(0, end + 1).trim();
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
