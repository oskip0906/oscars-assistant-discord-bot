import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2] || 'target');
const env = process.env;
const forbidden = /(^|\/)(\.git|node_modules|data)(\/|$)|(^|\/)\.env(?:\.|$)|^\.github\//i;
const MODEL_TIMEOUT_MS = 10 * 60 * 1000;

function attempt(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', timeout: options.timeout ?? 120_000, ...options });
  return { ok: result.status === 0, output: (result.stdout || '') + (result.stderr || ''), stdout: result.stdout || '' };
}

function run(command, args, options = {}) {
  const result = attempt(command, args, options);
  if (!result.ok) throw new Error(`${command} ${args.join(' ')} failed:\n${result.output.slice(-4000)}`);
  return result.stdout;
}

function trackedFiles() {
  return run('git', ['ls-files'])
    .split('\n')
    .filter(Boolean);
}

function snapshotCandidates(tracked) {
  return tracked
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

function sourceSnapshot(tracked) {
  let budget = 140_000;
  const files = [];
  for (const file of snapshotCandidates(tracked)) {
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

// Models wrap their JSON in fences or a sentence often enough that a strict
// parse throws away otherwise usable edit plans.
function parseJson(content) {
  const raw = String(content || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(raw.slice(start, end + 1));
      } catch {
        /* fall through to the shared error below */
      }
    }
    throw new Error(`The development model did not return the required JSON edit plan. It replied:\n${raw.slice(0, 1000)}`);
  }
}

// Some OpenRouter routes return content as an array of parts rather than a string.
function messageContent(message) {
  if (typeof message?.content === 'string') return message.content;
  if (Array.isArray(message?.content)) return message.content.map((part) => part?.text || '').join('');
  return '';
}

async function askModel(tracked) {
  if (!env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY is not configured as a repository Actions secret.');
  let response;
  try {
    response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      signal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
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
            content: JSON.stringify({ task: env.INSTRUCTION, repository_files: sourceSnapshot(tracked) }),
          },
        ],
      }),
    });
  } catch (error) {
    throw new Error(`OpenRouter request failed: ${error.name === 'TimeoutError' ? `no response within ${MODEL_TIMEOUT_MS / 60_000} minutes` : error.message}`);
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) throw new Error(`OpenRouter request failed: ${data.error?.message || `HTTP ${response.status}`}`);
  const choice = data.choices?.[0];
  if (!choice) throw new Error(`The development model \`${env.MODEL}\` returned no completion. OpenRouter replied: ${JSON.stringify(data).slice(0, 500)}`);
  return parseJson(messageContent(choice.message));
}

function validPath(file) {
  return typeof file === 'string' && file.length <= 300 && !file.startsWith('/') && !file.includes('..') && !forbidden.test(file);
}

function applyEdits(plan) {
  const edits = plan.edits;
  if (!Array.isArray(edits) || !edits.length) {
    throw new Error(`The development model produced no safe edits. It explained: ${plan.description || plan.summary || '(no explanation given)'}`);
  }
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
      mkdirSync(path.dirname(destination), { recursive: true });
      writeFileSync(destination, edit.content);
    }
    changed.push(edit.path);
  }
  return changed;
}

function verify(changed) {
  const js = changed.filter((file) => /\.(?:[cm]?js)$/i.test(file) && existsSync(path.join(root, file)));
  for (const file of js) run('node', ['--check', file]);
  const checks = [`node --check (${js.length} JavaScript file(s))`];
  if (existsSync(path.join(root, 'package.json'))) {
    // A model that edits package.json without regenerating the lockfile makes
    // `npm ci` fail on a change that is otherwise fine, so fall back to install.
    const install = existsSync(path.join(root, 'package-lock.json'))
      ? attempt('npm', ['ci', '--ignore-scripts'], { timeout: 360_000 })
      : { ok: false, output: '' };
    if (!install.ok) run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], { timeout: 360_000 });
    checks.push(install.ok ? 'npm ci' : 'npm install');
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
    if (pkg.scripts?.test) {
      run('npm', ['test'], { timeout: 360_000 });
      checks.push('npm test');
    } else {
      checks.push('no package test script');
    }
  }
  return checks;
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

const tracked = trackedFiles();
const plan = await askModel(tracked);
const changed = applyEdits(plan);
const checks = verify(changed);
const body = detailedBody(plan, changed, checks);
// Kept outside the checkout so it can never be staged into the pull request.
const bodyFile = path.join(path.dirname(root), 'development-sandbox-body.md');
writeFileSync(bodyFile, body);

run('git', ['config', 'user.name', 'Panda Development Sandbox']);
run('git', ['config', 'user.email', 'panda-development-sandbox@users.noreply.github.com']);
run('git', ['switch', '-c', env.BRANCH]);

// `git add` fails on a pathspec that matches nothing, which a model can produce
// by "deleting" a file that was never there.
const trackedSet = new Set(tracked);
const stageable = changed.filter((file) => trackedSet.has(file) || existsSync(path.join(root, file)));
if (!stageable.length) throw new Error('The development model returned edits that do not exist in the checkout.');
// A dependency change rewrites the lockfile during verification; shipping the
// manifest without it would leave the branch failing `npm ci`.
if (changed.includes('package.json') && existsSync(path.join(root, 'package-lock.json'))) stageable.push('package-lock.json');
run('git', ['add', '-A', '--', ...stageable]);
if (attempt('git', ['diff', '--cached', '--quiet']).ok) {
  throw new Error('The development model returned edits that left every file unchanged.');
}

run('git', ['commit', '-m', env.COMMIT_TITLE, '-m', body]);
run('git', ['push', 'origin', `HEAD:${env.BRANCH}`]);
run('gh', ['pr', 'create', '--repo', env.TARGET_REPO, '--base', env.BASE, '--head', env.BRANCH, '--title', env.COMMIT_TITLE, '--body-file', bodyFile]);

if (env.AUTO_MERGE === 'true') {
  // The pull request already exists at this point; failing the job over merge
  // settings would hide a perfectly good PR behind a red run.
  const merge = attempt('gh', ['pr', 'merge', env.BRANCH, '--repo', env.TARGET_REPO, '--auto', '--squash', '--delete-branch']);
  if (!merge.ok) {
    console.log(`::warning::Could not enable auto-merge; the pull request stays open for a manual merge.\n${merge.output.slice(-1000)}`);
  }
}
