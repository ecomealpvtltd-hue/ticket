import { withTenant } from '../db.js';
import { env, googleConfigured } from '../env.js';
import { randomToken, sign, verify } from '../crypto.js';
import { cookie, getCookie, HttpError, json, readJson, redirect, type Ctx, type Router } from '../http.js';
import { log, errorMessage, maskEmail } from '../log.js';
import { clearSessionCookie, createSession, getSession, membershipsForEmail, recordAdminName, requireAdmin, revokeSession } from '../services/auth.js';
import { enforce } from '../services/ratelimit.js';
import { getTenant } from '../services/tenants.js';
import { authUrl, CONNECT_SCOPES, connectGoogle, decodeIdToken, exchangeCode, LOGIN_SCOPES } from '../integrations/google.js';
import { runJobs } from '../services/jobs.js';

const NONCE_COOKIE = 'sp_oauth';
const secure = () => env.baseUrl.startsWith('https://');
const loginRedirectUri = () => `${env.baseUrl}/api/auth/google/callback`;
const connectRedirectUri = () => `${env.baseUrl}/api/integrations/google/callback`;

function safeNext(next: string | null): string {
  return next && /^\/admin(\/[A-Za-z0-9/_\-?=&.%]*)?$/.test(next) ? next : '/admin';
}

function oauthStart(ctx: Ctx, purpose: 'login' | 'connect', data: Record<string, unknown>, url: (state: string) => string) {
  const nonce = randomToken(16);
  const state = sign(purpose, { ...data, n: nonce }, 600);
  return redirect(url(state), { 'set-cookie': cookie(NONCE_COOKIE, nonce, { secure: secure(), maxAge: 600, sameSite: 'Lax' }) });
}

function oauthState<T extends Record<string, unknown>>(ctx: Ctx, purpose: 'login' | 'connect'): T & { n: string } {
  const state = verify<T & { n: string }>(purpose, ctx.url.searchParams.get('state'));
  const nonce = getCookie(ctx.req, NONCE_COOKIE);
  if (!state || !nonce || state.n !== nonce) throw new HttpError(400, 'bad_state', 'Sign-in link expired. Please try again.');
  return state;
}

