import { withSystem, type Db } from '../db.js';
import { env } from '../env.js';
import { randomToken, sha256Hex } from '../crypto.js';
import { cookie, forbidden, getCookie, HttpError, isSameOriginRequest, unauthorized } from '../http.js';
import { rowToTenant, type Tenant } from './tenants.js';

export type Role = 'owner' | 'admin' | 'agent' | 'viewer';
export interface AdminUser { id: string; email: string; name: string | null; role: Role; tenantId: string }
export interface Session { id: string; admin: AdminUser; tenant: Tenant }

const SESSION_DAYS = 14;

export const sessionCookieName = () => (env.baseUrl.startsWith('https://') ? '__Host-sp_session' : 'sp_session');
const secureCookies = () => env.baseUrl.startsWith('https://');

const RANK: Record<Role, number> = { viewer: 0, agent: 1, admin: 2, owner: 3 };
export function hasRole(role: Role, min: Role) { return RANK[role] >= RANK[min]; }

export async function createSession(adminId: string, tenantId: string, userAgent: string | null): Promise<string> {
  const token = randomToken(32);
  await withSystem(async (db) => {
    await db.query(
      `INSERT INTO admin_sessions (token_hash, admin_id, tenant_id, expires_at, user_agent)
       VALUES ($1, $2, $3, now() + ($4 || ' days')::interval, $5)`,
      [sha256Hex(token), adminId, tenantId, String(SESSION_DAYS), userAgent?.slice(0, 300) ?? null],
    );
    await db.query(`UPDATE admins SET last_login_at = now() WHERE id = $1`, [adminId]);
    // Housekeeping
    await db.query(`DELETE FROM admin_sessions WHERE expires_at < now() - interval '7 days'`);
  });
  return cookie(sessionCookieName(), token, { secure: secureCookies(), maxAge: SESSION_DAYS * 86400, sameSite: 'Lax' });
}

export function clearSessionCookie(): string {
  return cookie(sessionCookieName(), '', { secure: secureCookies(), maxAge: 0 });
}

export async function getSession(req: Request): Promise<Session | null> {
  const token = getCookie(req, sessionCookieName());
  if (!token || token.length < 20 || token.length > 100) return null;
  return withSystem(async (db) => {
    const r = await db.query(
      `SELECT t.*, s.id AS session_id, a.id AS admin_id, a.email AS admin_email, a.name AS admin_name, a.role AS admin_role
         FROM admin_sessions s
         JOIN admins a ON a.id = s.admin_id AND a.status = 'active'
         JOIN tenants t ON t.id = s.tenant_id AND t.status = 'active'
        WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`,
      [sha256Hex(token)],
    );
    const row = r.rows[0];
    if (!row) return null;
    return {
      id: row.session_id,
      admin: { id: row.admin_id, email: row.admin_email, name: row.admin_name, role: row.admin_role, tenantId: row.id },
      tenant: rowToTenant(row),
    };
  });
}

export async function revokeSession(sessionId: string) {
  await withSystem((db) => db.query(`UPDATE admin_sessions SET revoked_at = now() WHERE id = $1`, [sessionId]));
}

/**
 * Admin API guard. Mutations must come from our own admin app: same origin plus a custom
 * header, which a cross-site form or image tag cannot send (CSRF protection on top of SameSite).
 */
export async function requireAdmin(req: Request, minRole: Role = 'viewer'): Promise<Session> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    if (!isSameOriginRequest(req, env.baseUrl) || req.headers.get('x-requested-with') !== 'fetch') {
      throw new HttpError(403, 'csrf', 'Request blocked. Reload the page and try again.');
    }
  }
  const s = await getSession(req);
  if (!s) throw unauthorized();
  if (!hasRole(s.admin.role, minRole)) throw forbidden('Your role does not allow this action.');
  return s;
}

/** All active tenant memberships for a verified email (used at sign-in). */
export async function membershipsForEmail(email: string) {
  return withSystem(async (db) => {
    const r = await db.query(
      `SELECT a.id AS admin_id, a.role, t.id AS tenant_id, t.name AS tenant_name, t.slug
         FROM admins a JOIN tenants t ON t.id = a.tenant_id
        WHERE a.email = $1 AND a.status = 'active' AND t.status = 'active'
        ORDER BY t.created_at`,
      [email.toLowerCase()],
    );
    return r.rows as Array<{ admin_id: string; role: Role; tenant_id: string; tenant_name: string; slug: string }>;
  });
}

export async function recordAdminName(db: Db, adminId: string, name: string | null) {
  if (name) await db.query(`UPDATE admins SET name = coalesce(name, $2) WHERE id = $1`, [adminId, name.slice(0, 100)]);
}
