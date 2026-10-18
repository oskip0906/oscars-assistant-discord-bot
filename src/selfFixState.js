// Tracks the self_fix approval and run. The bot keeps answering throughout:
// Claude Code works in GitHub Actions, not here. isActive() only stops a second
// fix from starting while one runs. In-memory on purpose: a self_fix ends in a
// restart, and a run that survived it would block self_fix after boot.

// Absolute cap on how long a run counts as active, so a run that never reports
// back can't block self_fix forever.
const DEFAULT_TIMEOUT_MS = 50 * 60 * 1000;

export class SelfFixState {
  constructor({ timeoutMs = DEFAULT_TIMEOUT_MS, now = Date.now } = {}) {
    this.timeoutMs = timeoutMs;
    this.now = now;
    this.startedAt = null;
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
  // click cannot race the setup. Only a matching owner click settles it: there
  // is no deadline, because a request that expired while Oscar was reading it
  // meant re-typing the whole instruction. Plain text never approves source
  // changes. timeoutMs is opt-in and used only by tests.
  beginApproval({ userId, timeoutMs = null, id = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}` } = {}) {
    // A newer request supersedes the older one. Without a deadline an abandoned
    // approval would otherwise sit in 'awaiting_confirmation' forever, holding a
    // caller on a promise nothing left alive can resolve. It settles as
    // 'superseded', not 'cancel', so the caller can tell "Oscar pressed Cancel"
    // from "this request was taken over" and retire the old card accordingly.
    if (this.pending) this.pending.resolve('superseded');
    this.status = 'awaiting_confirmation';
    const result = new Promise((resolve) => {
      let timer = null;
      const finish = (outcome) => {
        if (timer) clearTimeout(timer);
        this.pending = null;
        if (this.status === 'awaiting_confirmation') this.status = 'idle';
        resolve(outcome);
      };
      if (timeoutMs) {
        timer = setTimeout(() => finish('timeout'), timeoutMs);
        if (timer.unref) timer.unref();
      }
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
  }

  end() {
    this.startedAt = null;
    this.status = 'idle';
    if (this.pending) {
      this.pending.resolve('aborted');
      this.pending = null;
    }
  }
}

// The instance the running bot uses. Tests construct their own.
export const selfFixState = new SelfFixState();
