// At most one reaction from Panda per message, however many things want to add
// one (several react calls in a turn, a wave, the 👀 fallback). Every reaction
// Panda adds goes through reactOnce, which claims the message before calling
// Discord, so concurrent or later attempts on it add nothing. A failed call
// (missing permission, deleted message, bad emoji) keeps the claim too: no retry
// and no second emoji as a fallback.

// message id -> 'pending' | 'done' | 'failed'. Oldest ids are dropped past MAX.
// A message object with no id (a stand-in) is tracked by the object itself.
let claims = new Map();
let unnamed = new WeakMap();
const MAX = 5000;

const claimOf = (message) => (message?.id != null ? claims.get(message.id) : message ? unnamed.get(message) : undefined);
function setClaim(message, state) {
  if (message.id == null) return void unnamed.set(message, state);
  claims.delete(message.id);
  claims.set(message.id, state);
  if (claims.size > MAX) claims.delete(claims.keys().next().value);
}

// Discord's own cache knows when Panda reacted before this process saw it (e.g.
// before a restart). Any shape of `cache` without `some` just counts as unknown.
function reactedOnDiscord(message) {
  try {
    return Boolean(message?.reactions?.cache?.some?.((r) => r.me));
  } catch {
    return false;
  }
}

// Has Panda's reaction landed on this message?
export function hasReacted(message) {
  return claimOf(message) === 'done' || reactedOnDiscord(message);
}

// Has anything already tried (or managed) to react to this message?
export function reactionClaimed(message) {
  return claimOf(message) !== undefined || reactedOnDiscord(message);
}

// React with `emoji` unless this message already has (or had a try at) Panda's
// reaction. Resolves true only when this call added it; never throws.
export async function reactOnce(message, emoji) {
  if (!message?.react || reactionClaimed(message)) return false;
  setClaim(message, 'pending');
  try {
    await message.react(emoji);
    setClaim(message, 'done');
    return true;
  } catch (err) {
    setClaim(message, 'failed');
    console.error(`[panda] reaction ${emoji} failed:`, String(err?.message || err).slice(0, 120));
    return false;
  }
}

// Tests only: the claims are per process.
export function clearReactionClaims() {
  claims = new Map();
  unnamed = new WeakMap();
}
