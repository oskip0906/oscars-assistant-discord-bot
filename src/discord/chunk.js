// Split reply text into Discord-sized messages (≤ limit chars), preferring the
// most natural boundary available so parts never cut mid-sentence when it can
// be avoided. Always returns at least one non-empty chunk.
//
// Boundary preference (best → worst), searched within the current window:
//   1. paragraph break  (blank line)
//   2. line break       (\n)
//   3. sentence end     (. ! ? … possibly followed by quotes/brackets + space)
//   4. word break       (whitespace)
//   5. hard cut         (mid-word — only when nothing better exists)
//
// If the text crossing a boundary sits inside a fenced code block (```), the
// open fence is closed at the end of the part and re-opened at the start of the
// next so each message renders as valid Markdown.
export function chunkMessage(text, limit = 2000) {
  let remaining = String(text ?? '').trim();
  if (!remaining) return ['🐼 …'];

  // Leave room so appending a closing code fence can't push a part over `limit`.
  const window = Math.max(1, limit - 4);

  const chunks = [];
  while (remaining.length > limit) {
    const cut = findCut(remaining, window);
    let head = remaining.slice(0, cut).trim();
    remaining = remaining.slice(cut).trim();

    // Balance code fences so neither part breaks Markdown rendering.
    const fence = openFence(head);
    if (fence !== null) {
      head = `${head}\n\`\`\``;
      remaining = `\`\`\`${fence}\n${remaining}`;
    }
    if (head) chunks.push(head);
  }
  if (remaining) chunks.push(remaining);

  const result = chunks.filter(Boolean);
  return result.length ? result : ['🐼 …'];
}

// Choose the index to cut `text` at, no later than `limit`. Prefers the latest
// natural boundary that keeps the part reasonably full (past 30% of the limit),
// falling back to a hard cut at `limit` when none qualifies.
function findCut(text, limit) {
  const floor = limit * 0.3;

  const paragraph = text.lastIndexOf('\n\n', limit);
  if (paragraph >= floor) return paragraph;

  const line = text.lastIndexOf('\n', limit);
  if (line >= floor) return line;

  const sentence = lastSentenceEnd(text, limit);
  if (sentence >= floor) return sentence;

  const space = text.lastIndexOf(' ', limit);
  if (space >= floor) return space;

  return limit; // no useful boundary — hard split
}

// Index just past the last sentence-ending punctuation at or before `limit`.
// Matches . ! ? or … optionally trailed by closing quotes/brackets, then a
// space or newline. Returns -1 when none found.
function lastSentenceEnd(text, limit) {
  const re = /[.!?…]["'”’)\]]*(?=\s)/g;
  let end = -1;
  let m;
  while ((m = re.exec(text)) !== null) {
    const idx = m.index + m[0].length;
    if (idx > limit) break;
    end = idx;
  }
  return end;
}

// If `text` ends inside an unterminated ``` fence, return the fence's info
// string (language, possibly empty) so it can be reopened; otherwise null.
function openFence(text) {
  const fences = text.match(/^```.*$/gm);
  if (!fences || fences.length % 2 === 0) return null;
  return fences[fences.length - 1].slice(3).trim();
}
