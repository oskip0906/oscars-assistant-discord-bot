import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2] || 'target');
const env = process.env;
const forbidden = /(^|\/)(\.git|node_modules|data)(\/|$)|(^|\/)\.env(?:\.|$)|^\.github\//i;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', timeout: options.timeout ?? 120_000, ...options });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed:\n${(result.stderr || result.stdout || '').slice(-4000)}`);
  return result.stdout || '';
}

function trackedFiles() {
  return run('git', ['ls-files'])
    .split('\n')
    .filter(Boolean)
    .filter((file) => !forbidden.test(file))
    .filter((file) => {
      try {
        return readFileSync(path.join(root, file)).length <= 60_000;
      } catch {
        return false;
      }
    })
    .slice(0, 160);
}

function sourceSnapshot() {
  let budget = 140_000;
  const files = [];
  for (const file of trackedFiles()) {
    const content = readFileSync(path.join(root, file), 'utf8');
    if (content.includes('\0')) continue;
    const clipped = content.slice(0, Math.min(content.length, budget));
    if (!clipped) break;
    files.push({ path: file, content: clipped });
    budget -= clipped.length;
    if (budget <= 0) break;
  }
  return files;
}

function parseJson(content) {
  const raw = String(content || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('The development model did not return the required JSON edit plan.');
  }
}

async function askModel() {
  if (!env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY is not configured as a repository Actions secret.');
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': `https://github.com/${env.TARGET_REPO}`,
      'X-Title': 'panda-bot-development-sandbox',
    },
    body: JSON.stringify({
      model: env.MODEL,
      temperature: 0.1,
      messages: [
        {
          role: 'system',
          content: [
            'You are an autonomous software engineer working in an isolated CI checkout.',
            'Return only valid JSON with this shape: {"summary":"short summary", "description":"detailed explanation", "edits":[{"path":"relative/path", "content":"complete file contents or null to delete"}]}.',
            'Make the smallest correct change for the approved task. Include complete contents for every changed file.',
            'Never access or modify secrets, .env files, data, node_modules, .git, or .github. Do not make unrelated changes.',
            'Use only the supplied repository snapshot. If no safe change is possible, return edits:[] and explain why.',
          ].join('\n'),
        },
        {
          role: 'user',
          content: JSON.stringify({ task: env.INSTRUCTION, repository_files: sourceSnapshot() }),
        },
      ],
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) throw new Error(`OpenRouter request failed: ${data.error?.message || response.status}`);
  return parseJson(data.choices?.[0]?.message?.content);
}

function validPath(file) {
  return typeof file === 'string' && file.length <= 300 && !file.startsWith('/') && !file.includes('..') && !forbidden.test(file);
}

function applyEdits(edits) {
  if (!Array.isArray(edits) || !edits.length) throw new Error('The development model produced no safe edits.');
  const changed = [];
  for (const edit of edits) {
    if (!validPath(edit?.path) || (edit.content !== null && typeof edit.content !== 'string')) {
      throw new Error(`Unsafe edit returned for ${String(edit?.path || '(unknown)')}.`);
    }
    const destination = path.resolve(root, edit.path);
    if (!destination.startsWith(`${root}${path.sep}`)) throw new Error(`Path escapes checkout: ${edit.path}`);
    if (edit.content === null) {
      if (existsSync(destination)) rmSync(destination);
    } else {
      writeFileSync(destination, edit.content);
    }
    changed.push(edit.path);
  }
  return changed;
}

function verify(changed) {
  const js = changed.filter((file) => /\.(?:[cm]?js)$/i.test(file) && existsSync(path.join(root, file)));
  for (const file of js) run('node', ['--check', file]);
  if (existsSync(path.join(root, 'package-lock.json'))) run('npm', ['ci', '--ignore-scripts'], { timeout: 360_000 });
  if (existsSync(path.join(root, 'package.json'))) {
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
    if (pkg.scripts?.test) run('npm', ['test'], { timeout: 360_000 });
  }
  return [`node --check (${js.length} JavaScript file(s))`, existsSync(path.join(root, 'package.json')) ? 'npm test' : 'no package test script'];
}

function detailedBody(plan, changed, checks) {
  return [
    '## Remote development sandbox',
    '',
    `**Approved task:** ${env.INSTRUCTION}`,
    '',
    '### Summary',
    plan.summary || 'Automated development change.',
    '',
    '### Description',
    plan.description || 'No additional description was supplied.',
    '',
    '### Files changed',
    ...changed.map((file) => `- \`${file}\``),
    '',
    '### Verification',
    ...checks.map((check) => `- ${check}`),
    '',
    `Model: \`${env.MODEL}\``,
  ].join('\n');
}

const plan = await askModel();
const changed = applyEdits(plan.edits);
const checks = verify(changed);
const body = detailedBody(plan, changed, checks);
const bodyFile = path.join(root, '.panda-pr-body.md');
writeFileSync(bodyFile, body);

run('git', ['switch', '-c', env.BRANCH]);
run('git', ['add', '--', ...changed]);
run('git', ['config', 'user.name', 'Panda Development Sandbox']);
run('git', ['config', 'user.email', 'panda-development-sandbox@users.noreply.github.com']);
run('git', ['commit', '-m', env.COMMIT_TITLE, '-m', body]);
run('git', ['push', 'origin', `HEAD:${env.BRANCH}`]);
run('gh', ['pr', 'create', '--repo', env.TARGET_REPO, '--base', env.BASE, '--head', env.BRANCH, '--title', env.COMMIT_TITLE, '--body-file', bodyFile]);
if (env.AUTO_MERGE === 'true') run('gh', ['pr', 'merge', env.BRANCH, '--repo', env.TARGET_REPO, '--auto', '--squash', '--delete-branch']);
