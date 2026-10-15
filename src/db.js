import fs from 'node:fs';
import pg from 'pg';

// The PMS Postgres (db-1) behind context, notes, reminders and the persona.
// Unset DATABASE_URL means each caller's quiet no-op (or a clear error), never a crash.
export const configured = (config) => Boolean(config?.databaseUrl);

let pool = null;

function getPool(config) {
  if (!pool) {
    pool = new pg.Pool({ connectionString: config.databaseUrl, max: 4, connectionTimeoutMillis: 5000, query_timeout: 15000 });
    // An idle connection dropped by the server would otherwise be an uncaught error.
    pool.on('error', (err) => console.error('[db] idle connection error:', err.message));
  }
  return pool;
}

// Tests replace db.query with a fake; everything else goes through it.
export const db = {
  query(config, text, params) {
    // pg would otherwise fall back to a local default database.
    if (!configured(config)) throw new Error('DATABASE_URL is not set.');
    return getPool(config).query(text, params);
  },
  // One statement from query_db, inside a read-only transaction that gives up
  // after 5 s. The extended protocol refuses a second statement, so
  // "select 1; commit; drop …" can't end the transaction and write.
  async readOnly(config, text) {
    if (!configured(config)) throw new Error('DATABASE_URL is not set.');
    const client = await getPool(config).connect();
    try {
      await client.query('begin read only');
      await client.query("set local statement_timeout = '5s'");
      return await client.query({ text, queryMode: 'extended' });
    } finally {
      const broken = await client.query('rollback').then(() => false, () => true);
      client.release(broken);
    }
  },
};

export async function ensureSchema(config) {
  if (!configured(config)) return false;
  await db.query(config, fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
  return true;
}
