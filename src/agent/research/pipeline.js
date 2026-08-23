import { planQuestions, extractClaims, synthesizeSection, summarize, gapQueries } from './stages.js';
import { pool, searchAll, selectSources, fetchPage } from './gather.js';

// The three tiers differ in width (how many sub-questions and results) and in
// whether the run is allowed to notice its own gaps and try again.
export const DEPTHS = {
  quick: { subQuestions: 3, perQuestion: 3, perDomain: 1, gapRounds: 0, maxPages: 8, timeoutMs: 90_000 },
  normal: { subQuestions: 5, perQuestion: 4, perDomain: 2, gapRounds: 0, maxPages: 16, timeoutMs: 240_000 },
  deep: { subQuestions: 5, perQuestion: 5, perDomain: 2, gapRounds: 2, maxPages: 32, timeoutMs: 600_000 },
};

// Bound only the page reads (see gather.pool). Model calls ride along at the
// same width, which is well within what OpenRouter serves concurrently.
const FETCH_CONCURRENCY = 8;

// Claims a sub-question needs before it stops counting as a gap.
const ANSWERED = 2;

export function resolveDepth(name) {
  return DEPTHS[String(name || '').toLowerCase()] ? String(name).toLowerCase() : 'normal';
}

// Runs the whole pipeline. The orchestration here is plain JavaScript on
// purpose: which pages get read, when a round stops, what gets dropped and when
// the run is over are all decisions a weak model would make badly, so it is
// never asked to make them. It only ever answers one narrow question at a time.
export async function runResearch({ query, depth = 'normal', config, onProgress = () => {} }) {
  const started = Date.now();
  const tier = DEPTHS[resolveDepth(depth)];
  const deadline = started + tier.timeoutMs;
  const outOfTime = () => Date.now() > deadline;
  const notify = (text) => {
    try {
      onProgress(text);
    } catch {
      /* progress is best-effort; never fail a run over it */
    }
  };

  notify('🧭 Planning sub-questions…');
  const subQuestions = await planQuestions({ query, count: tier.subQuestions, config });

  const seen = new Set();
  const sources = [];
  const claims = [];
  const triedQueries = new Map(subQuestions.map((q) => [q.id, [q.query]]));
  let searchErrors = 0;

  // One round = search every open sub-question in parallel, pick pages, then
  // read and extract them in parallel. A gap round is the same round again,
  // narrowed to the sub-questions that came up short.
  const runRound = async (targets, label) => {
    if (!targets.length || outOfTime()) return;

    notify(`🔎 ${label}: searching ${targets.length} question(s)…`);
    const searched = await searchAll(targets, tier.perQuestion, config);
    searchErrors += searched.filter((s) => s.error).length;

    const budget = tier.maxPages - sources.length;
    if (budget <= 0) return;

    const perQuestionCap = Math.max(1, Math.ceil(budget / targets.length));
    const tasks = [];
    for (const result of searched) {
      const picked = selectSources(result.hits, { perDomain: tier.perDomain, max: perQuestionCap, seen });
      for (const hit of picked) tasks.push({ question: result, hit });
    }
    if (!tasks.length) return;

    notify(`📖 ${label}: reading ${tasks.length} page(s)…`);
    let done = 0;
    await pool(tasks, FETCH_CONCURRENCY, async ({ question, hit }) => {
      if (outOfTime()) return;
      let page;
      try {
        page = await fetchPage(hit.url, config);
      } catch {
        return; // an unreachable page is a dropped source, not a failed run
      }

      const found = await extractClaims({ question: question.question, page, config });
      done++;
      if (done % 4 === 0) notify(`📖 ${label}: read ${done}/${tasks.length} page(s)…`);
      if (!found.length) return;

      const source = { id: `s${sources.length + 1}`, url: page.url, title: page.title, domain: hit.domain };
      sources.push(source);
      for (const claim of found) {
        claims.push({ id: `c${claims.length + 1}`, sourceId: source.id, questionId: question.id, ...claim });
      }
    });
  };

  await runRound(subQuestions, 'Round 1');

  const claimsFor = (id) => claims.filter((c) => c.questionId === id);

  // A sub-question that found nothing always gets one more try, at every depth:
  // the usual cause is a bad search query, not an unanswerable question, and a
  // silent hole in the report is the worst possible outcome. `deep` keeps its
  // extra rounds for questions that are merely thin.
  const rescueRounds = Math.max(1, tier.gapRounds);
  for (let round = 0; round < rescueRounds; round++) {
    if (outOfTime() || sources.length >= tier.maxPages) break;
    // First pass rescues the empty ones; deeper rounds also top up the thin.
    const threshold = round === 0 && !tier.gapRounds ? 1 : ANSWERED;
    const unanswered = subQuestions.filter((q) => claimsFor(q.id).length < threshold);
    if (!unanswered.length) break;

    notify(`🕳️ Gap round ${round + 1}: ${unanswered.length} question(s) still thin…`);
    const rewrites = await Promise.all(
      unanswered.map((q) => gapQueries({ question: q.question, tried: triedQueries.get(q.id) || [], config })),
    );

    const retries = [];
    unanswered.forEach((q, i) => {
      for (const rewritten of rewrites[i]) {
        triedQueries.get(q.id)?.push(rewritten);
        retries.push({ ...q, query: rewritten });
      }
    });
    if (!retries.length) break;
    await runRound(retries, `Gap round ${round + 1}`);
  }

  // Nothing verified means nothing to report. Say that instead of asking the
  // model to write a report out of an empty list, which is exactly how a
  // confident, sourceless answer gets produced.
  if (!claims.length) {
    return {
      query,
      depth: resolveDepth(depth),
      summary: '',
      summaryFacts: [],
      sections: [],
      sources,
      claims,
      unanswered: subQuestions.map((q) => q.question),
      stats: { pages: sources.length, claims: 0, searchErrors, elapsedMs: Date.now() - started },
    };
  }

  // Sub-questions overlap, so the same fact often gets extracted under two of
  // them and written up twice. First section to claim a fact keeps it — pure
  // bookkeeping, no model call, and it is what stops two sections repeating
  // each other.
  const claimed = new Set();
  const sectionClaims = new Map();
  for (const question of subQuestions) {
    const kept = [];
    for (const claim of claimsFor(question.id)) {
      const key = claim.text.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
      if (claimed.has(key)) continue;
      claimed.add(key);
      kept.push(claim);
    }
    sectionClaims.set(question.id, kept);
  }

  // Everything the report needs, written at once: each section only ever sees
  // its own sub-question's claims, which keeps the job narrow enough for a weak
  // model and makes the whole synthesis stage one round-trip wide.
  notify('🧠 Writing the report…');
  const answered = subQuestions.filter((q) => sectionClaims.get(q.id).length > 0);
  const [overview, ...sections] = await Promise.all([
    summarize({ query, claims: claims.slice(0, 40), config }),
    ...answered.map(async (q) => ({
      questionId: q.id,
      question: q.question,
      ...(await synthesizeSection({ question: q.question, claims: sectionClaims.get(q.id), config })),
    })),
  ]);

  return {
    query,
    depth: resolveDepth(depth),
    summary: overview.summary,
    summaryFacts: overview.facts,
    sections,
    sources,
    claims,
    unanswered: subQuestions.filter((q) => claimsFor(q.id).length === 0).map((q) => q.question),
    stats: { pages: sources.length, claims: claims.length, searchErrors, elapsedMs: Date.now() - started },
  };
}
