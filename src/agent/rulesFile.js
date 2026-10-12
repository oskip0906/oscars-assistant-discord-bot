import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Oscar's standing rules live in RULES.md at the repo root (RULES_FILE moves
// it, e.g. onto the data volume in Docker). add_rule and remove_rule edit it,
// and every system prompt reads it fresh, so a rule applies from the next
// message. One rule per "- " line; everything else is left as it is.

export const DEFAULT_RULES_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../RULES.md');
const MAX_RULE_CHARS = 500;
const HEADER = "# Panda's rules\n\nOscar's standing rules, one per `- ` line.\n\n## Rules\n";

const fileOf = (config) => config?.rulesFile || DEFAULT_RULES_FILE;
const RULE_LINE = /^\s*[-*]\s+(.+?)\s*$/;

async function readText(file) {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return '';
    throw err;
  }
}

// Lines inside the "## Rules" section when there is one, so the "- " lines of
// any explanation above it are never taken for rules.
function ruleLines(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^##\s+rules\s*$/i.test(l.trim()));
  return lines.map((line, i) => ({ line, i })).filter(({ line, i }) => i > start && RULE_LINE.test(line));
}

export const parseRules = (text) => ruleLines(String(text ?? '')).map(({ line }) => line.match(RULE_LINE)[1]);

// For the system prompt: never throws, a missing or unreadable file is no rules.
export async function readRules(config) {
  try {
    return parseRules(await readText(fileOf(config)));
  } catch (err) {
    console.error('[rules] could not read the rules file:', String(err.message || err).slice(0, 200));
    return [];
  }
}

// Writes go one at a time, each to a temp file renamed over the old one, so two
// rules added at once both land and a crash never leaves half a file.
let writing = Promise.resolve();
function update(config, change) {
  const run = writing.then(async () => {
    const file = fileOf(config);
    const before = await readText(file);
    const result = change(before || HEADER);
    if (result.text !== undefined && result.text !== before) {
      await fs.mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, result.text);
      await fs.rename(tmp, file);
    }
    return result;
  });
  writing = run.catch(() => {});
  return run;
}

const clean = (rule) => String(rule ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_RULE_CHARS);
const same = (a, b) => a.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim() === b.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

export function addRule(config, rule) {
  const text = clean(rule);
  return update(config, (current) => {
    const rules = parseRules(current);
    if (rules.some((r) => same(r, text))) return { added: false, rules };
    return { added: true, rules: [...rules, text], text: `${current.replace(/\s*$/, '')}\n- ${text}\n` };
  });
}

// `number` is the rule's place in the list (1-based, as the system prompt
// numbers them); `match` removes every rule containing that text.
export function removeRule(config, { number, match } = {}) {
  const needle = clean(match).toLowerCase();
  return update(config, (current) => {
    const found = ruleLines(current);
    const drop = found.filter(({ line }, k) => (number ? k + 1 === number : needle && line.match(RULE_LINE)[1].toLowerCase().includes(needle)));
    if (!drop.length) return { removed: [], rules: parseRules(current) };
    const gone = new Set(drop.map(({ i }) => i));
    const text = current.split('\n').filter((_, i) => !gone.has(i)).join('\n');
    return { removed: drop.map(({ line }) => line.match(RULE_LINE)[1]), rules: parseRules(text), text };
  });
}
