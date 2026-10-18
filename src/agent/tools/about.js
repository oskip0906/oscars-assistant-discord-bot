import fs from 'node:fs';
import path from 'node:path';
import { decide } from '../jev.js';

// Panda's manual (ARCHITECTURE.md) and its source, read from the public GitHub
// repo on demand: the Docker image carries only src/ and the manual, and the
// system prompt would pay thousands of tokens every turn for the rare question
// about how Panda works. Only the parts that answer the topic are returned.
export const defs = [
  {
    type: 'function',
    function: {
      name: 'how_i_work',
      description:
        "Read your own manual (ARCHITECTURE.md) and the source code files on GitHub that answer a topic: how you decide to answer, message batching, prompts and set_rule, remembered context and index_chat, notes and reminders, Jev, the OpenRouter models you run on, deep research, the code sandbox, privacy rules, and every tool and slash command you have. Call it before answering ANY question about yourself, your features, your limits or how you were built — never answer those from memory. For how to use one slash command use panda_commands, and for which model you run on use current_model: both are read live. Explain in your own words; don't paste it.",
      parameters: {
        type: 'object',
        properties: {
          topic: {
            type: 'string',
            description: 'Keywords for what to look up, e.g. "history", "batching", "jev reactions", "research". Leave empty for the whole manual, without code.',
          },
        },
      },
    },
  },
];

const BRANCH = 'main';
const TREE_TTL_MS = 10 * 60_000;
// Source files a question may need; lockfiles and binary assets never are.
const SOURCE = /(\.(js|mjs|sql|md|ya?ml|sh|json|toml)|(^|\/)Dockerfile)$/;
const SKIP = /(^|\/)(node_modules|assets)\/|package-lock\.json$/;
const MANUAL_CHARS = 3500; // of the manual, when code comes with it
const CODE_CHARS = 8000; // of code in all
const MAX_FILES = 3;
const FILE_THRESHOLD = 0.5;
const CONTEXT_LINES = 12; // around each line that mentions the topic, in a long file

let tree = null; // { at, paths }
export const resetSourceCache = () => (tree = null);

const repoOf = () => 'oskip0906/oscars-assistant-discord-bot';

async function get(url, config, fetchImpl, api = false) {
  const headers = api ? { Accept: 'application/vnd.github+json', 'User-Agent': 'panda-bot', ...(config.githubPat ? { Authorization: `Bearer ${config.githubPat}` } : {}) } : {};
  const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return api ? res.json() : res.text();
}

// Every source file in the repo, cached; the local copy (src/ only) when GitHub is unreachable.
async function sourceFiles(config, fetchImpl) {
  if (tree && Date.now() - tree.at < TREE_TTL_MS) return tree.paths;
  try {
    const data = await get(`https://api.github.com/repos/${repoOf(config)}/git/trees/${BRANCH}?recursive=1`, config, fetchImpl, true);
    const paths = (data.tree || []).filter((f) => f.type === 'blob' && SOURCE.test(f.path) && !SKIP.test(f.path)).map((f) => f.path);
    tree = { at: Date.now(), paths };
    return paths;
  } catch (err) {
    console.error('[how_i_work] GitHub file list unavailable, using the local copy:', String(err.message || err).slice(0, 200));
    try {
      return fs
        .readdirSync(path.join(config.projectRoot, 'src'), { recursive: true })
        .map((p) => `src/${String(p).split(path.sep).join('/')}`)
        .filter((p) => SOURCE.test(p));
    } catch {
      return [];
    }
  }
}

// One file from GitHub, falling back to the copy in the image; null if neither has it.
async function readSource(config, file, fetchImpl) {
  try {
    return await get(`https://raw.githubusercontent.com/${repoOf(config)}/${BRANCH}/${file}`, config, fetchImpl);
  } catch {
    try {
      return fs.readFileSync(path.join(config.projectRoot, file), 'utf8');
    } catch {
      return null;
    }
  }
}

// The files Jev thinks hold the answer, best first. Jev down: files whose path has a topic word.
async function pickFiles(config, files, topic, words, decideImpl) {
  const scored = [];
  for (let i = 0; i < files.length; i += 25) {
    const batch = files.slice(i, i + 25);
    const state = { topic };
    const questions = {};
    batch.forEach((file, j) => {
      state[`f${j}`] = file;
      questions[`use_f${j}`] = { type: 'noul', instructions: `Is the source file at path \`f${j}\` likely to contain code that explains \`topic\` for this Discord bot?` };
    });
    scored.push(
      decideImpl(config, state, questions).then((answers) =>
        batch.map((file, j) => ({ file, p: answers ? answers[`use_f${j}`]?.noul ?? 0 : words.some((w) => file.toLowerCase().includes(w)) ? 1 : 0 })),
      ),
    );
  }
  return (await Promise.all(scored))
    .flat()
    .filter((f) => f.p >= FILE_THRESHOLD)
    .sort((a, b) => b.p - a.p)
    .slice(0, MAX_FILES)
    .map((f) => f.file);
}

// The whole file when it fits, else only the lines around mentions of the topic.
export function excerpt(text, words, budget) {
  if (text.length <= budget) return text;
  const lines = text.split('\n');
  const keep = new Set();
  lines.forEach((line, i) => {
    if (words.some((w) => line.toLowerCase().includes(w))) {
      for (let k = Math.max(0, i - CONTEXT_LINES); k <= Math.min(lines.length - 1, i + CONTEXT_LINES); k++) keep.add(k);
    }
  });
  if (!keep.size) return `${text.slice(0, budget)}\n…`;
  let out = '';
  let last = -2;
  for (const i of [...keep].sort((a, b) => a - b)) {
    const piece = `${i !== last + 1 ? `… (line ${i + 1})\n` : ''}${lines[i]}\n`;
    if (out.length + piece.length > budget) break;
    out += piece;
    last = i;
  }
  return `${out}…`;
}

// A topic keeps only the manual's `## ` sections that mention one of its words
// and adds the code files that answer it; no topic returns the whole manual.
export async function howIWork({ topic = '' } = {}, invocation, { fetchImpl = fetch, decideImpl = decide } = {}) {
  const config = invocation.config;
  const manual = await readSource(config, 'ARCHITECTURE.md', fetchImpl);
  const words = String(topic).toLowerCase().split(/\W+/).filter((w) => w.length > 2);
  if (!words.length) return manual ?? 'Your manual is not available right now — answer from your system prompt, and say you may be missing detail.';

  const hits = manual ? manual.split(/^(?=## )/m).filter((s) => words.some((w) => s.toLowerCase().includes(w))) : [];
  const parts = [hits.length ? hits.join('\n').slice(0, MANUAL_CHARS) : (manual ?? '').slice(0, MANUAL_CHARS)];

  const files = await pickFiles(config, await sourceFiles(config, fetchImpl), topic, words, decideImpl);
  let budget = CODE_CHARS;
  for (const file of files) {
    if (budget < 500) break;
    const text = await readSource(config, file, fetchImpl);
    if (text == null) continue;
    const shown = excerpt(text, words, budget);
    budget -= shown.length;
    parts.push(`--- ${file} (https://github.com/${repoOf(config)}/blob/${BRANCH}/${file}) ---\n${shown}`);
  }
  if (!parts.join('').trim()) return 'Your manual and code are not available right now — answer from your system prompt, and say you may be missing detail.';
  return parts.join('\n\n');
}
