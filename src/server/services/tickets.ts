import { z } from 'zod';
import type { Db } from '../db.js';
import { HttpError, notFound } from '../http.js';
import { normalizePhone, PRIORITIES, STATUSES, type TicketPriority, type TicketStatus } from '../../shared/model.js';
import type { Tenant } from './tenants.js';
import { enqueueJob, type JobKind } from './jobs.js';
import { aiAvailable } from '../ai/index.js';
import { classify } from '../ai/rules.js';

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

/** Strip control characters except newlines and tabs; normalise line endings. */
const cleanText = (s: string) => s.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
const cleanLine = (s: string) => cleanText(s).replace(/\s+/g, ' ').trim();

export const ticketInputSchema = z.object({
  name: z.string().transform(cleanLine).pipe(z.string().min(2, 'Enter your name').max(100, 'Name is too long')),
  country: z.string().length(2).default('IN'),
  phone: z.string().trim().min(1, 'Enter your phone number').max(24, 'Enter a valid phone number'),
  orgName: z.string().transform(cleanLine).pipe(z.string().min(2, 'This field is required').max(120, 'Too long')),
  description: z.string().transform((s) => cleanText(s).trim())
    .pipe(z.string().min(10, 'Please add a little more detail (at least 10 characters)').max(5000, 'Please keep this under 5,000 characters')),
  category: z.string().transform(cleanLine).pipe(z.string().max(40)).optional(),
  email: z.union([z.literal(''), z.email('Enter a valid email').max(200)]).optional(),
  attachmentIds: z.array(z.uuid()).max(3, 'Up to 3 attachments').default([]),
  /** Honeypot: humans never see this field. */
  website: z.string().optional(),
  /** Seconds between form open and submit, reported by the widget. */
  elapsed: z.number().optional(),
  pageUrl: z.string().max(500).optional(),
});
export type TicketInput = z.input<typeof ticketInputSchema>;

export function validateTicketInput(raw: unknown, tenant: Tenant) {
  const input = ticketInputSchema.parse(raw);
  const phone = normalizePhone(input.country, input.phone);
  if (!phone) {
    throw new HttpError(422, 'validation_failed', 'Please check the highlighted fields.', {
      fields: { phone: 'Enter a valid phone number' },
    });
  }
  if (input.category && !tenant.config.categories.includes(input.category)) {
    input.category = undefined;
  }
  return { ...input, phone };
}

// ---------------------------------------------------------------------------
// Ticket creation — the one transaction that must never depend on an integration.
// ---------------------------------------------------------------------------

export interface CreatedTicket { id: string; number: string }

