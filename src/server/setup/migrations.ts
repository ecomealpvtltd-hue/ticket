// Schema migrations. Applied in order, once each, under an advisory lock so concurrent
// cold starts or deploys can't race. Runs as the connecting (owner) role, not support_app.
import type pg from 'pg';

export interface Migration { name: string; sql: string }

export async function runMigrations(client: pg.ClientBase, migrations: Migration[], log: (s: string) => void = () => {}) {
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  await client.query(`SELECT pg_advisory_lock(727401)`);
  try {
    const done = new Set((await client.query(`SELECT name FROM schema_migrations`)).rows.map((r) => r.name));
    for (const m of [...migrations].sort((a, b) => a.name.localeCompare(b.name))) {
      if (done.has(m.name)) continue;
      await client.query('BEGIN');
      try {
        await client.query(m.sql);
        await client.query(`INSERT INTO schema_migrations (name) VALUES ($1)`, [m.name]);
        await client.query('COMMIT');
        log(`migrate: applied ${m.name}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${m.name} failed: ${(err as Error).message}`);
      }
    }
  } finally {
    await client.query(`SELECT pg_advisory_unlock(727401)`);
  }
}