export function registerAuthRoutes(router: Router) {
  // ---------------------------------------------------------------------------
  // Admin sign-in with Google
  // ---------------------------------------------------------------------------
  router.on('GET', '/api/auth/google/start', async (ctx) => {
    if (!googleConfigured()) return redirect('/admin/login?error=google_not_configured');
    const next = safeNext(ctx.url.searchParams.get('next'));
    return oauthStart(ctx, 'login', { next }, (state) =>
      authUrl({ scopes: LOGIN_SCOPES, redirectUri: loginRedirectUri(), state }));
  });

  router.on('GET', '/api/auth/google/callback', async (ctx) => {
    const clearNonce = cookie(NONCE_COOKIE, '', { secure: secure(), maxAge: 0 });
    try {
      if (ctx.url.searchParams.get('error')) return redirect('/admin/login?error=cancelled', { 'set-cookie': clearNonce });
      await enforce([[`login:ip:${ctx.ip}`, 30, 600]]);
      const state = oauthState<{ next: string }>(ctx, 'login');
      const code = ctx.url.searchParams.get('code');
      if (!code) throw new HttpError(400, 'bad_request', 'Missing code');
      const tokens = await exchangeCode(code, loginRedirectUri());
      if (!tokens.id_token) throw new Error('Google did not return an identity token');
      const id = decodeIdToken(tokens.id_token);
      if (!id.email || !id.emailVerified) return redirect('/admin/login?error=unverified', { 'set-cookie': clearNonce });

      const memberships = await membershipsForEmail(id.email);
      if (!memberships.length) {
        log.warn('auth.no_access', { email: maskEmail(id.email) });
        return redirect('/admin/login?error=no_access', { 'set-cookie': clearNonce });
      }
      const preferred = getCookie(ctx.req, 'sp_tenant');
      const m = memberships.find((x) => x.tenant_id === preferred) ?? memberships[0];
      await withTenant(m.tenant_id, (db) => recordAdminName(db, m.admin_id, id.name));
      const sessionCookie = await createSession(m.admin_id, m.tenant_id, ctx.req.headers.get('user-agent'));
      log.info('auth.login', { tenant: m.slug, role: m.role });
      const h = new Headers();
      h.append('set-cookie', sessionCookie);
      h.append('set-cookie', clearNonce);
      return redirect(safeNext(state.next), h);
    } catch (err) {
      log.warn('auth.callback_failed', { message: errorMessage(err) });
      return redirect('/admin/login?error=failed', { 'set-cookie': clearNonce });
    }
  });

  /** Public: what the sign-in page should offer. */
  router.on('GET', '/api/auth/config', async (ctx) => {
    const host = ctx.url.hostname;
    const devLogin = env.appEnv === 'development' && env.devLoginEnabled && (host === 'localhost' || host === '127.0.0.1');
    return json({ google: googleConfigured(), devLogin });
  });

  router.on('POST', '/api/auth/logout', async (ctx) => {
    const s = await getSession(ctx.req);
    if (s) await revokeSession(s.id);
    return json({ ok: true }, 200, { 'set-cookie': clearSessionCookie() });
  });

  /** Switch between workspaces for people who administer more than one tenant. */
  router.on('POST', '/api/auth/switch', async (ctx) => {
    const s = await requireAdmin(ctx.req);
    const { tenantId } = (await readJson(ctx.req)) as { tenantId?: string };
    const m = (await membershipsForEmail(s.admin.email)).find((x) => x.tenant_id === tenantId);
    if (!m) throw new HttpError(403, 'forbidden', 'You do not have access to that workspace.');
    await revokeSession(s.id);
    const h = new Headers();
    h.append('set-cookie', await createSession(m.admin_id, m.tenant_id, ctx.req.headers.get('user-agent')));
    h.append('set-cookie', cookie('sp_tenant', m.tenant_id, { secure: secure(), maxAge: 365 * 86400 }));
    return json({ ok: true }, 200, h);
  });

  /**
   * Local development only: sign in as an existing admin without Google.
   * Requires APP_ENV=development, DEV_LOGIN=true AND a localhost request. Never active in production.
   */
  router.on('POST', '/api/auth/dev-login', async (ctx) => {
    const host = ctx.url.hostname;
    if (env.appEnv !== 'development' || !env.devLoginEnabled || !(host === 'localhost' || host === '127.0.0.1')) {
      throw new HttpError(404, 'not_found', 'Not found.');
    }
    const { email } = (await readJson(ctx.req)) as { email?: string };
    const m = (await membershipsForEmail(String(email ?? '')))[0];
    if (!m) throw new HttpError(403, 'no_access', 'No admin with that email.');
    return json({ ok: true }, 200, { 'set-cookie': await createSession(m.admin_id, m.tenant_id, 'dev-login') });
  });

  // ---------------------------------------------------------------------------
  // Tenant connects Google Drive + Sheets
  // ---------------------------------------------------------------------------
  router.on('GET', '/api/integrations/google/start', async (ctx) => {
    const s = await requireAdmin(ctx.req, 'admin').catch(() => null);
    if (!s) return redirect('/admin/login?next=/admin/integrations');
    if (!googleConfigured()) return redirect('/admin/integrations?error=google_not_configured');
    return oauthStart(ctx, 'connect', { t: s.tenant.id, a: s.admin.id }, (state) =>
      authUrl({ scopes: CONNECT_SCOPES, redirectUri: connectRedirectUri(), state, offline: true, loginHint: s.admin.email }));
  });

  router.on('GET', '/api/integrations/google/callback', async (ctx) => {
    const clearNonce = cookie(NONCE_COOKIE, '', { secure: secure(), maxAge: 0 });
    const back = (q: string) => redirect(`/admin/integrations?${q}`, { 'set-cookie': clearNonce });
    try {
      if (ctx.url.searchParams.get('error')) return back('error=cancelled');
      const s = await requireAdmin(ctx.req, 'admin');
      const state = oauthState<{ t: string; a: string }>(ctx, 'connect');
      if (state.t !== s.tenant.id || state.a !== s.admin.id) return back('error=session_changed');
      const code = ctx.url.searchParams.get('code');
      if (!code) return back('error=failed');
      const tokens = await exchangeCode(code, connectRedirectUri());
      if (!tokens.id_token) throw new Error('Google did not return an identity token');
      const identity = decodeIdToken(tokens.id_token);
      const tenant = await withTenant(s.tenant.id, (db) => getTenant(db, s.tenant.id));
      await connectGoogle(tenant, s.admin.id, tokens, identity);
      log.info('google.connected', { tenant: tenant.slug });
      ctx.waitUntil(runJobs({ budgetMs: 8_000 }).catch(() => {}));
      return back('connected=1');
    } catch (err) {
      log.error('google.connect_failed', { message: errorMessage(err) });
      const msg = errorMessage(err);
      const code = /offline access/i.test(msg) ? 'no_refresh_token' : /Drive access/i.test(msg) ? 'scope_missing' : 'failed';
      // Shown only to the signed-in admin; tokens and secrets never appear in these messages.
      const detail = msg.replace(/[^\x20-\x7e]/g, '').slice(0, 300);
      return back(`error=${code}&detail=${encodeURIComponent(detail)}`);
    }
  });
}

