// A minimal MCP client: JSON-RPC 2.0 over Streamable HTTP, enough for the two
// calls a tool-using agent actually makes — tools/list and tools/call.
//
// ponytail: hand-rolled instead of @modelcontextprotocol/sdk. The SDK carries
// stdio/SSE transports, OAuth, resources, prompts, and sampling; this repo is
// from-scratch by design and needs two methods against one HTTP endpoint.
// Swap in the SDK if we ever need stdio servers, resources, or elicitation.

const PROTOCOL_VERSION = '2025-06-18';

// A Streamable HTTP server may answer a POST with a plain JSON body or with an
// SSE stream that carries the same envelope in a `data:` line. Both are legal
// for a single request/response, so a client that reads only one of them works
// against half the servers in existence.
async function readEnvelope(response) {
  const text = await response.text();
  if (!text.trim()) return null;
  if (!/text\/event-stream/i.test(response.headers.get('content-type') || '')) {
    return JSON.parse(text);
  }
  let envelope = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    try {
      envelope = JSON.parse(line.slice(5).trim());
    } catch {
      /* keep-alive comments and partial frames are not envelopes */
    }
  }
  return envelope;
}

// Content parts are text, embedded resources, or binary. A file read comes back
// as a resource whose `text` is the file — handing the model the envelope
// instead makes it read JSON noise and guess at the contents.
function partText(part) {
  if (!part) return '';
  if (part.type === 'text') return part.text || '';
  if (part.type === 'resource') {
    const resource = part.resource || {};
    return resource.text || (resource.blob ? `[binary ${resource.mimeType || 'data'} at ${resource.uri || 'unknown'}]` : '');
  }
  return JSON.stringify(part);
}

export class McpClient {
  constructor({ url, headers = {}, fetchImpl = fetch, name = 'panda-bot' }) {
    this.url = url;
    this.headers = headers;
    this.fetchImpl = fetchImpl;
    this.name = name;
    this.sessionId = null;
    this.ready = null;
    this.nextId = 1;
  }

  async send(method, params, { notification = false } = {}) {
    const body = notification ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id: this.nextId++, method, params };
    const response = await this.fetchImpl(this.url, {
      method: 'POST',
      headers: {
        ...this.headers,
        'Content-Type': 'application/json',
        // Declaring both is what lets the server pick either shape above.
        Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': PROTOCOL_VERSION,
        ...(this.sessionId ? { 'Mcp-Session-Id': this.sessionId } : {}),
      },
      body: JSON.stringify(body),
    });

    // Handed out on initialize and required on every request after it.
    const session = response.headers.get('mcp-session-id');
    if (session) this.sessionId = session;
    if (notification) return null;

    if (!response.ok) {
      throw new Error(`MCP ${method} failed: HTTP ${response.status} ${(await response.text()).slice(0, 300)}`);
    }
    const envelope = await readEnvelope(response);
    if (envelope?.error) throw new Error(`MCP ${method} failed: ${envelope.error.message || JSON.stringify(envelope.error)}`);
    return envelope?.result ?? null;
  }

  // Cached as a promise, not a boolean: two tool calls firing at once must not
  // race two handshakes and leave one of them on a session the server dropped.
  connect() {
    this.ready ??= (async () => {
      await this.send('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: this.name, version: '1.0.0' },
      });
      await this.send('notifications/initialized', {}, { notification: true });
    })();
    return this.ready;
  }

  async listTools() {
    await this.connect();
    const result = await this.send('tools/list', {});
    return result?.tools || [];
  }

  // Returns text, never throws for a tool that merely failed: `isError` means
  // the call was made and the server said no, which the model can read and act
  // on. Only a broken transport or a malformed request throws.
  async callTool(name, args) {
    await this.connect();
    const result = await this.send('tools/call', { name, arguments: args || {} });
    const text = (result?.content || []).map(partText).filter(Boolean).join('\n').trim();
    if (result?.isError) return `The ${name} tool failed: ${text || 'no detail given.'}`;
    return text || JSON.stringify(result?.structuredContent ?? result ?? {});
  }
}

// MCP tool schemas are already JSON Schema, which is what OpenRouter's function
// calling wants — so this is a rename, not a translation.
export function toOpenRouterTools(mcpTools) {
  return (mcpTools || []).map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: String(tool.description || tool.name).slice(0, 1024),
      parameters: tool.inputSchema?.type ? tool.inputSchema : { type: 'object', properties: {} },
    },
  }));
}
