import test from 'node:test';
import assert from 'node:assert/strict';
import { runDevelopmentSandbox } from '../src/agent/tools/developmentSandbox.js';

const config = { githubPat: 'pat', developmentSandboxRepo: 'owner/sandbox', developmentSandboxWorkflow: 'development-sandbox.yml', developmentSandboxRef: 'main' };
const dispatchOnly = async (method) => {
  assert.equal(method, 'POST', 'REST is only for the dispatch; reads go through MCP');
  return { status: 204, json: null };
};
const options = (read) => ({ gh: dispatchOnly, read, sleep: async () => {}, store: null });

test('reads the default branch and the merged pull request over MCP', async () => {
  const reads = [];
  const read = async (name, args) => {
    reads.push(name);
    if (name === 'search_repositories') return { items: [{ full_name: 'Owner/Target', default_branch: 'trunk' }] };
    if (name === 'list_pull_requests') {
      assert.match(args.head, /^owner:panda-dev-/);
      return [{ number: 7, merged_at: '2026-10-11T00:00:00Z', html_url: 'https://github.com/owner/target/pull/7' }];
    }
    throw new Error(`unexpected ${name}`);
  };
  const result = await runDevelopmentSandbox({ repo: 'owner/target', instruction: 'x', model: 'm', autoMerge: true, config }, options(read));
  assert.equal(result.ok, true);
  assert.equal(result.merged, true);
  assert.match(result.summary, /`trunk`/);
  assert.deepEqual(reads, ['search_repositories', 'list_pull_requests']);
});

test('names the failed step of a run that died before opening a pull request', async () => {
  let requestId;
  const gh = async (method, endpoint, body) => {
    requestId = body.inputs.request_id;
    return dispatchOnly(method);
  };
  const read = async (name, args) => {
    if (name === 'list_pull_requests') return [];
    if (args.method === 'list_workflow_runs') {
      return { workflow_runs: [{ id: 1, display_title: `Development sandbox ${requestId}`, status: 'completed', conclusion: 'failure', html_url: 'u' }] };
    }
    // The MCP server nests GitHub's {total_count, jobs} under another `jobs`.
    if (args.method === 'list_workflow_jobs') return { jobs: { jobs: [{ steps: [{ name: 'Check sandbox credentials', conclusion: 'failure' }] }] } };
    throw new Error(`unexpected ${name}`);
  };
  const result = await runDevelopmentSandbox({ repo: 'owner/target', base: 'main', instruction: 'x', model: 'm', config }, { ...options(read), gh });
  assert.equal(result.ok, false);
  assert.match(result.summary, /"Check sandbox credentials"/);
});
