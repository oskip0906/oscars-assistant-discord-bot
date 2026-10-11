export const defs = [
  {
    type: 'function',
    function: {
      name: 'github',
      description:
        "OWNER ONLY. General GitHub REST API integration: call any GitHub REST endpoint, authenticated as Oscar (oskip0906) — this can read and modify Oscar's private repositories, so it is restricted to Oscar. Examples: GET /user/repos, GET /repos/{owner}/{repo}/issues, POST /repos/{owner}/{repo}/issues with body {title}. Endpoint must start with '/'. Never use this endpoint to create source commits: use self_fix so code changes go through the approved remote sandbox.",
      parameters: {
        type: 'object',
        properties: {
          method: { type: 'string', enum: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'], description: 'HTTP method (default GET)' },
          endpoint: { type: 'string', description: "API path starting with '/', e.g. /repos/oskip0906/oscars-assistant-discord-bot/commits" },
          body: { type: 'object', description: 'JSON body for POST/PATCH/PUT' },
        },
        required: ['endpoint'],
      },
    },
  },
];

// auth=false performs an UNAUTHENTICATED request (Oscar's PAT is never sent).
// This is how the /github slash command serves guests: public repos work,
// but Oscar's private repos naturally 404 since no credentials are attached.
async function gh(invocation, endpoint, { method = 'GET', body, auth = true } = {}) {
  const res = await fetch(`https://api.github.com${endpoint}`, {
    method,
    headers: {
      ...(auth && invocation.config.githubPat ? { Authorization: `Bearer ${invocation.config.githubPat}` } : {}),
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'panda-bot',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, text: await res.text() };
}

// Low-level call used by BOTH the owner-only tool path and the /github slash
// command. `auth` decides whether Oscar's PAT is attached (see gh() above).
export async function githubCall({ method = 'GET', endpoint, body, auth = true }, invocation) {
  if (!endpoint || !String(endpoint).startsWith('/')) {
    return "endpoint must start with '/', e.g. /repos/oskip0906/oscars-assistant-discord-bot/issues";
  }
  const m = String(method).toUpperCase();
  if (!['GET', 'POST', 'PATCH', 'PUT', 'DELETE'].includes(m)) return `Unsupported method: ${method}`;
  const { status, text } = await gh(invocation, endpoint, { method: m, body, auth });
  return `HTTP ${status}\n${text.slice(0, 6000)}${text.length > 6000 ? '\n…(truncated)' : ''}`;
}

export async function githubApi({ method = 'GET', endpoint, body }, invocation) {
  // Defense in depth: index.js already blocks non-owners from reaching this
  // tool at all (github is in OWNER_ONLY), but re-check here so the guard
  // survives even if the dispatch table changes.
  if (!invocation.isOwner) {
    return '⛔ github is restricted to Oscar (it uses his GitHub credentials). The current sender is not Oscar — refuse.';
  }
  return githubCall({ method, endpoint, body, auth: true }, invocation);
}
