import fs from 'node:fs';
import path from 'node:path';

// Shipping a self_fix as a pull request against remote main, using nothing but
// the GitHub REST API.
//
// Why not local git? The bot's checkout is a deployment, not a workspace. If
// self_fix committed there, the local branch would drift from origin/main and
// every later push would have to reconcile it. Building the commit server-side
// off the *current* remote main means the local checkout is only ever a
// consumer: it discards its edits and pulls the merged result back down.

const MERGE_RETRIES = 5;
const MERGE_RETRY_MS = 3000;

// Owner/name out of any remote URL form git might have been cloned with.
export function repoSlug(remoteUrl) {
  const m = String(remoteUrl || '')
    .trim()
    .match(/(?:github\.com[/:])([^/]+\/[^/]+?)(?:\.git)?\/?$/);
  return m ? m[1] : null;
}

// Read the working-tree state of `relPaths` into blobs for the tree builder.
// A path that no longer exists is a deletion, carried as content: null.
export function snapshotFiles(root, relPaths) {
  return relPaths.map((rel) => {
    const abs = path.join(root, rel);
    let stat;
    try {
      stat = fs.statSync(abs);
    } catch {
      return { path: rel, content: null, mode: '100644' };
    }
    // Only regular files are blobs. A directory or a symlink to one would throw
    // EISDIR on read and take the whole self_fix down with it.
    if (!stat.isFile()) return null;
    return {
      path: rel,
      content: fs.readFileSync(abs, 'utf8'),
      // Losing the exec bit here would ship a start script nobody can run.
      mode: stat.mode & 0o111 ? '100755' : '100644',
    };
  }).filter(Boolean);
}

// Create a branch off `base`, commit `files` onto it, open a PR, and merge it.
// `gh` is an injected `(method, endpoint, body) => {status, json}`.
//
// Never throws — resolves to {ok, number, url, sha, merged, detail} so the
// caller can put the outcome straight into a tool result.
export async function openAutoMergedPr({
  gh,
  slug,
  base = 'main',
  branchName,
  title,
  body,
  files,
  autoMerge = true,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  if (!files?.length) {
    return { ok: false, number: null, merged: false, detail: 'Nothing to ship — no changed files.' };
  }

  const fail = (step, res) =>
    ({ ok: false, number: null, merged: false, detail: `${step} failed (HTTP ${res.status}): ${describe(res)}` });

  const ref = await gh('GET', `/repos/${slug}/git/ref/heads/${base}`);
  if (ref.status !== 200) return fail(`Reading origin/${base}`, ref);
  const baseSha = ref.json?.object?.sha;

  const baseCommit = await gh('GET', `/repos/${slug}/git/commits/${baseSha}`);
  if (baseCommit.status !== 200) return fail('Reading the base commit', baseCommit);

  // Blobs first — a tree entry can only reference a sha that already exists.
  const entries = [];
  for (const file of files) {
    if (file.content === null) {
      entries.push({ path: file.path, mode: file.mode, type: 'blob', sha: null });
      continue;
    }
    const blob = await gh('POST', `/repos/${slug}/git/blobs`, {
      content: Buffer.from(file.content, 'utf8').toString('base64'),
      encoding: 'base64',
    });
    if (blob.status >= 300) return fail(`Uploading ${file.path}`, blob);
    entries.push({ path: file.path, mode: file.mode, type: 'blob', sha: blob.json.sha });
  }

  // base_tree makes this a delta against remote main: untouched files stay.
  const tree = await gh('POST', `/repos/${slug}/git/trees`, {
    base_tree: baseCommit.json?.tree?.sha,
    tree: entries,
  });
  if (tree.status >= 300) return fail('Building the tree', tree);

  const commit = await gh('POST', `/repos/${slug}/git/commits`, {
    message: title,
    tree: tree.json.sha,
    parents: [baseSha],
  });
  if (commit.status >= 300) return fail('Creating the commit', commit);

  const branchRef = await gh('POST', `/repos/${slug}/git/refs`, {
    ref: `refs/heads/${branchName}`,
    sha: commit.json.sha,
  });
  if (branchRef.status >= 300) return fail('Creating the branch', branchRef);

  const pr = await gh('POST', `/repos/${slug}/pulls`, { title, body, head: branchName, base });
  if (pr.status >= 300) {
    await deleteBranch(gh, slug, branchName);
    return fail('Opening the pull request', pr);
  }
  const number = pr.json.number;
  const url = pr.json.html_url;

  // Left open on purpose: the branch has to stay, or the PR closes with it.
  if (!autoMerge) {
    return { ok: true, number, url, merged: false, branch: branchName, detail: `PR #${number} opened against ${base}.` };
  }

  // GitHub computes mergeability asynchronously, so a PR opened a moment ago
  // can answer 405 "not mergeable" purely because it hasn't been checked yet.
  // Retry that; a real conflict keeps failing and is reported honestly.
  let merge;
  for (let attempt = 1; attempt <= MERGE_RETRIES; attempt++) {
    merge = await gh('PUT', `/repos/${slug}/pulls/${number}/merge`, {
      merge_method: 'squash',
      commit_title: `${title} (#${number})`,
    });
    if (merge.status === 200) break;
    if (merge.status !== 405 || attempt === MERGE_RETRIES) {
      return {
        ok: false,
        number,
        url,
        merged: false,
        detail: `PR #${number} opened but auto-merge failed (HTTP ${merge.status}): ${describe(merge)}`,
      };
    }
    await sleep(MERGE_RETRY_MS);
  }

  await deleteBranch(gh, slug, branchName);

  return {
    ok: true,
    number,
    url,
    merged: true,
    sha: merge.json?.sha ?? null,
    detail: `PR #${number} merged into ${base}.`,
  };
}

// Best effort: a leftover branch is cosmetic, and failing the whole self_fix
// over one would be worse than the mess.
async function deleteBranch(gh, slug, branchName) {
  try {
    await gh('DELETE', `/repos/${slug}/git/refs/heads/${branchName}`);
  } catch {
    /* ignore */
  }
}

function describe(res) {
  const message = res.json?.message;
  if (message) {
    const errors = Array.isArray(res.json.errors)
      ? ` ${res.json.errors.map((e) => e.message || e.code || '').filter(Boolean).join('; ')}`
      : '';
    return `${message}${errors}`.slice(0, 400);
  }
  return JSON.stringify(res.json ?? {}).slice(0, 400);
}
