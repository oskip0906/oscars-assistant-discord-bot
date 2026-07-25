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
    pulls++;
    return { status: 200, json: [{ number: 42, state: 'open', merged_at: pulls > 1 ? '2026-01-01T00:00:00Z' : null, html_url: 'https://example.test/pr/42' }] };
  };
  const result = await runDevelopmentSandbox(
    { repo: 'oskip0906/oscars-assistant-discord-bot', instruction: 'Fix the queue', model: 'openai/gpt-5.4-dev', selfFix: true, autoMerge: true, config },
    { gh, sleep: async () => {}, timeoutMs: 1_000 },
  );
  assert.equal(result.ok, true);
  const dispatch = calls.find((call) => call.method === 'POST');
  assert.equal(dispatch.body.inputs.auto_merge, 'true');
  assert.equal(dispatch.body.inputs.commit_title, '🛠️ Self-fix: Fix the queue');
  assert.match(dispatch.body.inputs.branch, /^panda-dev-/);
});
