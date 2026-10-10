import fs from 'node:fs';
import path from 'node:path';

// ARCHITECTURE.md is Panda's own manual. Read on demand rather than put in the system
// prompt, where it would cost thousands of tokens on every turn to answer the
// rare question about how Panda works.
export const defs = [
  {
    type: 'function',
    function: {
      name: 'how_i_work',
      description:
        "Read your own manual (the project's ARCHITECTURE.md): how you decide to answer, message batching, memory and summaries, stored history, Jev, the OpenRouter models you run on, deep research, the self-fix sandbox, privacy rules, and every tool and slash command you have. Call it before answering ANY question about yourself, your features, your limits or how you were built — never answer those from memory. Explain in your own words; don't paste the manual.",
      parameters: {
        type: 'object',
        properties: {
          topic: {
            type: 'string',
            description: 'Optional keywords, e.g. "memory", "batching", "jev", "research". Leave empty for the whole manual.',
          },
        },
      },
    },
  },
];

// A topic keeps only the `## ` sections that mention one of its words; no topic,
// or no match, returns the whole thing.
export function howIWork({ topic = '' } = {}, invocation) {
  let readme;
  try {
    readme = fs.readFileSync(path.join(invocation.config.projectRoot, 'ARCHITECTURE.md'), 'utf8');
  } catch {
    return 'Your manual is not available on this machine — answer from your system prompt, and say you may be missing detail.';
  }
  const words = String(topic).toLowerCase().split(/\W+/).filter((w) => w.length > 2);
  const hits = readme.split(/^(?=## )/m).filter((s) => words.some((w) => s.toLowerCase().includes(w)));
  return hits.length ? hits.join('\n') : readme;
}
