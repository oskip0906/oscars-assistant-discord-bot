// Busy-state lock for self_fix. While a fix is running the bot answers nobody
// through the model — triggering messages get the hardcoded string below and
// nothing else. Mirrors the PrivateMode pattern (see privateMode.js), but this
// state is deliberately in-memory only: a self_fix ends in a restart, and a
// lock that survived the restart would leave the bot deaf on boot.
export const SELF_FIX_MESSAGE =
  "🛠️ I'm rebuilding my own source code right now — I'll be back in a few minutes once it lands and I restart.";

// Absolute cap on how long the lock may hold. A remote sandbox can legitimately
// wait for CI and auto-merge, but it must still fail open rather than leaving
// the bot permanently ignoring everyone.
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

export class SelfFixState {
  constructor({ timeoutMs = DEFAULT_TIMEOUT_MS, now = Date.now } = {}) {
    this.timeoutMs = timeoutMs;
    this.now = now;
    this.startedAt = null;
    this.notified = new Set();
    // 'idle' → 'awaiting_confirmation' → 'executing' → 'idle'. A development
    // task first receives an explicit Discord button approval.
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

  // Enter 'awaiting_confirmation' and expose a nonce-bound button id plus a
  // result promise. The status flips synchronously before the UI is sent, so a
  // click cannot race the setup. Only a matching owner click or timeout settles
  // the request; plain text never approves source changes.
  beginApproval({ userId, timeoutMs = 30_000, id = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}` } = {}) {
    this.status = 'awaiting_confirmation';
    this.notified = new Set();
    const result = new Promise((resolve) => {
      let timer = null;
      const finish = (outcome) => {
        if (timer) clearTimeout(timer);
        this.pending = null;
        if (this.status === 'awaiting_confirmation') this.status = 'idle';
        resolve(outcome);
      };
      timer = setTimeout(() => finish('timeout'), timeoutMs);
      if (timer.unref) timer.unref();
      this.pending = { userId, id, resolve: finish };
    });
    return { id, result };
  }

  // Non-consuming twin of submitApproval. Discord gives 3 seconds to answer a
  // button click, and consuming the approval resumes the development run ahead
  // of that answer — so the click is checked with this, answered, and only then
  // submitted.
  matchesPendingApproval(userId, id) {
    if (this.status !== 'awaiting_confirmation' || !this.pending) return false;
    if (this.pending.userId && this.pending.userId !== userId) return false;
    return this.pending.id === id;
  }

  // Consume one Discord approval button click. Returns false for old buttons,
  // other users, and any state other than the active approval.
  submitApproval(userId, id, approved) {
    if (!this.matchesPendingApproval(userId, id)) return false;
    this.pending.resolve(approved ? 'confirm' : 'cancel');
    return true;
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
