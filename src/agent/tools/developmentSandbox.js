import { randomUUID } from 'node:crypto';

const API = 'https://api.github.com';
const POLL_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;

function cleanRepo(value) {
  const repo = String(value || '').replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/^\/+|\/+$/g, '');
  return /^[^/\s]+\/[^/\s]+$/.test(repo) ? repo : null;
}

function responseText(json) {
  return json?.message || JSON.stringify(json || {}).slice(0, 500);
}

export function shortTask(instruction, limit = 60) {
  return String(instruction || '').replace(/\s+/g, ' ').trim().replace(/[\r\n]/g, ' ').slice(0, limit) || 'update source';
}

export function selfFixCommitTitle(instruction) {
  return `🛠️ Self-fix: ${shortTask(instruction)}`;
}

export function githubRequest(pat) {
  return async (method, endpoint, body) => {
    const res = await fetch(`${API}${endpoint}`, {
      method,
      headers: {
        ...(pat ? { Authorization: `Bearer ${pat}` } : {}),
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'panda-bot-development-sandbox',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { message: text.slice(0, 500) };
    }
    return { status: res.status, json };
  };
}

async function defaultBranch(gh, repo) {
  const res = await gh('GET', `/repos/${repo}`);
  return res.status === 200 ? res.json?.default_branch || 'main' : null;
}

// The workflow names its run after the request id, so a run that dies before it
// can open a PR (a missing secret, a rejected push) is reported in seconds
// instead of stalling the caller for the full timeout.
async function failedRun(gh, sandboxRepo, workflow, requestId) {
  const result = await gh('GET', `/repos/${sandboxRepo}/actions/workflows/${encodeURIComponent(workflow)}/runs?event=workflow_dispatch&per_page=20`);
  if (result.status !== 200) return null;
  const run = (result.json?.workflow_runs || []).find((candidate) =>
    [candidate?.name, candidate?.display_title].some((value) => String(value || '').includes(requestId)),
  );
  return run && run.status === 'completed' && run.conclusion !== 'success' ? run : null;
}

async function waitForPullRequest({ gh, repo, branch, timeoutMs, sleep, now, onPullRequest = () => {}, sandboxRepo, workflow, requestId }) {
  const [owner] = repo.split('/');
  const deadline = now() + timeoutMs;
  let pr = null;
  let reported = false;
  while (now() < deadline) {
    const result = await gh('GET', `/repos/${repo}/pulls?state=all&head=${encodeURIComponent(`${owner}:${branch}`)}&per_page=1`);
    if (result.status === 200 && result.json?.[0]) {
      pr = result.json[0];
      if (!reported) {
        reported = true;
        await onPullRequest(pr);
      }
      if (pr.merged_at) return { ok: true, pr, merged: true };
      if (pr.state === 'closed') return { ok: false, pr, merged: false, detail: 'The pull request was closed without merging.' };
    }
    if (!pr) {
      const failed = await failedRun(gh, sandboxRepo, workflow, requestId);
      if (failed) {
        return { ok: false, detail: `The remote development sandbox run ${failed.conclusion} before opening a pull request.\n${failed.html_url || ''}`.trim() };
      }
    }
    await sleep(POLL_MS);
  }
  if (!pr) return { ok: false, detail: 'The remote development sandbox did not open a pull request before timing out.' };
  return { ok: false, pr, merged: false, detail: 'The pull request is still open and awaiting merge.' };
}

// Dispatches the only environment permitted to edit source: the GitHub Actions
// sandbox. The bot process merely asks, observes, and (for its own repository)
// restarts after the PR actually merges.
export async function runDevelopmentSandbox(
  { repo, instruction, model, base, autoMerge = false, selfFix = false, config, onPullRequest },
  { gh = githubRequest(config.githubPat), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now, timeoutMs = DEFAULT_TIMEOUT_MS } = {},
) {
  const targetRepo = cleanRepo(repo);
  const sandboxRepo = cleanRepo(config.developmentSandboxRepo);
  if (!targetRepo) return { ok: false, summary: '❌ A target repository in `owner/name` form is required.' };
  if (!sandboxRepo) return { ok: false, summary: '❌ DEVELOPMENT_SANDBOX_REPO must be set to `owner/name`.' };
  if (!config.githubPat) return { ok: false, summary: '❌ GITHUB_PAT is required to dispatch and observe the development sandbox.' };

  const targetBase = base || (await defaultBranch(gh, targetRepo));
  if (!targetBase) return { ok: false, summary: `❌ Could not read the default branch for \`${targetRepo}\`.` };

  const requestId = randomUUID().replace(/-/g, '').slice(0, 16);
  const branch = `panda-dev-${requestId}`;
  const commitTitle = selfFix ? selfFixCommitTitle(instruction) : `🛠️ Development: ${shortTask(instruction)}`;
  const dispatch = await gh('POST', `/repos/${sandboxRepo}/actions/workflows/${encodeURIComponent(config.developmentSandboxWorkflow)}/dispatches`, {
    ref: config.developmentSandboxRef,
    inputs: {
      target_repo: targetRepo,
      base: targetBase,
      instruction: String(instruction).slice(0, 8_000),
      model: String(model),
      request_id: requestId,
      branch,
      commit_title: commitTitle,
      auto_merge: String(Boolean(autoMerge)),
      self_fix: String(Boolean(selfFix)),
    },
  });
  if (dispatch.status !== 204) {
    return { ok: false, summary: `❌ Could not start the remote development sandbox (HTTP ${dispatch.status}): ${responseText(dispatch.json)}` };
  }

  const waited = await waitForPullRequest({
    gh,
    repo: targetRepo,
    branch,
    timeoutMs,
    sleep,
    now,
    onPullRequest,
    sandboxRepo,
    workflow: config.developmentSandboxWorkflow,
    requestId,
  });
  const url = waited.pr?.html_url ? `\n${waited.pr.html_url}` : '';
  if (!waited.ok) return { ok: false, summary: `⚠️ ${waited.detail || 'Development sandbox failed.'}${url}`, pr: waited.pr };
  return {
    ok: true,
    summary: `✅ Remote sandbox opened and merged PR #${waited.pr.number} into \`${targetBase}\`.\n${waited.pr.html_url}`,
    pr: waited.pr,
  };
}
