import { readFileSync } from 'node:fs';
import path from 'node:path';

// Paths the sandbox may never read or write: git internals, dependencies,
// runtime data, secrets, and the workflow that runs the sandbox itself.
export const FORBIDDEN = /(^|\/)(\.git|node_modules|data)(\/|$)|(^|\/)\.env(?:\.|$)|^\.github\//i;

// Lockfiles and vendored blobs are megabytes of noise that would swallow the
// whole budget; nothing the model is asked to do needs to read them in full.
const MAX_FILE_BYTES = 60_000;

// ~150k tokens of source. The old 140k-character budget was smaller than this
// repository's own src/ directory, so a self-fix could not see the code it was
// being asked to change.
const DEFAULT_BUDGET = 600_000;

// Source first, then manifests and docs, then tests. Plain alphabetical order
// spent the budget on README and context/ before reaching src/, and on test/
// files that no instruction was about.
function priority(file) {
  if (file.startsWith('src/')) return 0;
  if (file.startsWith('test/')) return 2;
  return 1;
}

// Returns { files, omitted }. A file is included whole or not at all: the model
// is asked to reply with complete file contents, and it cannot do that for a
// file it was shown half of. `omitted` is handed to the model too, so a task it
// cannot complete from the snapshot is something it can say out loud instead of
// guessing at contents it never saw.
export function buildSnapshot(root, tracked, { budget = DEFAULT_BUDGET, read = readFileSync } = {}) {
  const eligible = tracked
    .filter((file) => file && !FORBIDDEN.test(file))
    .map((file, index) => ({ file, index }))
    .sort((a, b) => priority(a.file) - priority(b.file) || a.index - b.index);

  const files = [];
  const omitted = [];
  let remaining = budget;

  for (const { file } of eligible) {
    let content;
    try {
      const raw = read(path.join(root, file));
      if (raw.length > MAX_FILE_BYTES) {
        omitted.push(file);
        continue;
      }
      content = raw.toString('utf8');
    } catch {
      omitted.push(file);
      continue;
    }
    // Binary blobs (images, fonts) carry nothing the model can edit.
    if (content.includes('\0')) continue;
    if (content.length > remaining) {
      omitted.push(file);
      continue;
    }
    files.push({ path: file, content });
    remaining -= content.length;
  }

  return { files, omitted };
}
