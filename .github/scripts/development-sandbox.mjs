import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
// From the sandbox repository's own checkout, not the target's — this script and
// the module are versioned together.
import { runRepoAgent } from '../../src/agent/tools/repoAgent.js';
import { McpClient, toOpenRouterTools } from '../../src/agent/mcp.js';

const root = path.resolve(process.argv[2] || 'target');
const env = process.env;
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

// Some OpenRouter routes return content as an array of parts rather than a string.
function messageContent(message) {
  if (typeof message?.content === 'string') return message.content;
  if (Array.isArray(message?.content)) return message.content.map((part) => part?.text || '').join('');
  return '';
}

// One turn of the agent loop. The model decides what to read and what to write;
// this only carries the conversation to OpenRouter and back.
async function callModel(messages, tools) {
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
      body: JSON.stringify({ model: env.MODEL, temperature: 0.1, messages, tools, tool_choice: 'auto' }),
    });
  } catch (error) {
    throw new Error(`OpenRouter request failed: ${error.name === 'TimeoutError' ? `no response within ${MODEL_TIMEOUT_MS / 60_000} minutes` : error.message}`);
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) throw new Error(`OpenRouter request failed: ${data.error?.message || `HTTP ${response.status}`}`);
  const message = data.choices?.[0]?.message;
  if (!message) throw new Error(`The development model \`${env.MODEL}\` returned no completion. OpenRouter replied: ${JSON.stringify(data).slice(0, 500)}`);
  return { content: messageContent(message), tool_calls: message.tool_calls };
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
    ...(plan.completed === false ? ['', '⚠️ The model hit its step limit before summarising; the edits it had written are included.'] : []),
    '',
    `Model: \`${env.MODEL}\` (agent loop: it read and wrote files directly)`,
    ...(env.PANDA_MCP_PAT ? [`GitHub MCP: ${env.SANDBOX_MCP_WRITE === 'true' ? 'read/write' : 'read-only'} (orientation only; every edit above was written and verified in the checkout)`] : []),
  ].join('\n');
}

// GitHub's hosted MCP server, for orientation only: search_code and history are
// things this agent otherwise cannot do at all, and it burns steps reading files
// one at a time to compensate. The edits still happen in the checkout — see the
// system prompt and the finish gate in repoAgent.js.
//
// Read-only by default. Remote writes would land outside the checkout, so they
// skip node --check, npm test, the FORBIDDEN path guard, and the pull request
// itself; SANDBOX_MCP_WRITE=true opts into that with eyes open.
//
// api.githubcopilot.com does not accept the Actions GITHUB_TOKEN, so this needs
// PANDA_MCP_PAT. Without it the sandbox simply runs as it did before.
async function githubMcp() {
  const token = env.PANDA_MCP_PAT;
  if (!token) {
    console.log('::notice::PANDA_MCP_PAT is not set — running with the file tools only.');
    return { extraTools: [], callExtraTool: null };
  }
  const write = env.SANDBOX_MCP_WRITE === 'true';
  const client = new McpClient({
    url: write ? 'https://api.githubcopilot.com/mcp/' : 'https://api.githubcopilot.com/mcp/readonly',
    headers: { Authorization: `Bearer ${token}` },
    name: 'panda-bot-development-sandbox',
  });
  try {
    const tools = await client.listTools();
    console.log(`::notice::GitHub MCP ${write ? '(read/write)' : '(read-only)'}: ${tools.length} tool(s) available.`);
    return { extraTools: toOpenRouterTools(tools), callExtraTool: (name, args) => client.callTool(name, args) };
  } catch (error) {
    // A development run is expensive and already approved; losing the extra
    // tools is worth far less than losing the run.
    console.log(`::warning::GitHub MCP unavailable, continuing with the file tools only: ${error.message}`);
    return { extraTools: [], callExtraTool: null };
  }
}

const tracked = trackedFiles();
if (!env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY is not configured as a repository Actions secret.');
console.log(`::notice::Repository has ${tracked.length} tracked file(s). The model reads what it needs.`);

const { extraTools, callExtraTool } = await githubMcp();
const plan = await runRepoAgent({ instruction: env.INSTRUCTION, root, tracked, callModel, extraTools, callExtraTool });
const changed = plan.changed;
console.log(`::notice::${changed.length} file(s) changed: ${changed.join(', ')}`);
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
  const mergeArgs = ['pr', 'merge', env.BRANCH, '--repo', env.TARGET_REPO, '--squash', '--delete-branch'];
  let merge = attempt('gh', [...mergeArgs, '--auto']);
  if (!merge.ok) {
    // `--auto` needs "Allow auto-merge" enabled on the target repository. Where
    // it is off, the queue request fails and the caller (self_fix) would wait
    // for a merge that can never happen. The branch has already passed this
    // job's own verification and the merge was approved before the run started,
    // so merge it directly instead.
    console.log(`::notice::Auto-merge is unavailable on ${env.TARGET_REPO}; merging the verified pull request directly.\n${merge.output.slice(-1000)}`);
    merge = attempt('gh', mergeArgs);
  }
  if (!merge.ok) {
    console.log(`::warning::Could not merge the pull request; it stays open for a manual merge.\n${merge.output.slice(-1000)}`);
  }
}
