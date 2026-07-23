import fs from 'node:fs';
import path from 'node:path';

// The exact string non-owners get while private mode is ON. Hardcoded — the
// model is never consulted for blocked senders (and never composes this).
export const PRIVATE_MESSAGE = 'I am in a private conversation with Oscar right now.';

// Plain-text flag file (ON/OFF) so the state survives restarts and self_fix
// reloads.
export class PrivateMode {
  constructor(dataDir) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.file = path.join(dataDir, 'private-mode.flag');
    this.on = false;
    try {
      this.on = fs.readFileSync(this.file, 'utf8').trim().toUpperCase() === 'ON';
    } catch {
      /* no flag file yet → OFF */
    }
  }

  isOn() {
    return this.on;
  }

  set(on) {
    this.on = Boolean(on);
    try {
      fs.writeFileSync(this.file, this.on ? 'ON' : 'OFF');
    } catch (err) {
      console.error('[privateMode] persist failed:', err.message);
    }
  }
}
