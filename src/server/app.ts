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
