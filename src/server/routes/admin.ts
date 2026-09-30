import { z } from 'zod';
import { withTenant } from '../db.js';
import { env, googleConfigured } from '../env.js';
import { newPublicKey } from '../crypto.js';
import { HttpError, json, notFound, readJson, type Router } from '../http.js';
import { log, errorMessage } from '../log.js';
import { membershipsForEmail, requireAdmin, hasRole, type Role } from '../services/auth.js';
import { addNote, getTicketDetail, listTickets, overview, updateTicket } from '../services/tickets.js';
import { retryJob, runJobs } from '../services/jobs.js';
import { getTenant, isValidOriginPattern } from '../services/tenants.js';
import { getBlobStore } from '../storage.js';
import { aiAvailable } from '../ai/index.js';
import { disconnectGoogle } from '../integrations/google.js';
import { tenantConfigSchema } from '../../shared/model.js';

const uuid = z.uuid();

export function registerAdminRoutes(router: Router) {
  router.on('GET', '/api/admin/me', async (ctx) => {
    const s = await requireAdmin(ctx.req);
    const memberships = await membershipsForEmail(s.admin.email);
    return json({
      admin: s.admin,
      tenant: { id: s.tenant.id, name: s.tenant.name, slug: s.tenant.slug, ticketPrefix: s.tenant.ticketPrefix, config: s.tenant.config },
      memberships: memberships.map((m) => ({ tenantId: m.tenant_id, name: m.tenant_name, role: m.role })),
      platform: { googleConfigured: googleConfigured(), aiConfigured: aiAvailable(), baseUrl: env.baseUrl, appEnv: env.appEnv },
    });
  });

  router.on('GET', '/api/admin/overview', async (ctx) => {
    const s = await requireAdmin(ctx.req);
    return json(await withTenant(s.tenant.id, (db) => overview(db, s.tenant.id)));
  });

  // ---------------------------------------------------------------------------
  // Tickets
  // ---------------------------------------------------------------------------
  router.on('GET', '/api/admin/tickets', async (ctx) => {
    const s = await requireAdmin(ctx.req);
    const q = Object.fromEntries(ctx.url.searchParams.entries());
    return json(await withTenant(s.tenant.id, (db) => listTickets(db, s.tenant.id, q)));
  });

  router.on('GET', '/api/admin/tickets/:ref', async (ctx) => {
    const s = await requireAdmin(ctx.req);
    return json(await withTenant(s.tenant.id, (db) => getTicketDetail(db, s.tenant.id, ctx.params.ref)));
  });

  router.on('PATCH', '/api/admin/tickets/:id', async (ctx) => {
    const s = await requireAdmin(ctx.req, 'agent');
    if (!uuid.safeParse(ctx.params.id).success) throw notFound('Ticket not found.');
    const body = await readJson(ctx.req);
    const actor = { id: s.admin.id, label: s.admin.name ?? s.admin.email };
    const result = await withTenant(s.tenant.id, async (db) => {
      const r = await updateTicket(db, s.tenant, ctx.params.id, body, actor);
      return { ...r, ticket: await getTicketDetail(db, s.tenant.id, ctx.params.id) };
    });
    if (result.changed) ctx.waitUntil(runJobs({ ticketId: ctx.params.id, budgetMs: 6_000 }).catch(() => {}));
    return json(result.ticket);
  });

  router.on('POST', '/api/admin/tickets/:id/notes', async (ctx) => {
    const s = await requireAdmin(ctx.req, 'agent');
    if (!uuid.safeParse(ctx.params.id).success) throw notFound('Ticket not found.');
    const body = await readJson(ctx.req, 16 * 1024);
    const actor = { id: s.admin.id, label: s.admin.name ?? s.admin.email };
    const ticket = await withTenant(s.tenant.id, async (db) => {
      await addNote(db, s.tenant.id, ctx.params.id, body, actor);
      return getTicketDetail(db, s.tenant.id, ctx.params.id);
    });
    return json(ticket, 201);
  });

  /** Attachment bytes, only for signed-in members of the owning tenant. */
  router.on('GET', '/api/admin/attachments/:id', async (ctx) => {
    const s = await requireAdmin(ctx.req);
    if (!uuid.safeParse(ctx.params.id).success) throw notFound();
    const a = await withTenant(s.tenant.id, async (db) => {
      const r = await db.query(`SELECT file_name, mime_type, blob_key FROM attachments WHERE id = $1 AND ticket_id IS NOT NULL`, [ctx.params.id]);
      return r.rows[0];
    });
    if (!a) throw notFound('Attachment not found.');
    const data = await getBlobStore().get(a.blob_key);
    if (!data) throw new HttpError(410, 'gone', 'This file is no longer available.');
    const inline = ctx.url.searchParams.get('inline') === '1' && a.mime_type.startsWith('image/');
    const name = a.file_name.replace(/["\\]/g, '');
    return new Response(data as unknown as BodyInit, {
      headers: {
        'content-type': a.mime_type,
        'content-length': String(data.byteLength),
        'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${name.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`,
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
        'cache-control': 'private, max-age=300',
      },
    });
  });

  router.on('POST', '/api/admin/jobs/:id/retry', async (ctx) => {
    const s = await requireAdmin(ctx.req, 'agent');
    if (!uuid.safeParse(ctx.params.id).success) throw notFound();
    const ticketId = await withTenant(s.tenant.id, async (db) => {
      const r = await db.query(`SELECT ticket_id FROM integration_jobs WHERE id = $1`, [ctx.params.id]);
      if (!r.rows[0]) throw notFound('Job not found.');
      await retryJob(db, s.tenant.id, ctx.params.id);
      return r.rows[0].ticket_id as string;
    });
    // Run now so the admin sees the result on refresh.
    await runJobs({ ticketId, budgetMs: 8_000 }).catch((e) => log.warn('jobs.retry_run_failed', { message: errorMessage(e) }));
    return json({ ok: true });
  });

  // ---------------------------------------------------------------------------
  // Widget installation
  // ---------------------------------------------------------------------------
  router.on('GET', '/api/admin/widget', async (ctx) => {
    const s = await requireAdmin(ctx.req);
    const keys = await withTenant(s.tenant.id, async (db) => {
      const r = await db.query(`SELECT id, public_key, label, created_at, revoked_at, last_seen_at, last_seen_origin FROM widget_keys ORDER BY created_at`);
      return r.rows;
    });
    return json({
      baseUrl: env.baseUrl,
      allowedOrigins: s.tenant.allowedOrigins,
      keys: keys.map((k) => ({ id: k.id, publicKey: k.public_key, label: k.label, createdAt: k.created_at, revokedAt: k.revoked_at, lastSeenAt: k.last_seen_at, lastSeenOrigin: k.last_seen_origin })),
    });
  });

  router.on('PUT', '/api/admin/widget/origins', async (ctx) => {
    const s = await requireAdmin(ctx.req, 'admin');
    const body = z.object({ origins: z.array(z.string().trim().toLowerCase()).max(20) }).parse(await readJson(ctx.req));
    const origins = [...new Set(body.origins.map((o) => o.replace(/\/+$/, '')).filter(Boolean))];
    const bad = origins.filter((o) => !isValidOriginPattern(o));
    if (bad.length) {
      throw new HttpError(422, 'validation_failed', `Not a valid domain: ${bad[0]}. Use the form https://example.com or https://*.example.com.`);
    }
    await withTenant(s.tenant.id, (db) => db.query(`UPDATE tenants SET allowed_origins = $2, updated_at = now() WHERE id = $1`, [s.tenant.id, origins]));
    return json({ allowedOrigins: origins });
  });

  router.on('POST', '/api/admin/widget/keys', async (ctx) => {
    const s = await requireAdmin(ctx.req, 'owner');
    const key = await withTenant(s.tenant.id, async (db) => {
      const active = await db.query(`SELECT count(*)::int AS n FROM widget_keys WHERE revoked_at IS NULL`);
      if (active.rows[0].n >= 5) throw new HttpError(422, 'too_many_keys', 'Revoke an unused key first (limit 5 active keys).');
      const r = await db.query(`INSERT INTO widget_keys (tenant_id, public_key, label) VALUES ($1, $2, $3) RETURNING id, public_key`, [s.tenant.id, newPublicKey(), `Key ${active.rows[0].n + 1}`]);
      return r.rows[0];
    });
    return json({ id: key.id, publicKey: key.public_key }, 201);
  });

  router.on('POST', '/api/admin/widget/keys/:id/revoke', async (ctx) => {
    const s = await requireAdmin(ctx.req, 'owner');
    if (!uuid.safeParse(ctx.params.id).success) throw notFound();
    await withTenant(s.tenant.id, async (db) => {
      const active = await db.query(`SELECT count(*)::int AS n FROM widget_keys WHERE revoked_at IS NULL`);
      if (active.rows[0].n <= 1) throw new HttpError(422, 'last_key', 'Create a new key before revoking the last active one.');
      const r = await db.query(`UPDATE widget_keys SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`, [ctx.params.id]);
      if (!r.rowCount) throw notFound('Key not found.');
    });
    return json({ ok: true });
  });

  // ---------------------------------------------------------------------------
  // Integrations
  // ---------------------------------------------------------------------------
  router.on('GET', '/api/admin/integrations', async (ctx) => {
    const s = await requireAdmin(ctx.req);
    return json(await withTenant(s.tenant.id, async (db) => {
      const g = await db.query(`SELECT status, account_email, settings, last_error, updated_at FROM integrations WHERE provider = 'google'`);
      const counts = await db.query(
        `SELECT count(DISTINCT ticket_id) FILTER (WHERE status = 'blocked')::int AS waiting,
                count(DISTINCT ticket_id) FILTER (WHERE status IN ('pending','running'))::int AS queued
           FROM integration_jobs WHERE kind IN ('sheet_sync','drive_upload')`,
      );
      const failed = await db.query(
        `SELECT j.id, j.kind, j.attempts, j.last_error, j.updated_at, t.number
           FROM integration_jobs j JOIN tickets t ON t.id = j.ticket_id
          WHERE j.status = 'failed' ORDER BY j.updated_at DESC LIMIT 20`,
      );
      const row = g.rows[0];
      return {
        googleConfigured: googleConfigured(),
        aiConfigured: aiAvailable(),
        google: row ? {
          status: row.status,
          accountEmail: row.account_email,
          folderUrl: row.settings?.rootFolderUrl ?? null,
          spreadsheetUrl: row.settings?.spreadsheetUrl ?? null,
          lastError: row.last_error,
          updatedAt: row.updated_at,
        } : null,
        queue: counts.rows[0],
        failedJobs: failed.rows.map((j) => ({ id: j.id, kind: j.kind, attempts: j.attempts, lastError: j.last_error, updatedAt: j.updated_at, ticketNumber: j.number })),
      };
    }));
  });

  router.on('POST', '/api/admin/integrations/google/disconnect', async (ctx) => {
    const s = await requireAdmin(ctx.req, 'admin');
    await withTenant(s.tenant.id, (db) => disconnectGoogle(db, s.tenant.id));
    return json({ ok: true });
  });

  // ---------------------------------------------------------------------------
  // Settings: branding, copy, form, categories
  // ---------------------------------------------------------------------------
  router.on('PUT', '/api/admin/settings', async (ctx) => {
    const s = await requireAdmin(ctx.req, 'admin');
    const body = (await readJson(ctx.req, 32 * 1024)) as { config?: unknown };
    const config = tenantConfigSchema.parse(body.config);
    await withTenant(s.tenant.id, (db) => db.query(`UPDATE tenants SET config = $2, updated_at = now() WHERE id = $1`, [s.tenant.id, JSON.stringify(config)]));
    return json({ config });
  });

  // ---------------------------------------------------------------------------
  // Team
  // ---------------------------------------------------------------------------
  router.on('GET', '/api/admin/team', async (ctx) => {
    const s = await requireAdmin(ctx.req);
    const rows = await withTenant(s.tenant.id, (db) =>
      db.query(`SELECT id, email, name, role, status, created_at, last_login_at FROM admins ORDER BY created_at`),
    );
    return json({ members: rows.rows.map((r) => ({ id: r.id, email: r.email, name: r.name, role: r.role, status: r.status, createdAt: r.created_at, lastLoginAt: r.last_login_at })) });
  });

  const roleSchema = z.enum(['owner', 'admin', 'agent', 'viewer']);

  router.on('POST', '/api/admin/team', async (ctx) => {
    const s = await requireAdmin(ctx.req, 'admin');
    const body = z.object({ email: z.email('Enter a valid email').transform((e) => e.toLowerCase().trim()), role: roleSchema }).parse(await readJson(ctx.req));
    if (body.role === 'owner' && !hasRole(s.admin.role, 'owner')) throw new HttpError(403, 'forbidden', 'Only an owner can add owners.');
    await withTenant(s.tenant.id, async (db) => {
      try {
        await db.query(`INSERT INTO admins (tenant_id, email, role) VALUES ($1, $2, $3)`, [s.tenant.id, body.email, body.role]);
      } catch (err: any) {
        if (err?.code === '23505') throw new HttpError(409, 'exists', 'This person is already on the team.');
        throw err;
      }
    });
    return json({ ok: true }, 201);
  });

  router.on('PATCH', '/api/admin/team/:id', async (ctx) => {
    const s = await requireAdmin(ctx.req, 'admin');
    if (!uuid.safeParse(ctx.params.id).success) throw notFound();
    const body = z.object({ role: roleSchema.optional(), status: z.enum(['active', 'disabled']).optional() }).parse(await readJson(ctx.req));
    await withTenant(s.tenant.id, async (db) => {
      const cur = await db.query(`SELECT role, status FROM admins WHERE id = $1 FOR UPDATE`, [ctx.params.id]);
      const m = cur.rows[0];
      if (!m) throw notFound('Team member not found.');
      const touchesOwner = m.role === 'owner' || body.role === 'owner';
      if (touchesOwner && !hasRole(s.admin.role, 'owner')) throw new HttpError(403, 'forbidden', 'Only an owner can change owners.');
      const willLoseOwner = m.role === 'owner' && ((body.role && body.role !== 'owner') || body.status === 'disabled');
      if (willLoseOwner) {
        const owners = await db.query(`SELECT count(*)::int AS n FROM admins WHERE role = 'owner' AND status = 'active'`);
        if (owners.rows[0].n <= 1) throw new HttpError(422, 'last_owner', 'A workspace needs at least one active owner.');
      }
      await db.query(`UPDATE admins SET role = coalesce($2, role), status = coalesce($3, status) WHERE id = $1`, [ctx.params.id, body.role ?? null, body.status ?? null]);
      if (body.status === 'disabled') await db.query(`UPDATE admin_sessions SET revoked_at = now() WHERE admin_id = $1 AND revoked_at IS NULL`, [ctx.params.id]);
    });
    return json({ ok: true });
  });
}

export type { Role };
export { getTenant };
