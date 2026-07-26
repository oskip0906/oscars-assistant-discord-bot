import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDevelopmentSandbox, selfFixCommitTitle } from '../src/agent/tools/developmentSandbox.js';

const config = {
  githubPat: 'token',
  developmentSandboxRepo: 'oskip0906/oscars-assistant-discord-bot',
  developmentSandboxWorkflow: 'development-sandbox.yml',
  developmentSandboxRef: 'main',
};

test('self-fix commit titles have the required prefix', () => {
  assert.equal(selfFixCommitTitle('  repair  the   music queue '), '🛠️ Self-fix: repair the music queue');
});

test('dispatches a remote workflow and waits until its self-fix PR is merged', async () => {
  const calls = [];
  let pulls = 0;
  const gh = async (method, endpoint, body) => {
    calls.push({ method, endpoint, body });
    if (endpoint === '/repos/oskip0906/oscars-assistant-discord-bot') return { status: 200, json: { default_branch: 'main' } };
    if (method === 'POST') return { status: 204, json: {} };
    if (endpoint.includes('/actions/workflows/')) return { status: 200, json: { workflow_runs: [] } };
    pulls++;
    return { status: 200, json: [{ number: 42, state: 'open', merged_at: pulls > 1 ? '2026-01-01T00:00:00Z' : null, html_url: 'https://example.test/pr/42' }] };
  };
  const observed = [];
  const result = await runDevelopmentSandbox(
    {
      repo: 'oskip0906/oscars-assistant-discord-bot',
      instruction: 'Fix the queue',
      model: 'openai/gpt-5.4-dev',
      selfFix: true,
      autoMerge: true,
      config,
      onPullRequest: async (pr) => observed.push(pr.number),
    },
    { gh, sleep: async () => {}, timeoutMs: 1_000 },
  );
  assert.equal(result.ok, true);
  const dispatch = calls.find((call) => call.method === 'POST');
  assert.equal(dispatch.body.inputs.auto_merge, 'true');
  assert.equal(dispatch.body.inputs.commit_title, '🛠️ Self-fix: Fix the queue');
  assert.match(dispatch.body.inputs.branch, /^panda-dev-/);
  assert.deepEqual(observed, [42]);
});

test('reports a failed sandbox run instead of waiting for a pull request that never arrives', async () => {
  let requestId = '';
  const gh = async (method, endpoint, body) => {
    if (endpoint === '/repos/oskip0906/portfolio') return { status: 200, json: { default_branch: 'main' } };
    if (method === 'POST') {
      requestId = body.inputs.request_id;
      return { status: 204, json: {} };
    }
    if (endpoint.includes('/actions/workflows/')) {
      return {
        status: 200,
        json: {
          workflow_runs: [
            { id: 1, name: 'Development sandbox other', status: 'completed', conclusion: 'success', html_url: 'https://example.test/run/1' },
            { id: 2, name: `Development sandbox ${requestId}`, status: 'completed', conclusion: 'failure', html_url: 'https://example.test/run/2' },
          ],
        },
      };
    }
    if (endpoint.includes('/actions/runs/2/jobs')) {
      return {
        status: 200,
        json: {
          jobs: [
            {
              steps: [
                { name: 'Run actions/checkout@v4', conclusion: 'success' },
                { name: 'Check sandbox credentials', conclusion: 'failure' },
                { name: 'Create isolated target checkout', conclusion: 'skipped' },
              ],
            },
          ],
        },
      };
    }
    return { status: 200, json: [] };
  };
  const result = await runDevelopmentSandbox(
    { repo: 'oskip0906/portfolio', instruction: 'Tidy the footer', model: 'openai/gpt-5.4-dev', config },
    { gh, sleep: async () => {}, timeoutMs: 60_000 },
  );
  assert.equal(result.ok, false);
  assert.match(result.summary, /run failure before opening a pull request/);
  // The step name is what turns "it failed" into something Oscar can fix.
  assert.match(result.summary, /stopped at the "Check sandbox credentials" step/);
  assert.match(result.summary, /https:\/\/example\.test\/run\/2/);
});

test('keeps polling while the sandbox run is still in progress', async () => {
  let polls = 0;
  const gh = async (method, endpoint) => {
    if (endpoint === '/repos/oskip0906/portfolio') return { status: 200, json: { default_branch: 'main' } };
    if (method === 'POST') return { status: 204, json: {} };
    if (endpoint.includes('/actions/workflows/')) {
      polls++;
      return { status: 200, json: { workflow_runs: [{ name: 'Development sandbox', status: 'in_progress', conclusion: null }] } };
    }
    return { status: 200, json: [] };
  };
  let clock = 0;
  const result = await runDevelopmentSandbox(
    { repo: 'oskip0906/portfolio', instruction: 'Tidy the footer', model: 'openai/gpt-5.4-dev', config },
    { gh, sleep: async () => { clock += 5_000; }, now: () => clock, timeoutMs: 20_000 },
  );
  assert.equal(result.ok, false);
  assert.match(result.summary, /did not open a pull request before timing out/);
  assert.equal(polls, 4);
});
