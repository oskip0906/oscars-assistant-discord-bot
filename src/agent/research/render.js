// Renders a finished run as a Discord message.
//
// Two hard rules shape the layout:
//   1. A URL inside a code block is not clickable. So the ```css boxes hold
//      only headings and short scannable facts; every sentence a reader might
//      want to follow a source from lives outside them, in normal markdown.
//   2. The model never writes a URL. It marks a statement with the claim id
//      that supports it ([c3]) and linkify swaps that for a masked link built
//      from the source the claim actually came from. An id the run never
//      produced resolves to nothing and disappears.

const FACT_LIMIT = 55;

// Model text is dropped next to fenced blocks, so a stray fence of its own
// would end a box early and spill the rest of the report as plain text.
const safe = (text) => String(text || '').replace(/```/g, "'''").trim();

// One or more claim markers in a row. The model writes them both ways —
// [c3][c4] and [c3, c4] — so both are one run.
const MARKER_RUN = /\s*(?:\[c\d+(?:\s*,\s*c\d+)*\]\s*)+/g;

const box = (lines) => ['```css', ...lines.filter(Boolean), '```'].join('\n');

const seconds = (ms) => `${(ms / 1000).toFixed(0)}s`;

const trim = (text, limit) => {
  const clean = safe(text).replace(/\s+/g, ' ');
  return clean.length > limit ? `${clean.slice(0, limit - 1).trimEnd()}…` : clean;
};

// Rewrites [c3] markers into inline masked links to the source that claim came
// from. Adjacent markers collapse into one parenthetical, and a source already
// linked earlier in the same block is not linked again — four repeats of the
// same domain in one paragraph is noise, not attribution.
export function linkify(text, claims, sources) {
  const sourceOf = new Map(claims.map((claim) => [claim.id, claim.sourceId]));
  const byId = new Map(sources.map((source) => [source.id, source]));
  const alreadyCited = new Set();

  return safe(text)
    .replace(MARKER_RUN, (run) => {
      // The run swallows the whitespace around it, so put back whatever
      // followed — without it, "[c8] and" renders as "(link)and".
      const tail = /\s$/.test(run) ? ' ' : '';
      const ids = [...run.matchAll(/c\d+/g)].map((m) => m[0]);
      const links = [];

      for (const id of ids) {
        const source = byId.get(sourceOf.get(id));
        if (!source || alreadyCited.has(source.id)) continue;
        alreadyCited.add(source.id);
        links.push(`[${safe(source.domain) || 'source'}](${source.url})`);
      }
      // Nothing new to point at: drop the marker rather than leave a bare [c7]
      // or a third link to a page already cited two sentences ago.
      return links.length ? ` (${links.join(', ')})${tail}` : tail;
    })
    .replace(/ +([.,;:!?])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

export function renderReport(report) {
  const { query, depth, summary, summaryFacts = [], sections, sources, claims, unanswered, stats } = report;
  const parts = [`🔬 **${trim(query, 240)}**`];

  if (!sections.length) {
    parts.push(
      box([
        '[ No verified findings ]',
        'Every source failed to load or answered nothing',
        `/* ${stats.pages} page(s) read, ${stats.searchErrors} search failure(s) */`,
      ]),
    );
    if (unanswered.length) parts.push(unanswered.map((q) => `• ${safe(q)}`).join('\n'));
    return parts.join('\n\n');
  }

  if (summary) {
    parts.push(box(['[ Summary ]', ...summaryFacts.map((f) => `• ${trim(f, FACT_LIMIT)}`)]));
    parts.push(linkify(summary, claims, sources));
  }

  sections.forEach((section, i) => {
    parts.push(
      box([
        `[ ${i + 1}. ${trim(section.heading, 60)} ]`,
        ...(section.facts || []).map((f) => `• ${trim(f, FACT_LIMIT)}`),
      ]),
    );
    parts.push(linkify(section.body, claims, sources));
  });

  if (unanswered.length) {
    parts.push(box(['[ Not answered ]', ...unanswered.map((q) => `- ${trim(q, 70)}`)]));
  }

  parts.push(`-# \`${depth}\` · ${stats.pages} sources · ${stats.claims} verified claims · ${seconds(stats.elapsedMs)}`);

  return parts.join('\n\n');
}
