import { searchResults, fetchPage } from '../tools/search.js';

export { fetchPage };

// Bounded-concurrency map. Research fans out as wide as it can for speed, but
// every page read goes through keyless r.jina.ai, which 429s under a wide
// fan-out — and its backoff makes an unbounded run slower than a bounded one.
// ponytail: fixed limit; raise it (or drop the bound) once JINA_API_KEY is set.
export async function pool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (let i = next++; i < items.length; i = next++) {
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

export function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

// Same page reached two ways (tracking params, trailing slash, #anchor) is one
// page. Normalising before de-duplication is what stops a run spending three
// fetches on one article.
export function normalizeUrl(url) {
  try {
    const parsed = new URL(url);
    // www is not a different site, and domainOf already ignores it — the two
    // have to agree or the same page slips past de-duplication as two sources.
    const host = parsed.hostname.replace(/^www\./, '');
    return `${parsed.protocol}//${host}${parsed.pathname.replace(/\/$/, '')}`.toLowerCase();
  } catch {
    return String(url || '').trim().toLowerCase();
  }
}

// Decide which pages are worth reading: never the same URL twice, and never
// more than `perDomain` from one host, so a single SEO farm cannot own a
// report. `seen` is shared across rounds so a gap round cannot re-read what the
// first round already covered.
export function selectSources(hits, { perDomain = 2, max = 16, seen = new Set() } = {}) {
  const picked = [];
  const byDomain = new Map();

  for (const hit of hits) {
    if (picked.length >= max) break;
    if (!hit?.url) continue;

    const key = normalizeUrl(hit.url);
    if (!key || seen.has(key)) continue;

    const domain = domainOf(hit.url);
    const used = byDomain.get(domain) || 0;
    if (domain && used >= perDomain) continue;

    seen.add(key);
    byDomain.set(domain, used + 1);
    picked.push({ title: hit.title || hit.url, url: hit.url, snippet: hit.snippet || '', domain });
  }
  return picked;
}

// Every sub-question searched at once. SearXNG is on loopback with the bot
// limiter off, so there is nothing here to rate limit.
export async function searchAll(subQuestions, count, config) {
  const settled = await Promise.allSettled(subQuestions.map((q) => searchResults(q.query, count, config)));
  return settled.map((outcome, i) => ({
    ...subQuestions[i],
    hits: outcome.status === 'fulfilled' ? outcome.value : [],
    error: outcome.status === 'rejected' ? String(outcome.reason?.message || outcome.reason).slice(0, 120) : null,
  }));
}
