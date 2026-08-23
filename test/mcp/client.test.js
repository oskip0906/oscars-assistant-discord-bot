import test from 'node:test';
import assert from 'node:assert/strict';
import { McpClient, toOpenRouterTools } from '../../src/agent/mcp.js';

// A fake transport that records what was posted and replies from a script.
function fakeFetch(script) {
  const sent = [];
  const impl = async (url, options) => {
    const body = JSON.parse(options.body);
    sent.push({ url, headers: options.headers, body });
    const reply = script[body.method];
    if (!reply) return new Response('', { status: 202 });
    return typeof reply === 'function' ? reply(body) : reply(body);
  };
  return { impl, sent };
}

const json = (payload, headers = {}) =>
  new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json', ...headers } });

const sse = (payload) =>
  new Response(`event: message\ndata: ${JSON.stringify(payload)}\n\n`, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });

const TOOLS = [
  {
    name: 'get_file_contents',
    description: 'Read a file from a repository',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
];

test('handshakes, then reuses the session id the server handed back', async () => {
  const { impl, sent } = fakeFetch({
    initialize: (req) => json({ jsonrpc: '2.0', id: req.id, result: { protocolVersion: '2025-06-18' } }, { 'mcp-session-id': 'sess-42' }),
    'tools/list': (req) => json({ jsonrpc: '2.0', id: req.id, result: { tools: TOOLS } }),
  });
  const client = new McpClient({ url: 'https://example.test/mcp/', headers: { Authorization: 'Bearer t' }, fetchImpl: impl });

  await client.listTools();

  assert.equal(sent[0].body.method, 'initialize');
  assert.equal(sent[1].body.method, 'notifications/initialized');
  assert.equal(sent[2].body.method, 'tools/list');
  assert.equal(sent[2].headers['Mcp-Session-Id'], 'sess-42', 'session id must ride on later requests');
  assert.equal(sent[2].headers.Authorization, 'Bearer t', 'auth header must ride on every request');
});

test('handshakes only once across several calls', async () => {
  const { impl, sent } = fakeFetch({
    initialize: (req) => json({ jsonrpc: '2.0', id: req.id, result: {} }),
    'tools/list': (req) => json({ jsonrpc: '2.0', id: req.id, result: { tools: TOOLS } }),
  });
  const client = new McpClient({ url: 'https://example.test/mcp/', fetchImpl: impl });

  await client.listTools();
  await client.listTools();

  assert.equal(sent.filter((r) => r.body.method === 'initialize').length, 1);
});

test('reads a result delivered as an SSE stream', async () => {
  const { impl } = fakeFetch({
    initialize: (req) => json({ jsonrpc: '2.0', id: req.id, result: {} }),
    'tools/call': (req) => sse({ jsonrpc: '2.0', id: req.id, result: { content: [{ type: 'text', text: 'file body' }] } }),
  });
  const client = new McpClient({ url: 'https://example.test/mcp/', fetchImpl: impl });

  assert.equal(await client.callTool('get_file_contents', { path: 'a.js' }), 'file body');
});

test('turns a JSON-RPC error into a thrown Error carrying the server message', async () => {
  const { impl } = fakeFetch({
    initialize: (req) => json({ jsonrpc: '2.0', id: req.id, result: {} }),
    'tools/call': (req) => json({ jsonrpc: '2.0', id: req.id, error: { code: -32602, message: 'repo not found' } }),
  });
  const client = new McpClient({ url: 'https://example.test/mcp/', fetchImpl: impl });

  await assert.rejects(() => client.callTool('get_file_contents', {}), /repo not found/);
});

test('reports a tool-level failure as text rather than throwing', async () => {
  const { impl } = fakeFetch({
    initialize: (req) => json({ jsonrpc: '2.0', id: req.id, result: {} }),
    'tools/call': (req) => json({ jsonrpc: '2.0', id: req.id, result: { isError: true, content: [{ type: 'text', text: 'no such path' }] } }),
  });
  const client = new McpClient({ url: 'https://example.test/mcp/', fetchImpl: impl });

  const out = await client.callTool('get_file_contents', { path: 'nope' });
  assert.match(out, /no such path/, 'the model needs to read the failure and try again');
});

test('converts MCP tool schemas into OpenRouter tool definitions', () => {
  const [tool] = toOpenRouterTools(TOOLS);
  assert.equal(tool.type, 'function');
  assert.equal(tool.function.name, 'get_file_contents');
  assert.equal(tool.function.description, 'Read a file from a repository');
  assert.deepEqual(tool.function.parameters, TOOLS[0].inputSchema);
});

test('gives a schemaless tool an empty object schema so the model can still call it', () => {
  const [tool] = toOpenRouterTools([{ name: 'whoami' }]);
  assert.equal(tool.function.parameters.type, 'object');
});

test('unwraps an embedded resource so the model reads the file, not the envelope', async () => {
  const { impl } = fakeFetch({
    initialize: (req) => json({ jsonrpc: '2.0', id: req.id, result: {} }),
    'tools/call': (req) =>
      json({
        jsonrpc: '2.0',
        id: req.id,
        result: {
          content: [
            { type: 'text', text: 'successfully downloaded text file' },
            { type: 'resource', resource: { uri: 'repo://x/package.json', mimeType: 'text/plain', text: '{"name":"panda-bot"}' } },
          ],
        },
      }),
  });
  const client = new McpClient({ url: 'https://example.test/mcp/', fetchImpl: impl });

  const out = await client.callTool('get_file_contents', { path: 'package.json' });
  assert.match(out, /"name":"panda-bot"/, 'the file body must survive');
  assert.doesNotMatch(out, /mimeType/, 'the envelope must not reach the model as noise');
});
