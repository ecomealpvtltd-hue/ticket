// Runs once per server instance before the first request: applies pending migrations and
// creates tenants defined in the repository. No build-time database access is needed, so
// deploys work the same with Netlify Database or any external Postgres.
import { getPool } from '../db.js';
import { env } from '../env.js';
import { log, errorMessage } from '../log.js';
import { runMigrations } from './migrations.js';
import { seedTenants } from './seed.js';
import data from '../generated/data.json' with { type: 'json' };

let ready: Promise<void> | null = null;

export function ensureReady(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      const client = await getPool().connect();
      try {
        await runMigrations(client, (data as any).migrations, (s) => log.info('bootstrap', { step: s }));
      } finally {
        client.release();
      }
      const owners = (process.env.BOOTSTRAP_OWNER_EMAILS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      const extra = env.appEnv === 'development' ? (process.env.DEV_EXTRA_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean) : [];
      await seedTenants((data as any).tenants, { ownerEmails: owners, extraOrigins: extra, log: (s) => log.info('bootstrap', { step: s }) });
    })().catch((err) => {
      ready = null; // retry on the next request
      log.error('bootstrap.failed', { message: errorMessage(err) });
      throw err;
    });
  }
  return ready;
}

/** Tests and scripts that set the database up themselves. */
export function markReady() { ready = Promise.resolve(); }
