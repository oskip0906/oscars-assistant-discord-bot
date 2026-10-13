import { db, configured } from './db.js';

// The exact string non-owners get while private mode is ON. Hardcoded — the
// model is never consulted for blocked senders (and never composes this).
export const PRIVATE_MESSAGE = 'I am in a private conversation with Oscar right now.';

// Private mode lives in the database (the one-row `pms` table in db-1), so it
// survives restarts and redeploys. isOn() reads the in-memory copy, which is
// only changed after the database has the new value, so the two never disagree.
export class PrivateMode {
  constructor(config, { query = db.query } = {}) {
    this.config = config;
    this.query = query;
    this.on = false;
    // Toggles run one at a time, so a slow write can't land after a newer one.
    this.pending = Promise.resolve();
  }

  isOn() {
    return this.on;
  }

  // At boot: the saved state. No database or no row means OFF; a database that
  // is down leaves it OFF and is logged, never a failed boot.
  async load() {
    if (!configured(this.config)) return this.on;
    try {
      const { rows } = await this.query(this.config, 'select enabled from pms where id = 1');
      this.on = Boolean(rows[0]?.enabled);
    } catch (err) {
      console.error('[privateMode] could not load the saved state, starting OFF:', err.message);
    }
    return this.on;
  }

  // Saves the new state, then applies it. A failed save changes nothing and
  // says why, so the caller never claims a switch that didn't happen.
  set(on) {
    const run = this.pending.then(() => this.save(Boolean(on)));
    this.pending = run.catch(() => {});
    return run;
  }

  async save(on) {
    if (!configured(this.config)) return { ok: false, on: this.on, error: 'DATABASE_URL is not set, so private mode cannot be saved.' };
    try {
      await this.query(
        this.config,
        'insert into pms (id, enabled, updated_at) values (1, $1, now()) on conflict (id) do update set enabled = excluded.enabled, updated_at = now()',
        [on],
      );
    } catch (err) {
      console.error('[privateMode] save failed:', err.message);
      return { ok: false, on: this.on, error: `Could not save private mode: ${String(err.message || err).slice(0, 200)}` };
    }
    this.on = on;
    return { ok: true, on };
  }
}
