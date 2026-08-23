// Renders a finished run as Discord messages — one per section, so a section
// is never split across two messages and never shares one with its neighbour.
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

// Discord's ceiling is 2000. The gap is headroom for the footer, which is
// appended to the last message after fitting.
const MESSAGE_LIMIT = 1800;

// One section, one message — that is the whole point of returning an array, so
// a section that would overflow gets its prose cut back at a sentence boundary
// rather than spilling into a second message. Sections are 2-4 sentences by
// construction, so this is a safety net, not a routine path.
function fit(text, limit = MESSAGE_LIMIT) {
  if (text.length <= limit) return text;
  const head = text.slice(0, limit - 1);
  // Never cut inside a masked link: back up to before the last '(' that has no
  // matching ')' after it.
  const openLink = head.lastIndexOf('](');
  const safeEnd = openLink !== -1 && head.indexOf(')', openLink) === -1 ? openLink : head.length;
  const body = head.slice(0, safeEnd);
  const sentence = Math.max(body.lastIndexOf('. '), body.lastIndexOf('.\n'));
  return `${(sentence > limit * 0.5 ? body.slice(0, sentence + 1) : body).trimEnd()}…`;
}

// Returns an array of messages: the header/summary, then exactly one message
// per section. The caller sends them in order.
export function renderMessages(report) {
  const { query, depth, summary, summaryFacts = [], sections, sources, claims, unanswered, stats } = report;

  const footer = [
    `-# \`${depth}\` · ${stats.pages} sources · ${stats.claims} verified claims · ${seconds(stats.elapsedMs)}`,
    // Gaps are reported as a count, not as a box listing our own failed
    // sub-questions — the decomposition is an implementation detail, and a
    // scolding block about it is not what anyone asked to read.
    unanswered.length ? ` · ${unanswered.length} angle(s) found nothing` : '',
  ].join('');

  if (!sections.length) {
    return [
      [
        `🔬 **${trim(query, 240)}**`,
        box([
          '[ No verified findings ]',
          'Every source failed to load or answered nothing',
          `/* ${stats.pages} page(s) read, ${stats.searchErrors} search failure(s) */`,
        ]),
        footer,
      ].join('\n\n'),
    ];
  }

  const messages = [];

  const head = [`🔬 **${trim(query, 240)}**`];
  if (summary) {
    head.push(box(['[ Summary ]', ...summaryFacts.map((f) => `• ${trim(f, FACT_LIMIT)}`)]));
    head.push(linkify(summary, claims, sources));
  }
  messages.push(fit(head.join('\n\n')));

  for (const [i, section] of sections.entries()) {
    const message = [
      box([
        `[ ${i + 1}. ${trim(section.heading, 60)} ]`,
        ...(section.facts || []).map((f) => `• ${trim(f, FACT_LIMIT)}`),
      ]),
      linkify(section.body, claims, sources),
    ].join('\n\n');
    messages.push(fit(message));
  }

  // The footer rides along with the last section rather than costing a message
  // of its own.
  messages[messages.length - 1] += `\n\n${footer}`;
  return messages;
}
