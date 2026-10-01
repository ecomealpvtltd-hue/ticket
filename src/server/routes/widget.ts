// Public widget API. Everything here is reachable with nothing but a publishable key,
// so it can only (a) describe the widget and (b) create tickets. It never returns ticket data.

import { withTenant } from '../db.js';
import { env } from '../env.js';
import { sign, sha256Hex, verify, randomToken } from '../crypto.js';
import { HttpError, isSameOriginRequest, json, readJson, type Ctx, type Router } from '../http.js';
import { log, errorMessage } from '../log.js';
import { enforce } from '../services/ratelimit.js';
import { originAllowed, resolveWidgetKey, touchWidgetKey, type ResolvedKey } from '../services/tenants.js';
import { createTicket, validateTicketInput } from '../services/tickets.js';
import { runJobs } from '../services/jobs.js';
import { detectFileType, sanitizeFileName } from '../files.js';
import { getBlobStore } from '../storage.js';
import { MAX_ATTACHMENT_BYTES } from '../../shared/model.js';
import { notify } from '../notifications/index.js';

const EMBED_TOKEN_TTL = 12 * 3600;

/** Issued inside the embed page; binds widget API calls to a real embed load for this key. */
export function issueEmbedToken(r: ResolvedKey): string {
  return sign('embed', { t: r.tenant.id, k: r.keyId }, EMBED_TOKEN_TTL);
}

async function resolveFromEmbed(ctx: Ctx): Promise<ResolvedKey> {
  // Calls must come from our own embed iframe (same origin), not from arbitrary sites.
  if (!isSameOriginRequest(ctx.req, env.baseUrl)) {
    throw new HttpError(403, 'origin_not_allowed', 'This request is not allowed.');
  }
  const key = ctx.req.headers.get('x-widget-key') ?? '';
  const token = verify<{ t: string; k: string }>('embed', ctx.req.headers.get('x-embed-token'));
  const resolved = await resolveWidgetKey(key);
  if (!resolved) throw new HttpError(401, 'invalid_key', 'This support widget is not configured correctly.');
  if (!token || token.t !== resolved.tenant.id || token.k !== resolved.keyId) {
    throw new HttpError(401, 'session_expired', 'Your session expired. Close and reopen support to continue.');
  }
  return resolved;
}

function launcherConfig(r: ResolvedKey) {
  const c = r.tenant.config;
  return {
    brand: c.brand.name,
    title: c.copy.title,
    launcher: c.launcher,
    theme: { accent: c.theme.accent, accentText: c.theme.accentText, mode: c.theme.mode, background: c.theme.background ?? null },
    embedUrl: `${env.baseUrl}/embed/${encodeURIComponent(r.publicKey)}`,
  };
}

