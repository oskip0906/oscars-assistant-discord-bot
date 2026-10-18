import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// Post-edit verification for self_fix. Two cheap, side-effect-free checks that
// together catch the failure modes that have actually taken this bot down:
//
//   nodeCheck()        — syntax errors
//   unresolvedImports() — relative imports pointing at files that don't exist
//
// The second one matters more than it looks. `node --check` parses a file in
// isolation and never resolves its imports, so a wrong relative path (the
// classic '../../config.js' when the target is one level up) passes syntax
// checking and then hard-crashes the process at boot.

// Strip comments and string bodies would be overkill; instead we match the
// import/export forms directly and skip anything inside a line comment.
const STATIC_FROM = /(?:^|[\s;}])(?:import|export)\s[^;'"]*?from\s*['"]([^'"]+)['"]/g;
const SIDE_EFFECT = /(?:^|[\s;}])import\s*['"]([^'"]+)['"]/g;
const DYNAMIC = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

// Drop line comments so a commented-out import isn't reported. Block comments
// are left alone — a false positive there is harmless and the regex cost of
// handling them properly isn't worth it.
function stripLineComments(source) {
  return source
    .split('\n')
    .map((line) => {
      const i = line.indexOf('//');
      if (i === -1) return line;
      // Don't cut inside a string or a URL (https://…).
      const before = line.slice(0, i);
      const quotes = (before.match(/['"`]/g) || []).length;
      if (quotes % 2 === 1 || line[i - 1] === ':') return line;
      return before;
    })
    .join('\n');
}

// Only relative specifiers are ours to resolve. Bare ('discord.js') and
// builtin ('node:fs') specifiers belong to the resolver and node_modules.
function isRelative(spec) {
  return spec.startsWith('./') || spec.startsWith('../');
}

// Relative specifiers in ESM are exact file paths — no extension guessing, no
// directory/index fallback. So "does this file exist" is the whole check.
export function unresolvedImports(absFile) {
  let source;
  try {
    source = fs.readFileSync(absFile, 'utf8');
  } catch {
    return [];
  }
  const cleaned = stripLineComments(source);
  const dir = path.dirname(absFile);
  const seen = new Set();
  const broken = [];

  for (const re of [STATIC_FROM, SIDE_EFFECT, DYNAMIC]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(cleaned)) !== null) {
      const spec = m[1];
      if (!isRelative(spec) || seen.has(spec)) continue;
      seen.add(spec);
      if (!fs.existsSync(path.resolve(dir, spec))) broken.push(spec);
    }
  }
  return broken;
}

// `node --check` one file. Resolves to null on success or an error string.
export function nodeCheck(absFile, cwd) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ['--check', absFile],
      { cwd, timeout: 30 * 1000, maxBuffer: 4 * 1024 * 1024 },
      (err, _stdout, stderr) => {
        if (err) return resolve((stderr || err.message || 'syntax error').trim().slice(0, 1500));
        resolve(null);
      },
    );
  });
}

// Run both checks over the files self_fix touched. Resolves to an array of
// human-readable problem strings — empty means the edit is safe to ship.
export async function verifyChangedFiles(root, changedRelPaths) {
  const problems = [];
  for (const rel of changedRelPaths) {
    if (!rel.endsWith('.js')) continue;
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) continue; // deleted on purpose

    const syntax = await nodeCheck(abs, root);
    if (syntax) {
      problems.push(`${rel}: syntax error\n${syntax}`);
      continue; // a file that won't parse can't be import-scanned meaningfully
    }
    const broken = unresolvedImports(abs);
    if (broken.length) {
      problems.push(`${rel}: imports that resolve to nothing → ${broken.join(', ')}`);
    }
  }
  return problems;
}
