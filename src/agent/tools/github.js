export const defs = [
  {
    type: 'function',
    function: {
      name: 'github',
      description:
        "OWNER ONLY. GitHub REST API WRITES, authenticated as Oscar (oskip0906): create or edit issues, comments, labels, releases and the like. Reads are not allowed here: use the GitHub MCP tools (get_file_contents, list_pull_requests, search_code, …) for anything that only looks. Endpoint must start with '/'. Example: POST /repos/{owner}/{repo}/issues with body {title}. Never use this to create source commits: use self_fix so code changes go through the approved remote sandbox.",
      parameters: {
        type: 'object',
        properties: {
          method: { type: 'string', enum: ['POST', 'PATCH', 'PUT', 'DELETE'], description: 'HTTP method' },
          endpoint: { type: 'string', description: "API path starting with '/', e.g. /repos/oskip0906/oscars-assistant-discord-bot/issues" },
          body: { type: 'object', description: 'JSON body for POST/PATCH/PUT' },
        },
        required: ['method', 'endpoint'],
      },
    },
  },
];

const WRITE_METHODS = ['POST', 'PATCH', 'PUT', 'DELETE'];

export async function githubApi({ method, endpoint, body }, invocation) {
  // Defense in depth: index.js already blocks non-owners from reaching this
  // tool at all (github is in OWNER_ONLY), but re-check here so the guard
  // survives even if the dispatch table changes.
  if (!invocation.isOwner) {
    return '⛔ github is restricted to Oscar (it uses his GitHub credentials). The current sender is not Oscar — refuse.';
  }
  const m = String(method || '').toUpperCase();
  if (!WRITE_METHODS.includes(m)) {
    return `github only writes (${WRITE_METHODS.join(', ')}). Reads go through the GitHub MCP tools, e.g. get_file_contents or list_pull_requests.`;
  }
  if (!endpoint || !String(endpoint).startsWith('/')) {
    return "endpoint must start with '/', e.g. /repos/oskip0906/oscars-assistant-discord-bot/issues";
  }
  if (!invocation.config.githubPat) return 'github is unavailable: GITHUB_PAT is not set.';
  const res = await fetch(`https://api.github.com${endpoint}`, {
    method: m,
    headers: {
      Authorization: `Bearer ${invocation.config.githubPat}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'panda-bot',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return `HTTP ${res.status}\n${text.slice(0, 6000)}${text.length > 6000 ? '\n…(truncated)' : ''}`;
}