export async function createTicket(
  db: Db,
  tenant: Tenant,
  input: ReturnType<typeof validateTicketInput>,
  meta: { userAgent?: string | null; pageUrl?: string | null; origin?: string | null },
  integrations: { googleConnected: boolean },
): Promise<CreatedTicket> {
  // 1. Customer: one record per phone number per tenant, refreshed with the latest details.
  const cust = await db.query(
    `INSERT INTO customers (tenant_id, name, phone, email, org_name)
     VALUES ($1, $2, $3, nullif($4, ''), $5)
     ON CONFLICT (tenant_id, phone) DO UPDATE
       SET name = EXCLUDED.name, org_name = EXCLUDED.org_name,
           email = coalesce(EXCLUDED.email, customers.email), updated_at = now()
     RETURNING id`,
    [tenant.id, input.name, input.phone, input.email ?? '', input.orgName],
  );
  const customerId: string = cust.rows[0].id;

  // 2. Ticket number: atomic per-tenant counter (row lock serialises concurrent submissions).
  const seqRow = await db.query(
    `UPDATE tenants SET ticket_seq = ticket_seq + 1, updated_at = now() WHERE id = $1
     RETURNING ticket_seq, ticket_prefix`,
    [tenant.id],
  );
  const seq: number = seqRow.rows[0].ticket_seq;
  const number = `${seqRow.rows[0].ticket_prefix}-${String(seq).padStart(6, '0')}`;

  // 3. Possible duplicate: an unresolved ticket from the same customer in the last 24 hours.
  const dup = await db.query(
    `SELECT id, number FROM tickets
      WHERE customer_id = $1 AND status IN ('open', 'in_progress') AND created_at > now() - interval '24 hours'
      ORDER BY created_at DESC LIMIT 1`,
    [customerId],
  );
  const duplicateOf = dup.rows[0] ?? null;

  const useAi = aiAvailable() && tenant.config.ai.enabled;
  // Instant, offline triage so every ticket is bucketed even when AI is off.
  const rules = classify(input.description, tenant.config.categories);
  const category = input.category ?? rules.category;
  const categorySource = input.category ? 'customer' : rules.category ? 'rules' : null;

  const t = await db.query(
    `INSERT INTO tickets (tenant_id, seq, number, customer_id, name, phone, email, org_name, category, category_source,
                          description, duplicate_of, ai_status, ai_category, ai_priority, ai_reason, triage_source, meta)
     VALUES ($1, $2, $3, $4, $5, $6, nullif($7, ''), $8, $9, $10, $11, $12, $13, $14, $15, $16, 'rules', $17)
     RETURNING id`,
    [
      tenant.id, seq, number, customerId, input.name, input.phone, input.email ?? '', input.orgName,
      category, categorySource, input.description, duplicateOf?.id ?? null, useAi ? 'pending' : 'disabled',
      rules.category, rules.priority, rules.reason,
      JSON.stringify({ userAgent: meta.userAgent?.slice(0, 300) ?? null, pageUrl: meta.pageUrl ?? null, origin: meta.origin ?? null }),
    ],
  );
  const ticketId: string = t.rows[0].id;

  // 4. Attach files uploaded earlier in this session (unclaimed, recent, same tenant via RLS).
  let attachmentCount = 0;
  if (input.attachmentIds.length) {
    const a = await db.query(
      `UPDATE attachments SET ticket_id = $1
        WHERE id = ANY($2::uuid[]) AND ticket_id IS NULL AND created_at > now() - interval '6 hours'
        RETURNING id`,
      [ticketId, input.attachmentIds],
    );
    if (a.rowCount !== input.attachmentIds.length) {
      throw new HttpError(422, 'attachment_expired', 'One of your attachments is no longer available. Please remove it and add it again.');
    }
    attachmentCount = a.rowCount ?? 0;
  }

  // 5. Timeline
  await addEvent(db, tenant.id, ticketId, { actorType: 'customer', actorLabel: input.name, type: 'created',
    data: { attachments: attachmentCount, category: input.category ?? null } });
  await addEvent(db, tenant.id, ticketId, { actorType: 'system', type: 'auto_triage',
    data: { category: categorySource === 'rules' ? rules.category : null, priority: rules.priority } });
  if (duplicateOf) {
    await addEvent(db, tenant.id, ticketId, { actorType: 'system', type: 'possible_duplicate',
      data: { of: duplicateOf.number } });
  }

  // 6. Outbox: integrations run after the response, from this durable queue.
  const blocked = !integrations.googleConnected;
  await enqueueJob(db, tenant.id, ticketId, 'sheet_sync', { blocked });
  if (attachmentCount) await enqueueJob(db, tenant.id, ticketId, 'drive_upload', { blocked });
  if (useAi) await enqueueJob(db, tenant.id, ticketId, 'ai_triage', { blocked: false });

  return { id: ticketId, number };
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export async function addEvent(
  db: Db,
  tenantId: string,
  ticketId: string,
  e: { actorType: 'customer' | 'admin' | 'system' | 'ai'; actorId?: string | null; actorLabel?: string | null; type: string; data?: Record<string, unknown> },
) {
  await db.query(
    `INSERT INTO ticket_events (tenant_id, ticket_id, actor_type, actor_id, actor_label, type, data)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [tenantId, ticketId, e.actorType, e.actorId ?? null, e.actorLabel ?? null, e.type, JSON.stringify(e.data ?? {})],
  );
}

// ---------------------------------------------------------------------------
// Admin reads
// ---------------------------------------------------------------------------

export const listQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(['all', 'active', ...STATUSES]).default('all'),
  priority: z.enum(['all', ...PRIORITIES]).default('all'),
  sort: z.enum(['newest', 'oldest', 'priority', 'updated']).default('newest'),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(10).max(100).default(25),
});

const PRIORITY_ORDER = `CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END`;

export async function listTickets(db: Db, tenantId: string, raw: Record<string, string | undefined>) {
  const f = listQuerySchema.parse(raw);
  const where: string[] = ['t.tenant_id = $1'];
  const args: unknown[] = [tenantId];
  if (f.status === 'active') where.push(`t.status IN ('open', 'in_progress')`);
  else if (f.status !== 'all') { args.push(f.status); where.push(`t.status = $${args.length}`); }
  if (f.priority !== 'all') { args.push(f.priority); where.push(`t.priority = $${args.length}`); }
  if (f.q) {
    const digits = f.q.replace(/\D/g, '');
    const like = '%' + f.q.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
    args.push(like);
    const i = args.length;
    const clauses = [`t.number ILIKE $${i}`, `t.name ILIKE $${i}`, `t.org_name ILIKE $${i}`, `t.description ILIKE $${i}`];
    if (digits.length >= 3) { args.push('%' + digits + '%'); clauses.push(`t.phone LIKE $${args.length}`); }
    if (/^\d+$/.test(f.q)) { args.push(Number(f.q)); clauses.push(`t.seq = $${args.length}`); }
    where.push(`(${clauses.join(' OR ')})`);
  }
  const order =
    f.sort === 'oldest' ? 't.created_at ASC' :
    f.sort === 'priority' ? `${PRIORITY_ORDER}, t.created_at DESC` :
    f.sort === 'updated' ? 't.updated_at DESC' : 't.created_at DESC';

  const whereSql = where.join(' AND ');
  const total = await db.query(`SELECT count(*)::int AS n FROM tickets t WHERE ${whereSql}`, args);
  args.push(f.pageSize, (f.page - 1) * f.pageSize);
  const rows = await db.query(
    `SELECT t.id, t.number, t.name, t.phone, t.org_name, t.category, t.description, t.status, t.priority,
            t.ai_priority, t.ai_category, t.ai_summary, t.created_at, t.updated_at,
            (SELECT count(*)::int FROM attachments a WHERE a.ticket_id = t.id) AS attachment_count
       FROM tickets t WHERE ${whereSql} ORDER BY ${order}
      LIMIT $${args.length - 1} OFFSET $${args.length}`,
    args,
  );
  return {
    tickets: rows.rows.map(ticketListItem),
    total: total.rows[0].n as number,
    page: f.page,
    pageSize: f.pageSize,
  };
}

function ticketListItem(r: any) {
  return {
    id: r.id,
    number: r.number,
    name: r.name,
    phone: r.phone,
    orgName: r.org_name,
    category: r.category ?? r.ai_category ?? null,
    excerpt: (r.ai_summary || r.description || '').slice(0, 160),
    status: r.status,
    priority: r.priority,
    aiPriority: r.ai_priority,
    attachmentCount: r.attachment_count,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function overview(db: Db, tenantId: string) {
  const counts = await db.query(
    `SELECT
       count(*) FILTER (WHERE status = 'open')::int AS open,
       count(*) FILTER (WHERE status = 'in_progress')::int AS in_progress,
       count(*) FILTER (WHERE status = 'resolved')::int AS resolved,
       count(*) FILTER (WHERE status = 'closed')::int AS closed,
       count(*)::int AS total,
       count(*) FILTER (WHERE status IN ('open','in_progress') AND priority IN ('high','urgent'))::int AS high_open,
       count(*) FILTER (WHERE created_at > now() - interval '24 hours')::int AS last_24h,
       (percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (resolved_at - created_at)))
          FILTER (WHERE resolved_at IS NOT NULL AND resolved_at > now() - interval '30 days'))::float AS median_resolution_seconds
     FROM tickets WHERE tenant_id = $1`,
    [tenantId],
  );
  const attention = await db.query(
    `SELECT t.id, t.number, t.name, t.phone, t.org_name, t.category, t.description, t.status, t.priority,
            t.ai_priority, t.ai_category, t.ai_summary, t.created_at, t.updated_at, 0 AS attachment_count
       FROM tickets t
      WHERE t.tenant_id = $1 AND t.status IN ('open', 'in_progress')
      ORDER BY ${PRIORITY_ORDER}, t.created_at ASC LIMIT 6`,
    [tenantId],
  );
  const jobs = await db.query(
    `SELECT count(DISTINCT ticket_id) FILTER (WHERE status = 'failed')::int AS failed,
            count(DISTINCT ticket_id) FILTER (WHERE status IN ('pending','running'))::int AS pending,
            count(DISTINCT ticket_id) FILTER (WHERE status = 'blocked')::int AS blocked
       FROM integration_jobs WHERE tenant_id = $1 AND kind IN ('sheet_sync', 'drive_upload')`,
    [tenantId],
  );
  return { counts: counts.rows[0], attention: attention.rows.map(ticketListItem), sync: jobs.rows[0] };
}

export async function getTicketDetail(db: Db, tenantId: string, ref: string) {
  const byNumber = /^[A-Z]{2,6}-\d{6,}$/.test(ref);
  if (!byNumber && !/^[0-9a-f-]{36}$/i.test(ref)) throw notFound('Ticket not found.');
  const r = await db.query(
    `SELECT t.*, d.number AS duplicate_number FROM tickets t
       LEFT JOIN tickets d ON d.id = t.duplicate_of
      WHERE t.tenant_id = $1 AND ${byNumber ? 't.number = $2' : 't.id = $2'}`,
    [tenantId, ref],
  );
  const t = r.rows[0];
  if (!t) throw notFound('Ticket not found.');
  const [attachments, events, jobs, customerTickets] = await Promise.all([
    db.query(`SELECT id, file_name, mime_type, size_bytes, drive_url, created_at FROM attachments WHERE ticket_id = $1 ORDER BY created_at`, [t.id]),
    db.query(`SELECT id, actor_type, actor_label, type, data, created_at FROM ticket_events WHERE ticket_id = $1 ORDER BY created_at, id`, [t.id]),
    db.query(`SELECT id, kind, status, attempts, last_error, updated_at, completed_at FROM integration_jobs WHERE ticket_id = $1 ORDER BY created_at DESC`, [t.id]),
    db.query(`SELECT count(*)::int AS n FROM tickets WHERE customer_id = $1`, [t.customer_id]),
  ]);
  // Latest job per kind describes the current sync state.
  const sync: Record<string, any> = {};
  for (const j of jobs.rows) if (!sync[j.kind]) sync[j.kind] = { id: j.id, status: j.status, attempts: j.attempts, lastError: j.last_error, updatedAt: j.updated_at };
  return {
    id: t.id,
    number: t.number,
    status: t.status,
    priority: t.priority,
    category: t.category,
    description: t.description,
    customer: { id: t.customer_id, name: t.name, phone: t.phone, email: t.email, orgName: t.org_name, ticketCount: customerTickets.rows[0].n },
    categorySource: t.category_source,
    ai: { status: t.ai_status, source: t.triage_source, category: t.ai_category, priority: t.ai_priority, summary: t.ai_summary, reason: t.ai_reason },
    duplicateOf: t.duplicate_number ?? null,
    meta: t.meta,
    createdAt: t.created_at,
    updatedAt: t.updated_at,
    resolvedAt: t.resolved_at,
    attachments: attachments.rows.map((a) => ({ id: a.id, fileName: a.file_name, mimeType: a.mime_type, size: a.size_bytes, driveUrl: a.drive_url, createdAt: a.created_at })),
    events: events.rows.map((e) => ({ id: e.id, actorType: e.actor_type, actorLabel: e.actor_label, type: e.type, data: e.data, createdAt: e.created_at })),
    sync,
  };
}

// ---------------------------------------------------------------------------
// Admin writes
// ---------------------------------------------------------------------------

export const ticketPatchSchema = z.object({
  status: z.enum(STATUSES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  category: z.string().trim().max(40).nullable().optional(),
}).refine((v) => v.status !== undefined || v.priority !== undefined || v.category !== undefined, 'Nothing to update');

export interface Actor { id: string; label: string }

export async function updateTicket(db: Db, tenant: Tenant, ticketId: string, raw: unknown, actor: Actor) {
  const patch = ticketPatchSchema.parse(raw);
  const cur = await db.query(`SELECT id, status, priority, category FROM tickets WHERE id = $1 AND tenant_id = $2 FOR UPDATE`, [ticketId, tenant.id]);
  const t = cur.rows[0];
  if (!t) throw notFound('Ticket not found.');
  if (patch.category && !tenant.config.categories.includes(patch.category)) {
    throw new HttpError(422, 'validation_failed', 'Unknown category.');
  }

  const sets: string[] = [];
  const args: unknown[] = [];
  const changes: Array<{ type: string; from: unknown; to: unknown }> = [];

  if (patch.status && patch.status !== t.status) {
    args.push(patch.status); sets.push(`status = $${args.length}`);
    const to = patch.status as TicketStatus;
    if (to === 'resolved') sets.push('resolved_at = now()');
    if (to === 'closed') sets.push('closed_at = now(), resolved_at = coalesce(resolved_at, now())');
    if (to === 'open' || to === 'in_progress') sets.push('resolved_at = NULL, closed_at = NULL');
    changes.push({ type: 'status_changed', from: t.status, to });
  }
  if (patch.priority && patch.priority !== t.priority) {
    args.push(patch.priority as TicketPriority); sets.push(`priority = $${args.length}`);
    changes.push({ type: 'priority_changed', from: t.priority, to: patch.priority });
  }
  if (patch.category !== undefined && (patch.category || null) !== t.category) {
    args.push(patch.category || null); sets.push(`category = $${args.length}`, `category_source = 'agent'`);
    changes.push({ type: 'category_changed', from: t.category, to: patch.category || null });
  }
  if (!sets.length) return { changed: false };

  args.push(ticketId);
  await db.query(`UPDATE tickets SET ${sets.join(', ')}, updated_at = now() WHERE id = $${args.length}`, args);
  for (const c of changes) {
    await addEvent(db, tenant.id, ticketId, { actorType: 'admin', actorId: actor.id, actorLabel: actor.label, type: c.type, data: { from: c.from, to: c.to } });
  }
  await requeueSheetSync(db, tenant.id, ticketId);
  return { changed: true };
}

export const noteSchema = z.object({ body: z.string().transform((s) => cleanText(s).trim()).pipe(z.string().min(1, 'Write a note first').max(4000)) });

export async function addNote(db: Db, tenantId: string, ticketId: string, raw: unknown, actor: Actor) {
  const { body } = noteSchema.parse(raw);
  const exists = await db.query(`SELECT 1 FROM tickets WHERE id = $1 AND tenant_id = $2`, [ticketId, tenantId]);
  if (!exists.rowCount) throw notFound('Ticket not found.');
  await addEvent(db, tenantId, ticketId, { actorType: 'admin', actorId: actor.id, actorLabel: actor.label, type: 'note', data: { body } });
  await db.query(`UPDATE tickets SET updated_at = now() WHERE id = $1`, [ticketId]);
}

async function requeueSheetSync(db: Db, tenantId: string, ticketId: string) {
  const g = await db.query(`SELECT status FROM integrations WHERE tenant_id = $1 AND provider = 'google'`, [tenantId]);
  await enqueueJob(db, tenantId, ticketId, 'sheet_sync' as JobKind, { blocked: g.rows[0]?.status !== 'connected' });
}
