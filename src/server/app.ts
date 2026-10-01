// Composition root: one router for the whole API, shared by Netlify Functions and the local dev server.

import { errorResponse, json, Router, clientIp, type Ctx } from './http.js';
import { registerWidgetRoutes } from './routes/widget.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerAdminRoutes } from './routes/admin.js';
import { renderEmbed } from './routes/embed.js';
import { registerGoogleJobs } from './integrations/google.js';
import { registerAIJobs } from './ai/triage-job.js';
import { log, errorMessage } from './log.js';
import { ensureReady } from './setup/bootstrap.js';

let router: Router | null = null;

export function getRouter(): Router {
  if (!router) {
    router = new Router();
    registerWidgetRoutes(router);
    registerAuthRoutes(router);
    registerAdminRoutes(router);
    router.on('GET', '/api/health', async () => json({ ok: true }));
    registerGoogleJobs();
    registerAIJobs();
  }
  return router;
}

export interface PlatformContext { ip?: string; waitUntil?: (p: Promise<unknown>) => void }

export async function handleApi(req: Request, platform: PlatformContext = {}): Promise<Response> {
  const url = new URL(req.url);
  const pending: Promise<unknown>[] = [];
  const ctx: Ctx = {
    req,
    url,
    params: {},
    ip: clientIp(req, platform),
    waitUntil: (p) => {
      const guarded = p.catch((e) => log.error('background.failed', { message: errorMessage(e) }));
      if (platform.waitUntil) platform.waitUntil(guarded);
      else pending.push(guarded);
    },
  };
  try {
    await ensureReady();
    const match = getRouter().match(req.method, url.pathname);
    if (match === null) return json({ error: { code: 'not_found', message: 'Not found.' } }, 404);
    if (match === 'method_not_allowed') return json({ error: { code: 'method_not_allowed', message: 'Method not allowed.' } }, 405);
    ctx.params = match.params;
    const res = await match.handler(ctx);
    // Without a platform waitUntil (tests, scripts), finish background work before returning
    // so behaviour is deterministic.
    if (pending.length) await Promise.all(pending);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}

export async function handleEmbed(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const key = decodeURIComponent(url.pathname.replace(/^\/embed\//, '').replace(/\/$/, ''));
  try {
    await ensureReady();
    return await renderEmbed(key);
  } catch (err) {
    log.error('embed.failed', { message: errorMessage(err) });
    return new Response('Support is temporarily unavailable.', { status: 503, headers: { 'content-type': 'text/plain' } });
  }
}

/**
 * Hosted demo page: /demo (Ecomeal) or /demo/<tenant-slug>. A plain page with the tenant's
 * widget installed exactly as a customer would, for showing the product without touching a
 * real website.
 */
export async function handleDemo(req: Request): Promise<Response> {
  const slug = new URL(req.url).pathname.replace(/^\/demo\/?/, '').replace(/\/$/, '') || 'ecomeal';
  if (!/^[a-z0-9-]{2,41}$/.test(slug)) return new Response('Not found', { status: 404 });
  try {
    await ensureReady();
    const { withSystem } = await import('./db.js');
    const { env } = await import('./env.js');
    const row = await withSystem(async (db) => (await db.query(
      `SELECT t.name, k.public_key FROM tenants t JOIN widget_keys k ON k.tenant_id = t.id
        WHERE t.slug = $1 AND t.status = 'active' AND k.revoked_at IS NULL ORDER BY k.created_at LIMIT 1`, [slug])).rows[0]);
    if (!row) return new Response('Not found', { status: 404 });
    const esc = (v: string) => v.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(row.name)} support demo</title>
<style>html,body{height:100%;margin:0}body{display:grid;place-items:center;padding:24px;box-sizing:border-box;background:#f4f5f3;color:#5d665f;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;text-align:center}
@media (prefers-color-scheme:dark){body{background:#111413;color:#9aa59d}}p{max-width:34em;margin:0}</style></head>
<body><p>This page stands in for your website. Click <strong>Support</strong> in the corner to raise a ticket.</p>
<script src="${esc(env.baseUrl)}/widget.js" data-key="${esc(row.public_key)}" async></script></body></html>`;
    return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' } });
  } catch (err) {
    log.error('demo.failed', { message: errorMessage(err) });
    return new Response('Demo is temporarily unavailable.', { status: 503 });
  }
}
