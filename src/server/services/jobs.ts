// The outbox. Every integration side effect (Drive, Sheets, AI) is a row here, written in the
// same transaction as the ticket. A job can fail, retry, or wait for an integration to be
// connected; none of that can affect the ticket itself.

import { withSystem, withTenant, type Db } from '../db.js';
import { log, errorMessage } from '../log.js';

export type JobKind = 'drive_upload' | 'sheet_sync' | 'ai_triage';

export interface Job {
  id: string;
  tenant_id: string;
  ticket_id: string;
  kind: JobKind;
  attempts: number;
  max_attempts: number;
}

/** Throw from a handler when the tenant has no working connection for this integration. */
export class IntegrationNotConnected extends Error {}
/** Throw from a handler when retrying cannot help (e.g. the ticket no longer exists). */
export class PermanentJobError extends Error {}

type Handler = (job: Job) => Promise<void>;
const handlers: Partial<Record<JobKind, Handler>> = {};
const finalFailureHooks: Partial<Record<JobKind, (job: Job, error: string) => Promise<void>>> = {};

export function registerJobHandler(kind: JobKind, handler: Handler, onFinalFailure?: (job: Job, error: string) => Promise<void>) {
  handlers[kind] = handler;
  if (onFinalFailure) finalFailureHooks[kind] = onFinalFailure;
}

const MAX_ATTEMPTS: Record<JobKind, number> = { drive_upload: 8, sheet_sync: 8, ai_triage: 3 };
const BACKOFF_SECONDS = [60, 300, 900, 3600, 3 * 3600, 6 * 3600, 12 * 3600];

export async function enqueueJob(db: Db, tenantId: string, ticketId: string, kind: JobKind, opts: { blocked: boolean }) {
  await db.query(
    `INSERT INTO integration_jobs (tenant_id, ticket_id, kind, status, max_attempts)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (ticket_id, kind) WHERE status IN ('pending', 'blocked')
     DO UPDATE SET status = EXCLUDED.status, run_after = least(integration_jobs.run_after, now()), updated_at = now()`,
    [tenantId, ticketId, kind, opts.blocked ? 'blocked' : 'pending', MAX_ATTEMPTS[kind]],
  );
}

/** Called when a tenant connects an integration: everything that was waiting becomes runnable. */
export async function unblockJobs(db: Db, tenantId: string) {
  const r = await db.query(
    `UPDATE integration_jobs SET status = 'pending', run_after = now(), updated_at = now()
      WHERE tenant_id = $1 AND status = 'blocked'`,
    [tenantId],
  );
  return r.rowCount ?? 0;
}

/** Manual retry from the dashboard. */
export async function retryJob(db: Db, tenantId: string, jobId: string) {
  try {
    const r = await db.query(
      `UPDATE integration_jobs SET status = 'pending', run_after = now(), max_attempts = attempts + 3,
              last_error = NULL, updated_at = now()
        WHERE id = $1 AND tenant_id = $2 AND status IN ('failed', 'blocked')`,
      [jobId, tenantId],
    );
    return (r.rowCount ?? 0) > 0;
  } catch (err: any) {
    if (err?.code === '23505') return true; // an identical job is already queued
    throw err;
  }
}

async function claim(opts: { ticketId?: string; limit: number }): Promise<Job[]> {
  return withSystem(async (db) => {
    const args: unknown[] = [opts.limit];
    let ticketFilter = '';
    if (opts.ticketId) { args.push(opts.ticketId); ticketFilter = `AND ticket_id = $2`; }
    const r = await db.query(
      `UPDATE integration_jobs j
          SET status = 'running', locked_until = now() + interval '2 minutes',
              attempts = attempts + 1, updated_at = now()
        WHERE j.id IN (
          SELECT id FROM integration_jobs
           WHERE ((status = 'pending' AND run_after <= now()) OR (status = 'running' AND locked_until < now()))
             ${ticketFilter}
             AND NOT EXISTS (SELECT 1 FROM integration_jobs r
                              WHERE r.ticket_id = integration_jobs.ticket_id AND r.kind = integration_jobs.kind
                                AND r.id <> integration_jobs.id AND r.status = 'running' AND r.locked_until >= now())
           ORDER BY CASE kind WHEN 'drive_upload' THEN 0 WHEN 'ai_triage' THEN 1 ELSE 2 END, run_after
           LIMIT $1
           FOR UPDATE SKIP LOCKED)
        RETURNING j.id, j.tenant_id, j.ticket_id, j.kind, j.attempts, j.max_attempts`,
      args,
    );
    // Keep the drive → ai → sheet order (RETURNING does not preserve it).
    const order: Record<string, number> = { drive_upload: 0, ai_triage: 1, sheet_sync: 2 };
    return (r.rows as Job[]).sort((a, b) => order[a.kind] - order[b.kind]);
  });
}