export function registerWidgetRoutes(router: Router) {
  // Preflight for the loader's cross-origin config fetch.
  router.on('OPTIONS', '/api/widget/config', async (ctx) => {
    const origin = ctx.req.headers.get('origin') ?? '';
    return new Response(null, {
      status: 204,
      headers: { 'access-control-allow-origin': origin || '*', 'access-control-allow-methods': 'GET', 'access-control-max-age': '600', vary: 'Origin' },
    });
  });

  /** Called by widget.js on the customer's website. */
  router.on('GET', '/api/widget/config', async (ctx) => {
    // Browsers omit Origin on some same-site GETs (e.g. ecomeal.in → support.ecomeal.in),
    // so fall back to the Referer's origin. If a site sends neither, we can't tell and allow
    // the (public) launcher config; the embed itself is still locked by frame-ancestors.
    const origin = ctx.req.headers.get('origin') ?? safeOrigin(ctx.req.headers.get('referer') ?? '');
    const cors: Record<string, string> = { vary: 'Origin, Referer', 'access-control-allow-origin': origin ?? '*' };

    const key = ctx.url.searchParams.get('key') ?? '';
    const resolved = await resolveWidgetKey(key);
    if (!resolved) {
      return json({ error: { code: 'invalid_key', message: 'Unknown or revoked widget key.' } }, 404, cors);
    }
    // The platform's own origin is always allowed (the hosted /demo page).
    const own = origin === new URL(env.baseUrl).origin;
    if (origin && !own && !originAllowed(origin, resolved.tenant.allowedOrigins)) {
      return json({ error: { code: 'origin_not_allowed', message: `This website (${origin}) is not in the widget's allowed domains.` } }, 403, cors);
    }
    ctx.waitUntil(touchWidgetKey(resolved.tenant.id, resolved.keyId, origin).catch((e) => log.warn('widget.touch_failed', { message: errorMessage(e) })));
    return json(launcherConfig(resolved), 200, { ...cors, 'cache-control': 'public, max-age=60' });
  });

  /** Upload one attachment. Files upload as soon as they are chosen; the ticket references them. */
  router.on('POST', '/api/widget/uploads', async (ctx) => {
    const resolved = await resolveFromEmbed(ctx);
    const tenant = resolved.tenant;
    if (!tenant.config.form.allowAttachments) throw new HttpError(403, 'attachments_disabled', 'Attachments are not enabled.');
    await enforce([
      [`up:ip:${ctx.ip}`, 30, 600],
      [`up:tenant:${tenant.id}`, 1000, 3600],
    ]);

    const len = Number(ctx.req.headers.get('content-length') ?? '0');
    if (len > MAX_ATTACHMENT_BYTES + 64 * 1024) {
      throw new HttpError(413, 'file_too_large', 'This file is larger than 4 MB.');
    }
    let form: FormData;
    try {
      form = await ctx.req.formData();
    } catch {
      throw new HttpError(400, 'bad_upload', "We couldn't read this file. Try again.");
    }
    const file = form.get('file');
    if (!(file instanceof File)) throw new HttpError(400, 'bad_upload', 'No file received.');
    if (file.size === 0) throw new HttpError(422, 'empty_file', 'This file is empty.');
    if (file.size > MAX_ATTACHMENT_BYTES) throw new HttpError(413, 'file_too_large', 'This file is larger than 4 MB.');

    const bytes = new Uint8Array(await file.arrayBuffer());
    const type = detectFileType(bytes, file.name);
    if (!type) {
      throw new HttpError(415, 'unsupported_type', 'This file type is not supported. Use an image, PDF, text, Word or Excel file.');
    }
    const fileName = sanitizeFileName(file.name, type.ext);
    const hash = sha256Hex(bytes);
    const blobKey = `${tenant.id}/${new Date().toISOString().slice(0, 7)}/${randomToken(16)}.${type.ext}`;

    try {
      await getBlobStore().put(blobKey, bytes, { tenant: tenant.id, type: type.mime });
    } catch (err) {
      log.error('upload.storage_failed', { tenant: tenant.slug, message: errorMessage(err) });
      throw new HttpError(503, 'storage_unavailable', "We couldn't upload this file. Try again.");
    }
    const row = await withTenant(tenant.id, (db) =>
      db.query(
        `INSERT INTO attachments (tenant_id, file_name, mime_type, size_bytes, sha256, blob_key)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [tenant.id, fileName, type.mime, bytes.byteLength, hash, blobKey],
      ),
    );
    log.info('upload.stored', { tenant: tenant.slug, size: bytes.byteLength, type: type.mime });
    return json({ id: row.rows[0].id, fileName, size: bytes.byteLength, mimeType: type.mime }, 201);
  });

  /** Create a ticket. The response is sent as soon as the database commit succeeds. */
  router.on('POST', '/api/widget/tickets', async (ctx) => {
    const resolved = await resolveFromEmbed(ctx);
    const tenant = resolved.tenant;
    const body = (await readJson(ctx.req, 32 * 1024)) as Record<string, unknown>;

    // Bot checks that cost humans nothing.
    if (typeof body.website === 'string' && body.website.trim() !== '') {
      throw new HttpError(400, 'rejected', 'This request could not be processed.');
    }
    if (typeof body.elapsed === 'number' && body.elapsed < 3) {
      throw new HttpError(429, 'too_fast', 'Please take a moment to review your ticket and submit again.');
    }

    const input = validateTicketInput(body, tenant);
    await enforce([
      [`tk:ip:${ctx.ip}`, 10, 600],
      [`tk:phone:${tenant.id}:${sha256Hex(input.phone).slice(0, 16)}`, 6, 3600],
      [`tk:tenant:${tenant.id}`, 500, 3600],
    ]);

    // The embed reports the host page (document.referrer); informational only.
    const pageUrl = input.pageUrl && /^https?:\/\//.test(input.pageUrl) ? input.pageUrl.slice(0, 500) : null;
    const created = await withTenant(tenant.id, async (db) => {
      const g = await db.query(`SELECT status FROM integrations WHERE tenant_id = $1 AND provider = 'google'`, [tenant.id]);
      return createTicket(db, tenant, input,
        { userAgent: ctx.req.headers.get('user-agent'), pageUrl, origin: pageUrl ? safeOrigin(pageUrl) : null },
        { googleConnected: g.rows[0]?.status === 'connected' });
    });

    log.info('ticket.created', { tenant: tenant.slug, ticket: created.number, attachments: input.attachmentIds.length });

    // Integrations run after the response. If this is cut short, the scheduled runner catches up.
    ctx.waitUntil(
      (async () => {
        await runJobs({ ticketId: created.id, budgetMs: 8_000 }).catch((e) => log.warn('jobs.inline_failed', { message: errorMessage(e) }));
        await notify({ type: 'ticket.created', tenantSlug: tenant.slug, ticketNumber: created.number, priority: 'medium' });
      })(),
    );
    return json({ ticket: { number: created.number } }, 201);
  });
}

function safeOrigin(u: string): string | null {
  try { return new URL(u).origin; } catch { return null; }
}
