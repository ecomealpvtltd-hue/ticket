import { withTenant } from '../db.js';
import { registerJobHandler, PermanentJobError, IntegrationNotConnected, type Job } from '../services/jobs.js';
import { addEvent } from '../services/tickets.js';
import { getTenant } from '../services/tenants.js';
import { enqueueJob } from '../services/jobs.js';
import { getAIProvider } from './index.js';

export function registerAIJobs() {
  registerJobHandler(
    'ai_triage',
    async (job: Job) => {
      const provider = getAIProvider();
      if (!provider) throw new PermanentJobError('AI is not configured');
      const { ticket, tenant } = await withTenant(job.tenant_id, async (db) => {
        const r = await db.query(`SELECT id, description FROM tickets WHERE id = $1`, [job.ticket_id]);
        return { ticket: r.rows[0], tenant: await getTenant(db, job.tenant_id) };
      });
      if (!ticket) throw new PermanentJobError('Ticket no longer exists');

      const result = await provider.triage(
        { description: ticket.description, orgLabel: tenant.config.form.orgLabel, categories: tenant.config.categories },
        { timeoutMs: 15_000 },
      );

      await withTenant(job.tenant_id, async (db) => {
        await db.query(
          `UPDATE tickets SET ai_status = 'done', ai_category = $2, ai_priority = $3, ai_summary = $4, ai_reason = $5,
                  triage_source = 'ai',
                  category = CASE WHEN category IS NULL OR category_source IN ('rules') THEN $2 ELSE category END,
                  category_source = CASE WHEN category IS NULL OR category_source IN ('rules') THEN 'ai' ELSE category_source END
            WHERE id = $1`,
          [job.ticket_id, result.category, result.priority, result.summary, result.reason],
        );
        await addEvent(db, job.tenant_id, job.ticket_id, {
          actorType: 'ai', actorLabel: provider.name, type: 'ai_triage',
          data: { category: result.category, priority: result.priority },
        });
        // Refresh the Sheet row with category and summary (no-op if Google is not connected yet).
        const g = await db.query(`SELECT status FROM integrations WHERE tenant_id = $1 AND provider = 'google'`, [job.tenant_id]);
        await enqueueJob(db, job.tenant_id, job.ticket_id, 'sheet_sync', { blocked: g.rows[0]?.status !== 'connected' });
      });
    },
    async (job: Job) => {
      await withTenant(job.tenant_id, (db) =>
        db.query(`UPDATE tickets SET ai_status = 'failed' WHERE id = $1 AND ai_status = 'pending'`, [job.ticket_id]),
      );
    },
  );
}

export { IntegrationNotConnected };
