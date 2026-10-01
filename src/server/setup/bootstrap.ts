// Runs once per server instance before the first request: applies pending migrations and
// creates tenants defined in the repository. No build-time database access is needed, so
// deploys work the same with Netlify Database or any external Postgres.
import { getPool } from '../db.js';
import { env } from '../env.js';
import { log, errorMessage } from '../log.js';
import { runMigrations } from './migrations.js';
import { seedTenants } from './seed.js';
import data from '../generated/data.json' with { type: 'json' };
import { withSystem } from '../db.js';
import { classify } from '../ai/rules.js';
import { parseTenantConfigLenient } from '../../shared/model.js';
import { enqueueJob } from '../services/jobs.js';

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
      await backfillTriage();
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

/** Give tickets created before rules-based triage existed a category and suggested priority. */
async function backfillTriage() {
  await withSystem(async (db) => {
    const r = await db.query(
      `SELECT t.id, t.tenant_id, t.description, t.category, n.config
         FROM tickets t JOIN tenants n ON n.id = t.tenant_id
        WHERE t.triage_source IS NULL LIMIT 500`,
    );
    for (const row of r.rows) {
      const cfg = parseTenantConfigLenient(row.config);
      const rules = classify(row.description, cfg.categories);
      await db.query(
        `UPDATE tickets SET triage_source = 'rules', ai_category = $2, ai_priority = coalesce(ai_priority, $3), ai_reason = coalesce(ai_reason, $4),
                category = coalesce(category, $2),
                category_source = CASE WHEN category IS NULL AND $2::text IS NOT NULL THEN 'rules' ELSE category_source END
          WHERE id = $1`,
        [row.id, rules.category, rules.priority, rules.reason],
      );
      // Refresh the Sheet row so the new Category columns fill in.
      const g = await db.query(`SELECT status FROM integrations WHERE tenant_id = $1 AND provider = 'google'`, [row.tenant_id]);
      await enqueueJob(db, row.tenant_id, row.id, 'sheet_sync', { blocked: g.rows[0]?.status !== 'connected' });
    }
    if (r.rowCount) log.info('bootstrap', { step: `triage backfill: ${r.rowCount} ticket(s)` });
  });
}
