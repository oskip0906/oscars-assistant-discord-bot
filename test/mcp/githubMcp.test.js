import test from 'node:test';
import assert from 'node:assert/strict';
import { githubMcpTools, callGithubMcpTool, resetGithubMcp } from '../../src/agent/tools/githubMcp.js';

const fakeClient = (tools, onCall = async () => 'ok') => ({
  listTools: async () => tools,
  callTool: async (name, args) => onCall(name, args),
});

const cfg = { githubPat: 'pat', githubMcpEnabled: true, githubMcpReadOnlyUrl: 'https://example.test/mcp/readonly' };

test.beforeEach(() => resetGithubMcp());

test('hides the GitHub tools from anyone who is not the owner', async () => {
  const client = fakeClient([{ name: 'get_commit', inputSchema: { type: 'object' } }]);

  assert.deepEqual(await githubMcpTools({ isOwner: false, config: cfg, client }), []);
  assert.equal((await githubMcpTools({ isOwner: true, config: cfg, client })).length, 1);
});

test('refuses to run a GitHub tool for a non-owner even if one is somehow called', async () => {
  const client = fakeClient([{ name: 'get_commit', inputSchema: { type: 'object' } }]);
  await githubMcpTools({ isOwner: true, config: cfg, client });

  const out = await callGithubMcpTool('get_commit', {}, { isOwner: false, config: cfg, client });
  assert.match(out, /Oscar/, 'it acts with Oscar’s PAT, so it must be owner-gated at execution too');
});

test('drops an MCP tool that would shadow a built-in tool name', async () => {
  const client = fakeClient([
    { name: 'web_search', inputSchema: { type: 'object' } },
    { name: 'get_commit', inputSchema: { type: 'object' } },
  ]);

  const names = (await githubMcpTools({ isOwner: true, config: cfg, client })).map((t) => t.function.name);
  assert.deepEqual(names, ['get_commit'], 'a shadowed built-in would silently stop working');
});

test('degrades to no tools when the MCP server is unreachable', async () => {
  const client = { listTools: async () => { throw new Error('ECONNREFUSED'); } };

  assert.deepEqual(await githubMcpTools({ isOwner: true, config: cfg, client }), [], 'the bot must still answer without GitHub');
});

test('stays off entirely when no PAT is configured', async () => {
  const client = fakeClient([{ name: 'get_commit', inputSchema: { type: 'object' } }]);

  assert.deepEqual(await githubMcpTools({ isOwner: true, config: { ...cfg, githubPat: '' }, client }), []);
});

test('fetches the tool list once and reuses it', async () => {
  let calls = 0;
  const client = { listTools: async () => { calls++; return [{ name: 'get_commit', inputSchema: { type: 'object' } }]; } };

  await githubMcpTools({ isOwner: true, config: cfg, client });
  await githubMcpTools({ isOwner: true, config: cfg, client });
  assert.equal(calls, 1);
});

test('routes a known tool call through to the MCP client', async () => {
  const seen = [];
  const client = fakeClient([{ name: 'get_commit', inputSchema: { type: 'object' } }], async (name, args) => {
    seen.push([name, args]);
    return 'commit body';
  });
  await githubMcpTools({ isOwner: true, config: cfg, client });

  assert.equal(await callGithubMcpTool('get_commit', { sha: 'abc' }, { isOwner: true, config: cfg, client }), 'commit body');
  assert.deepEqual(seen, [['get_commit', { sha: 'abc' }]]);
});
