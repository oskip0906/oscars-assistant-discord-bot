import fs from 'node:fs';
import pg from 'pg';

// The PMS Postgres (db-1) behind context, notes, reminders and the persona.
// Unset DATABASE_URL means each caller's quiet no-op (or a clear error), never a crash.
export const configured = (config) => Boolean(config?.databaseUrl);

let pool = null;

// Tests replace db.query with a fake; everything else goes through it.
export const db = {
  query(config, text, params) {
    // pg would otherwise fall back to a local default database.
    if (!configured(config)) throw new Error('DATABASE_URL is not set.');
    if (!pool) {
      pool = new pg.Pool({ connectionString: config.databaseUrl, max: 4, connectionTimeoutMillis: 5000, query_timeout: 15000 });
      // An idle connection dropped by the server would otherwise be an uncaught error.
      pool.on('error', (err) => console.error('[db] idle connection error:', err.message));
    }
    return pool.query(text, params);
  },
};

export async function ensureSchema(config) {
  if (!configured(config)) return false;
  await db.query(config, fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
  return true;
}
