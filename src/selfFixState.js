// Busy-state lock for self_fix. While a fix is running the bot answers nobody
// through the model — triggering messages get the hardcoded string below and
// nothing else. Mirrors the PrivateMode pattern (see privateMode.js), but this
// state is deliberately in-memory only: a self_fix ends in a restart, and a
// lock that survived the restart would leave the bot deaf on boot.
export const SELF_FIX_MESSAGE =
  "🛠️ I'm rebuilding my own source code right now — I'll be back in a few minutes once it lands and I restart.";

// Absolute cap on how long the lock may hold. A missing `claude` binary or a
// wedged child process must never leave the bot permanently ignoring everyone,
// so isActive() releases itself past this deadline even if end() never ran.
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

export class SelfFixState {
  constructor({ timeoutMs = DEFAULT_TIMEOUT_MS, now = Date.now } = {}) {
    this.timeoutMs = timeoutMs;
    this.now = now;
    this.startedAt = null;
    this.notified = new Set();
  }

  isActive() {
    if (this.startedAt === null) return false;
    if (this.now() - this.startedAt > this.timeoutMs) {
      this.end();
      return false;
    }
    return true;
  }

  begin() {
    this.startedAt = this.now();
    this.notified = new Set();
  }

  end() {
    this.startedAt = null;
    this.notified = new Set();
  }

  // True the first time a given sender is told we're busy, false afterwards —
  // so a long fix doesn't spam the channel with one reply per message.
  shouldNotify(userId) {
    if (this.notified.has(userId)) return false;
    this.notified.add(userId);
    return true;
  }
}

// The instance the running bot uses. Tests construct their own.
export const selfFixState = new SelfFixState();