async function finish(job: Job, outcome: { ok: true } | { ok: false; error: unknown }) {
  if (outcome.ok) {
    await withTenant(job.tenant_id, (db) =>
      db.query(`UPDATE integration_jobs SET status = 'done', completed_at = now(), locked_until = NULL, last_error = NULL, updated_at = now() WHERE id = $1`, [job.id]),
    );
    return;
  }
  const msg = errorMessage(outcome.error);
  if (outcome.error instanceof IntegrationNotConnected) {
    await withTenant(job.tenant_id, async (db) => {
      try {
        await db.query(
          `UPDATE integration_jobs SET status = 'blocked', attempts = greatest(attempts - 1, 0), locked_until = NULL, last_error = $2, updated_at = now() WHERE id = $1`,
          [job.id, msg],
        );
      } catch (err: any) {
        if (err?.code !== '23505') throw err;
        await db.query(`UPDATE integration_jobs SET status = 'done', completed_at = now(), last_error = 'Superseded' WHERE id = $1`, [job.id]);
      }
    });
    return;
  }
  const terminal = outcome.error instanceof PermanentJobError || job.attempts >= job.max_attempts;
  if (terminal) {
    await withTenant(job.tenant_id, (db) =>
      db.query(`UPDATE integration_jobs SET status = 'failed', locked_until = NULL, last_error = $2, updated_at = now() WHERE id = $1`, [job.id, msg]),
    );
    const hook = finalFailureHooks[job.kind];
    if (hook) await hook(job, msg).catch((e) => log.error('job.final_hook_failed', { kind: job.kind, message: errorMessage(e) }));
    log.error('job.failed', { kind: job.kind, job: job.id, attempts: job.attempts, message: msg });
    return;
  }
  const delay = BACKOFF_SECONDS[Math.min(job.attempts - 1, BACKOFF_SECONDS.length - 1)];
  await withTenant(job.tenant_id, async (db) => {
    try {
      await db.query(
        `UPDATE integration_jobs SET status = 'pending', run_after = now() + ($3 || ' seconds')::interval,
                locked_until = NULL, last_error = $2, updated_at = now() WHERE id = $1`,
        [job.id, msg, String(delay)],
      );
    } catch (err: any) {
      // A fresh job of the same kind was queued meanwhile; it will carry the latest state.
      if (err?.code !== '23505') throw err;
      await db.query(`UPDATE integration_jobs SET status = 'done', completed_at = now(), last_error = 'Superseded' WHERE id = $1`, [job.id]);
    }
  });
  log.warn('job.retry_scheduled', { kind: job.kind, job: job.id, attempts: job.attempts, inSeconds: delay, message: msg });
}

/**
 * Drain due jobs. `ticketId` narrows to one ticket (used right after a submission);
 * `budgetMs` keeps us inside the serverless time limit.
 */
export async function runJobs(opts: { ticketId?: string; budgetMs?: number; limit?: number } = {}) {
  const deadline = Date.now() + (opts.budgetMs ?? 20_000);
  const summary = { processed: 0, done: 0, failed: 0 };
  while (Date.now() < deadline) {
    const jobs = await claim({ ticketId: opts.ticketId, limit: opts.limit ?? 10 });
    if (!jobs.length) break;
    for (const job of jobs) {
      const handler = handlers[job.kind];
      summary.processed++;
      try {
        if (!handler) throw new IntegrationNotConnected(`No handler registered for ${job.kind}`);
        await handler(job);
        await finish(job, { ok: true });
        summary.done++;
      } catch (error) {
        await finish(job, { ok: false, error }).catch((e) => log.error('job.finish_failed', { message: errorMessage(e) }));
        summary.failed++;
      }
    }
    if (opts.ticketId) {
      // A just-created ticket has at most a few jobs; follow-ups (e.g. sheet after drive) run next loop.
      continue;
    }
  }
  return summary;
}

/** Remove uploaded files that were never attached to a ticket. */
export async function cleanupOrphanAttachments(deleteBlob: (key: string) => Promise<void>) {
  const orphans = await withSystem((db) =>
    db.query(`DELETE FROM attachments WHERE ticket_id IS NULL AND created_at < now() - interval '1 day' RETURNING blob_key`),
  );
  for (const row of orphans.rows) await deleteBlob(row.blob_key).catch(() => {});
  return orphans.rowCount ?? 0;
}
