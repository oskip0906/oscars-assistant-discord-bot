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
    // 'idle' → 'awaiting_confirmation' → 'executing' → 'idle'. A development
    // task (self_fix) first asks Oscar to confirm; only on 'confirm' does it
    // begin() and go 'executing'.
    this.status = 'idle';
    this.pending = null; // { userId, resolve } while awaiting_confirmation
  }

  isActive() {
    if (this.startedAt === null) return false;
    if (this.now() - this.startedAt > this.timeoutMs) {
      this.end();
      return false;
    }
    return true;
  }

  isAwaitingConfirmation() {
    return this.status === 'awaiting_confirmation';
  }

  // Enter 'awaiting_confirmation' and return a Promise that resolves to
  // 'confirm', 'cancel', or 'timeout'. The status flips synchronously (before
  // any await), so the message handler starts capturing the owner's answer the
  // moment this is called. Only submitConfirmation() or the timeout resolves it.
  awaitConfirmation({ userId, timeoutMs = 30_000 } = {}) {
    this.status = 'awaiting_confirmation';
    this.notified = new Set();
    return new Promise((resolve) => {
      let timer = null;
      const finish = (outcome) => {
        if (timer) clearTimeout(timer);
        this.pending = null;
        if (this.status === 'awaiting_confirmation') this.status = 'idle';
        resolve(outcome);
      };
      timer = setTimeout(() => finish('timeout'), timeoutMs);
      if (timer.unref) timer.unref();
      this.pending = { userId, resolve: finish };
    });
  }

  // Feed a candidate confirmation reply. Returns true iff it was a recognized
  // answer ('confirm'/'cancel') from the awaited user and was consumed; false
  // otherwise (wrong user, not awaiting, or unrecognized text — the caller
  // should let the owner try again until the timeout).
  submitConfirmation(userId, text) {
    if (this.status !== 'awaiting_confirmation' || !this.pending) return false;
    if (this.pending.userId && this.pending.userId !== userId) return false;
    const t = String(text ?? '').trim().toLowerCase();
    if (t === 'confirm' || t === 'yes' || t === 'y') {
      this.pending.resolve('confirm');
      return true;
    }
    if (t === 'cancel' || t === 'no' || t === 'abort') {
      this.pending.resolve('cancel');
      return true;
    }
    return false;
  }

  begin() {
    this.status = 'executing';
    this.startedAt = this.now();
    this.notified = new Set();
  }

  end() {
    this.startedAt = null;
    this.notified = new Set();
    this.status = 'idle';
    if (this.pending) {
      this.pending.resolve('cancel');
      this.pending = null;
    }
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
