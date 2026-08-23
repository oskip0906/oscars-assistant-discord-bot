import test from 'node:test';
import assert from 'node:assert/strict';
import { answerQuestion } from '../../src/agent/research/stages.js';

const sections = [
  { question: 'What does Stanford require?', body: 'Stanford dropped the GRE [c1]. A 3.0 GPA is the floor [c2].' },
  { question: 'What does CMU cost?', body: 'CMU funds every PhD in good standing [c3].' },
];

const args = (ask) => ({ query: 'CS/ML grad programs at Stanford and CMU', sections, config: {}, ask });

test('asks the model to answer the original question using the finished sections', async () => {
  let seen;
  await answerQuestion(args(async (opts) => {
    seen = opts.user;
    return { answer: 'ok [c1]', facts: ['a fact'] };
  }));
  assert.match(seen, /CS\/ML grad programs at Stanford and CMU/, 'the original question must reach the prompt');
  assert.match(seen, /CMU funds every PhD in good standing \[c3\]/, 'section bodies must reach the prompt');
});

test('falls back to the sections themselves when the model cannot answer', async () => {
  const { answer, facts } = await answerQuestion(args(async () => null));
  assert.ok(answer.trim().length > 0, 'a failed answer stage must not blank the head of the report');
  assert.match(answer, /\[c1\]/, 'the fallback must keep its claim markers so citations still resolve');
  assert.deepEqual(facts, []);
});

test('tells the reader which parts of the question came back empty', async () => {
  let seen;
  await answerQuestion({
    ...args(async (opts) => {
      seen = opts.user;
      return { answer: 'ok', facts: [] };
    }),
    unanswered: ['What does Berkeley cost?'],
  });
  assert.match(seen, /What does Berkeley cost\?/, 'unanswered angles must be declared to the answer stage');
});
