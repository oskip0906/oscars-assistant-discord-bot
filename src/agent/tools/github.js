import { getAIConfig } from '../../configManager.js';
import { selfFixState } from '../../selfFixState.js';
import { requestDevelopmentApproval } from './source.js';
import { runDevelopmentSandbox } from './developmentSandbox.js';
import { dmOwner } from '../../discord/notify.js';
import { startDevRunLog } from '../../devRunLog.js';

const repoChoiceCache = {};

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
        "OWNER ONLY. General GitHub REST API integration: call any GitHub REST endpoint, authenticated as Oscar (oskip0906) — this can read and modify Oscar's private repositories, so it is restricted to Oscar. Examples: GET /user/repos, GET /repos/{owner}/{repo}/issues, POST /repos/{owner}/{repo}/issues with body {title}. Endpoint must start with '/'. Never use this endpoint to create source commits: use create_pr or self_fix so code changes go through the approved remote sandbox.",
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
  {
    type: 'function',
    function: {
      name: 'create_pr',
      description:
        'OWNER ONLY. Request a source change on any permitted GitHub repository. Panda first presents Oscar with Discord approval buttons. After approval, the configured OpenRouter development model works only in an isolated GitHub Actions sandbox, verifies the change, and opens a pull request. It waits for a merge; auto-merge is enabled only for Panda’s own repository.',
      parameters: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: "Target repo, 'owner/name' or just 'name' for one of Oscar's own" },
          instruction: { type: 'string', description: 'The requested source-code change' },
          base: { type: 'string', description: "Branch to target (default: the repo's default branch)" },
        },
        required: ['repo', 'instruction'],
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

// Lists repositories the configured account can push to. This is deliberately
// separate from public repository search: autocomplete must never leak private
// repo names to a guest and only offers repositories usable by the sandbox.
export async function listWritableRepos(config, { fetchImpl = fetch } = {}) {
  if (!config.githubPat) return [];
  const repos = [];
  for (let page = 1; page <= 100; page++) {
    const res = await fetchImpl(
      `https://api.github.com/user/repos?affiliation=owner,collaborator,organization&per_page=100&page=${page}&sort=full_name`,
      {
        headers: {
          Authorization: `Bearer ${config.githubPat}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'panda-bot',
        },
      },
    );
    if (!res.ok) return [];
    const pageRepos = await res.json();
    repos.push(...pageRepos.filter((repo) => repo.permissions?.push || repo.permissions?.admin || repo.permissions?.maintain));
    if (pageRepos.length < 100) break;
  }
  return [...new Set(repos.map((repo) => repo.full_name).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

export async function writableRepoChoices(config, focused = '', { listRepos = listWritableRepos, cache = repoChoiceCache } = {}) {
  const now = Date.now();
  if (!cache.repos || now - cache.at > 5 * 60 * 1000) {
    try {
      cache.repos = await listRepos(config);
      cache.at = now;
    } catch {
      return [];
    }
  }
  const query = String(focused).trim().toLowerCase();
  return cache.repos
    .filter((repo) => !query || repo.toLowerCase().includes(query))
    .slice(0, 25)
    .map((repo) => ({ name: repo.slice(0, 100), value: repo.slice(0, 100) }));
}

// Development changes on any repository use the same remote-only sandbox as
// self_fix. The bot never receives full replacement file contents or creates a
// source commit from its own process.
export async function createPr(
  { repo, instruction, base },
  invocation,
  {
    runSandbox = runDevelopmentSandbox,
    confirm = requestDevelopmentApproval,
    state = selfFixState,
    getConfig = getAIConfig,
    notify = dmOwner,
    startLog = startDevRunLog,
  } = {},
) {
  if (!invocation.isOwner) {
    return '⛔ create_pr is restricted to Oscar (it writes to his repos with his credentials). The current sender is not Oscar — refuse.';
  }
  if (!repo || !instruction) return '⚠️ create_pr needs both `repo` and `instruction`.';

  // A bare name means one of Oscar's own repos; the vault slug is where his
  // account name already lives in config.
  const owner = String(invocation.config.vaultRepo || '').split('/')[0] || 'oskip0906';
  const slug = String(repo).includes('/') ? String(repo).replace(/^\/+|\/+$/g, '') : `${owner}/${repo}`;

  const { model } = getConfig('development');
  // Logged before the approval prompt so the log shows the request that was
  // never approved, not just the runs that made it to the sandbox.
  const logFinish = startLog('run_dev', { repo: slug, base, model, task: instruction });

  const outcome = await confirm({ instruction, invocation, state, model, label: `Development PR for ${slug}` });
  if (outcome !== 'confirm') {
    logFinish('aborted', { reason: 'not approved with the Discord button' });
    return '🚫 Development PR aborted — it was not approved with the Discord button.';
  }

  state.begin();
  try {
    const result = await runSandbox({
      repo: slug,
      instruction,
      model,
      base,
      // /run_dev and the assistant-facing create_pr tool always leave review
      // to Oscar. Only self_fix is allowed to request automatic merging.
      autoMerge: false,
      selfFix: false,
      config: invocation.config,
      onPullRequest: async (pr) => {
        await notify(invocation.client, invocation.config.ownerId, `🛠️ Development PR #${pr.number}: ${pr.html_url}`).catch(() => {});
      },
    });
    // /run_dev never auto-merges, so an open pull request is the successful
    // outcome here — only a run that produced no pull request at all failed.
    const outcomeName = result.ok ? 'merged' : result.pr ? 'pull-request-open' : 'failed';
    logFinish(outcomeName, { pr: result.pr?.number, url: result.pr?.html_url, detail: result.summary });
    return result.summary;
  } catch (err) {
    logFinish('crashed', { detail: String(err.message || err) });
    throw err;
  } finally {
    state.end();
  }
}
