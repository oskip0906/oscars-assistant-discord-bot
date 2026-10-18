import fs from 'node:fs';
import path from 'node:path';

// A development run outlives the process that started it: the sandbox keeps
// building, merging, and (for a self-fix) triggering the restart that kills the
// waiting bot. Without a record on disk, that run finished in silence — no
// finish line in the log, no word to Oscar, even though the pull request landed.
//
// One file, one run. Never throws: this sits directly in the self_fix path.
export class DevRunStore {
  constructor(dataDir) {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
    } catch {
      /* every method below tolerates an unusable file */
    }
    this.file = path.join(dataDir, 'development-run.json');
  }

  begin(run) {
    try {
      fs.writeFileSync(this.file, JSON.stringify(run));
    } catch (err) {
      console.error('[devRunStore] could not record the run:', err.message);
    }
  }

  end() {
    try {
      fs.rmSync(this.file, { force: true });
    } catch {
      /* already gone */
    }
  }

  read() {
    try {
      const run = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return run?.repo && run?.branch ? run : null;
    } catch {
      return null;
    }
  }
}

// Called on boot. If a run was in flight when this process's predecessor died,
// look up what became of its pull request and report it — the finish line the
// old process never got to log, plus a DM so a landed self-fix is not silent.
// `read` is githubReadJson: a GitHub MCP tool name and its arguments.
export async function resolveInterruptedRun({ store, read, log = console.log, notify = async () => {}, client, ownerId }) {
  const run = store.read();
  if (!run) return null;
  store.end();

  const [owner, repo] = run.repo.split('/');
  const pulls = await read('list_pull_requests', { owner, repo, state: 'all', head: `${owner}:${run.branch}`, perPage: 1 }).catch(() => null);
  const pr = Array.isArray(pulls) ? pulls[0] || null : null;
  const outcome = !pr ? 'unknown-after-restart' : pr.merged_at ? 'merged-during-restart' : pr.state === 'closed' ? 'closed-during-restart' : 'pull-request-open';

  log(
    [
      `[panda] ${run.kind || 'self_fix'} finish outcome=${outcome}`,
      `repo=${run.repo}`,
      pr?.number ? `pr=${pr.number}` : '',
      pr?.html_url ? `url=${pr.html_url}` : '',
      'note="resumed after a restart"',
    ]
      .filter(Boolean)
      .join(' '),
  );

  if (pr) {
    const headline = outcome === 'merged-during-restart' ? '✅ landed while I was restarting' : outcome === 'closed-during-restart' ? '🚫 was closed without merging' : '⏳ is still open';
    await notify(client, ownerId, `🛠️ **The ${run.kind || 'development'} run I was waiting on ${headline}.**\n${pr.html_url}`).catch(() => {});
  }
  return { outcome, pr };
}
