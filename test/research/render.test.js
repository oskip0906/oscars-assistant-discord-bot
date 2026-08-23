import test from 'node:test';
import assert from 'node:assert/strict';
import { renderReport } from '../../src/agent/research/render.js';
import { chunkMessage } from '../../src/discord/chunk.js';

const report = ({ sections = [], unanswered = [] } = {}) => ({
  query: 'CS/ML grad programs at Stanford, Berkeley and CMU',
  depth: 'normal',
  answer: 'Stanford dropped the GRE [c1]. CMU funds every PhD [c2].',
  answerFacts: ['GRE dropped at Stanford', 'CMU funds all PhDs'],
  sections,
  sources: [
    { id: 's1', url: 'https://cs.stanford.edu/x', title: 'Stanford', domain: 'cs.stanford.edu' },
    { id: 's2', url: 'https://cmu.edu/y', title: 'CMU', domain: 'cmu.edu' },
  ],
  claims: [
    { id: 'c1', sourceId: 's1', text: 'no GRE' },
    { id: 'c2', sourceId: 's2', text: 'full support' },
  ],
  unanswered,
  stats: { pages: 2, claims: 2, searchErrors: 0, elapsedMs: 58_000 },
});

const twoSections = [
  { questionId: 'q1', question: 'What does Stanford require?', facts: ['GPA 3.0 minimum'], body: 'Stanford wants a 3.0 [c1].' },
  { questionId: 'q2', question: 'What does CMU cost?', facts: ['PhDs fully funded'], body: 'CMU funds PhDs [c2].' },
];

test('renders the entire report as one string, not a list of messages', () => {
  const out = renderReport(report({ sections: twoSections }));
  assert.equal(typeof out, 'string');
  for (const section of twoSections) assert.ok(out.includes(section.question), `missing: ${section.question}`);
});

test('leads with a direct answer to the original question, before any section', () => {
  const out = renderReport(report({ sections: twoSections }));
  assert.ok(out.indexOf('[ Answer ]') < out.indexOf('[ 1.'), 'answer box must precede section 1');
  assert.ok(out.includes('GRE dropped at Stanford'));
});

test('names the angles that found nothing instead of only counting them', () => {
  const out = renderReport(report({ sections: twoSections, unanswered: ['What does Berkeley cost?'] }));
  assert.ok(out.includes('What does Berkeley cost?'), 'an unanswered angle must be named in the report');
});

test('claim markers become clickable links outside the code boxes', () => {
  const out = renderReport(report({ sections: twoSections }));
  assert.ok(out.includes('(<https://cs.stanford.edu/x>)'), 'c1 should resolve to its source link');
  assert.ok(!/\[c\d+\]/.test(out), `unresolved marker left in output: ${out}`);
});

test('chunks into full Discord-sized messages with balanced code fences', () => {
  const many = Array.from({ length: 12 }, (_, i) => ({
    questionId: `q${i + 1}`,
    question: `Sub-question number ${i + 1} about admissions`,
    facts: ['a fact worth scanning', 'another fact worth scanning'],
    body: `${'Long grounded sentence about the program [c1]. '.repeat(6)}`,
  }));
  const parts = chunkMessage(renderReport(report({ sections: many })));

  assert.ok(parts.length > 1, 'this fixture should need more than one message');
  for (const part of parts) {
    assert.ok(part.length <= 2000, `part over Discord limit: ${part.length}`);
    assert.equal((part.match(/^```/gm) || []).length % 2, 0, 'unbalanced code fence in a part');
  }
  // The whole point of one-document-then-chunk: parts are packed, not one per section.
  assert.ok(parts.length < many.length, `expected packed messages, got ${parts.length} for ${many.length} sections`);
});
