import { randomUUID } from 'node:crypto';
import { config as botConfig } from '../../config.js';
import { DevRunStore } from '../../devRunStore.js';

export const devRunStore = new DevRunStore(botConfig.dataDir);

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

// "The run failed" is not something Oscar can act on from Discord. The step
// name is: a missing secret dies in "Check sandbox credentials", a rejected
// push in "Develop, verify, and open pull request".
async function failedStep(gh, sandboxRepo, runId) {
  if (!runId) return null;
  const result = await gh('GET', `/repos/${sandboxRepo}/actions/runs/${runId}/jobs?per_page=20`);
  if (result.status !== 200) return null;
  for (const job of result.json?.jobs || []) {
    const step = (job.steps || []).find((candidate) => candidate?.conclusion && !['success', 'skipped'].includes(candidate.conclusion));
    if (step?.name) return step.name;
  }
  return null;
}

// waitForMerge is false for everything except self_fix. A development PR is
// reviewed and merged by hand, so an open PR is that run's finished state —
// polling on for a merge that needs a human would block the agent loop (and the
// caller's Discord interaction token) for the full timeout after the work landed.
async function waitForPullRequest({ gh, repo, branch, timeoutMs, sleep, now, onPullRequest = () => {}, sandboxRepo, workflow, requestId, waitForMerge = true }) {
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
      if (!waitForMerge) return { ok: true, pr, merged: false };
      if (pr.state === 'closed') return { ok: false, pr, merged: false, detail: 'The pull request was closed without merging.' };
    }
    if (!pr) {
      const failed = await failedRun(gh, sandboxRepo, workflow, requestId);
      if (failed) {
        const step = await failedStep(gh, sandboxRepo, failed.id);
        return {
          ok: false,
          detail: [
            `The remote development sandbox run ${failed.conclusion} before opening a pull request.`,
            step ? `It stopped at the "${step}" step.` : '',
            failed.html_url || '',
          ]
            .filter(Boolean)
            .join('\n'),
        };
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
  { repo, instruction, model, base, autoMerge = false, selfFix = false, config, onPullRequest, commitTitle },
  { gh = githubRequest(config.githubPat), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now, timeoutMs = DEFAULT_TIMEOUT_MS, store = devRunStore } = {},
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
  // Use the provided commit title, or fall back to the automatic one.
  const commitTitle_ = commitTitle || (selfFix ? selfFixCommitTitle(instruction) : `🛠️ Development: ${shortTask(instruction)}`);
  const dispatch = await gh('POST', `/repos/${sandboxRepo}/actions/workflows/${encodeURIComponent(config.developmentSandboxWorkflow)}/dispatches`, {
    ref: config.developmentSandboxRef,
    inputs: {
      target_repo: targetRepo,
      base: targetBase,
      instruction: String(instruction).slice(0, 8_000),
      model: String(model),
      request_id: requestId,
      branch,
      commit_title: commitTitle_,
      auto_merge: String(Boolean(autoMerge)),
      self_fix: String(Boolean(selfFix)),
    },
  });
  if (dispatch.status !== 204) {
    return { ok: false, summary: `❌ Could not start the remote development sandbox (HTTP ${dispatch.status}): ${responseText(dispatch.json)}` };
  }

  // From here the run outlives this process: a self-fix ends by restarting the
  // bot that is waiting on it. Recorded so the next boot can report what became
  // of it instead of the run finishing in silence.
  store?.begin({ kind: selfFix ? 'self_fix' : 'run_dev', repo: targetRepo, branch, base: targetBase, requestId });

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
    waitForMerge: Boolean(autoMerge),
  });
  // This process saw the run through and is about to report it, so there is
  // nothing left for the next boot to pick up. The record only outlives this
  // line when the process itself does not — which is the case it exists for.
  store?.end();

  const url = waited.pr?.html_url ? `\n${waited.pr.html_url}` : '';
  if (!waited.ok) return { ok: false, merged: false, summary: `⚠️ ${waited.detail || 'Development sandbox failed.'}${url}`, pr: waited.pr };
  return {
    ok: true,
    merged: waited.merged,
    summary: waited.merged
      ? `✅ Remote sandbox opened and merged PR #${waited.pr.number} into \`${targetBase}\`.\n${waited.pr.html_url}`
      : `✅ Remote sandbox opened PR #${waited.pr.number} against \`${targetBase}\`. Review and merge it when you're happy with it.\n${waited.pr.html_url}`,
    pr: waited.pr,
  };
}
