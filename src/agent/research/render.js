// Renders a finished run as ONE document. Splitting it into Discord-sized
// messages is chunk.js's job and nobody else's — a renderer that also decides
// message boundaries produces six thin messages where two full ones belong.
//
// Two hard rules shape the layout:
//   1. A URL inside a code block is not clickable. So the ```css boxes hold
//      only headings and short scannable facts; every sentence a reader might
//      want to follow a source from lives outside them, in normal markdown.
//   2. The model never writes a URL. It marks a statement with the claim id
//      that supports it ([c3]) and linkify swaps that for a masked link built
//      from the source the claim actually came from. An id the run never
//      produced resolves to nothing and disappears.

const FACT_LIMIT = 60;
const HEADING_LIMIT = 84;

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
//
// The url is wrapped in <> inside the parens: suppressLinkEmbeds deliberately
// skips anything preceded by '(', so without this every link renders its own
// preview card and the report ends in a wall of them.
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
        links.push(`[${safe(source.domain) || 'source'}](<${source.url}>)`);
      }
      // Nothing new to point at: drop the marker rather than leave a bare [c7]
      // or a third link to a page already cited two sentences ago.
      return links.length ? ` (${links.join(', ')})${tail}` : tail;
    })
    .replace(/ +([.,;:!?])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

// Returns the whole report as one string. The caller chunks it.
export function renderReport(report) {
  const { query, depth, answer, answerFacts = [], sections, sources, claims, unanswered = [], stats } = report;

  const parts = [`🔬 **${trim(query, 240)}**`];

  if (answer) {
    parts.push(box(['[ Answer ]', ...answerFacts.map((f) => `• ${trim(f, FACT_LIMIT)}`)]));
    parts.push(linkify(answer, claims, sources));
  } else {
    parts.push(
      box([
        '[ No verified findings ]',
        'Every source failed to load or answered nothing',
        `/* ${stats.pages} page(s) read, ${stats.searchErrors} search failure(s) */`,
      ]),
    );
  }

  sections.forEach((section, i) => {
    parts.push(
      box([
        `[ ${i + 1}. ${trim(section.question, HEADING_LIMIT)} ]`,
        ...(section.facts || []).map((f) => `• ${trim(f, FACT_LIMIT)}`),
      ]),
    );
    parts.push(linkify(section.body, claims, sources));
  });

  // A named gap is worth more than a count: a reader who asked about three
  // universities needs to see which one the run came back empty on, not infer
  // it from a section that quietly covers two.
  if (unanswered.length) {
    parts.push(box(['[ Found nothing on ]', ...unanswered.map((q) => `• ${trim(q, HEADING_LIMIT)}`)]));
  }

  parts.push(
    `-# \`${depth}\` · ${stats.pages} sources · ${stats.claims} verified claims · ${seconds(stats.elapsedMs)}`,
  );

  return parts.filter(Boolean).join('\n\n');
}
