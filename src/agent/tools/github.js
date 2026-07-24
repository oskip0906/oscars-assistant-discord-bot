export const defs = [
  {
    type: 'function',
    function: {
      name: 'vault_fetch',
      description:
        "Read Oscar's private knowledge vault (GitHub repo oskip-vault) — the source of truth for anything about Oscar. No args: list the vault root. path: read that file (or list that directory). query: find file paths matching a keyword. Typical flow: query or root listing → fetch the matching file. Good starting points: 'index.md', 'Knowledge/Oscar Pang - Profile.md'.",
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: "File or directory path in the vault, e.g. 'Projects' or 'index.md'" },
          query: { type: 'string', description: 'Keyword to search file PATHS for (not contents)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'github',
      description:
        "OWNER ONLY. General GitHub REST API integration: call any GitHub REST endpoint, authenticated as Oscar (oskip0906) — this can read and modify Oscar's private repositories, so it is restricted to Oscar. Examples: GET /user/repos, GET /repos/{owner}/{repo}/issues, POST /repos/{owner}/{repo}/issues with body {title}. Endpoint must start with '/'. DO NOT use this to push local source changes or create commits (there is no POST …/commits endpoint — it 404s); to push Oscar's own source to GitHub use the git_push tool instead.",
      parameters: {
        type: 'object',
        properties: {
          method: { type: 'string', enum: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'], description: 'HTTP method (default GET)' },
          endpoint: { type: 'string', description: "API path starting with '/', e.g. /repos/oskip0906/oskip-vault/commits" },
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

export async function vaultFetch({ path: vaultPath, query }, invocation) {
  const repo = invocation.config.vaultRepo;

  if (query) {
    const { status, text } = await gh(invocation, `/repos/${repo}/git/trees/HEAD?recursive=1`);
    if (status !== 200) return `Vault tree fetch failed (HTTP ${status}).`;
    const tree = JSON.parse(text).tree || [];
    const q = String(query).toLowerCase();
    const matching = tree
      .filter((t) => t.type === 'blob' && t.path.toLowerCase().includes(q))
      .map((t) => t.path);
    if (!matching.length) {
      return `No vault file paths match "${query}". Try vault_fetch with no args to browse from the root, or fetch index.md (the catalog).`;
    }
    return `Vault files matching "${query}":\n${matching.slice(0, 40).join('\n')}\n\nCall vault_fetch with one of these paths to read it.`;
  }

  const endpoint = vaultPath
    ? `/repos/${repo}/contents/${encodeURI(vaultPath)}`
    : `/repos/${repo}/contents/`;
  const { status, text } = await gh(invocation, endpoint);
  if (status === 404) return `Not found in vault: ${vaultPath || '/'}`;
  if (status !== 200) return `Vault fetch failed (HTTP ${status}): ${text.slice(0, 300)}`;

  const data = JSON.parse(text);
  if (Array.isArray(data)) {
    return (
      `Contents of vault ${vaultPath || 'root'}:\n` +
      data.map((e) => `${e.type === 'dir' ? '📁' : '📄'} ${e.path}`).join('\n')
    );
  }
  const content = Buffer.from(data.content || '', 'base64').toString('utf8');
  return `# ${data.path}\n\n${content.slice(0, 8000)}${content.length > 8000 ? '\n…(truncated)' : ''}`;
}

// Low-level call used by BOTH the owner-only tool path and the /github slash
// command. `auth` decides whether Oscar's PAT is attached (see gh() above).
export async function githubCall({ method = 'GET', endpoint, body, auth = true }, invocation) {
  if (!endpoint || !String(endpoint).startsWith('/')) {
    return "endpoint must start with '/', e.g. /repos/oskip0906/oskip-vault/issues";
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
