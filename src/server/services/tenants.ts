import { withSystem, withTenant, type Db } from '../db.js';
import { parseTenantConfigLenient, type TenantConfig } from '../../shared/model.js';

export interface Tenant {
  id: string;
  slug: string;
  name: string;
  status: 'active' | 'suspended';
  ticketPrefix: string;
  config: TenantConfig;
  allowedOrigins: string[];
}

export function rowToTenant(r: any): Tenant {
  return {
    id: r.id,
    slug: r.slug,
    name: r.name,
    status: r.status,
    ticketPrefix: r.ticket_prefix,
    config: parseTenantConfigLenient(r.config),
    allowedOrigins: r.allowed_origins ?? [],
  };
}

export interface ResolvedKey { tenant: Tenant; keyId: string; publicKey: string }

/** Look up an active tenant by its publishable widget key. */
export async function resolveWidgetKey(publicKey: string): Promise<ResolvedKey | null> {
  if (!/^pk_(live|test)_[A-Za-z0-9_-]{16,64}$/.test(publicKey)) return null;
  return withSystem(async (db) => {
    const r = await db.query(
      `SELECT t.*, k.id AS key_id, k.public_key
         FROM widget_keys k JOIN tenants t ON t.id = k.tenant_id
        WHERE k.public_key = $1 AND k.revoked_at IS NULL AND t.status = 'active'`,
      [publicKey],
    );
    if (!r.rows[0]) return null;
    return { tenant: rowToTenant(r.rows[0]), keyId: r.rows[0].key_id, publicKey: r.rows[0].public_key };
  });
}

/** Records that the widget was seen on a site (drives the "Installed" status). Throttled. */
export async function touchWidgetKey(tenantId: string, keyId: string, origin: string | null): Promise<void> {
  await withTenant(tenantId, (db) =>
    db.query(
      `UPDATE widget_keys SET last_seen_at = now(), last_seen_origin = coalesce($2, last_seen_origin)
        WHERE id = $1 AND (last_seen_at IS NULL OR last_seen_at < now() - interval '5 minutes'
                           OR last_seen_origin IS DISTINCT FROM $2)`,
      [keyId, origin],
    ),
  );
}

export async function getTenant(db: Db, tenantId: string): Promise<Tenant> {
  const r = await db.query('SELECT * FROM tenants WHERE id = $1', [tenantId]);
  if (!r.rows[0]) throw new Error('Tenant not found');
  return rowToTenant(r.rows[0]);
}

// ---------------------------------------------------------------------------
// Allowed origins
// ---------------------------------------------------------------------------

export const ORIGIN_PATTERN = /^https?:\/\/(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{2,5})?$/;

export function isValidOriginPattern(p: string): boolean {
  if (!ORIGIN_PATTERN.test(p)) return false;
  // Plain http is only acceptable for local development hosts.
  if (p.startsWith('http://') && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(p)) return false;
  return true;
}

export function originAllowed(origin: string | null, patterns: string[]): boolean {
  if (!origin) return false;
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return false;
  }
  const actual = `${u.protocol}//${u.host}`.toLowerCase();
  for (const p of patterns) {
    const pat = p.toLowerCase();
    if (pat === actual) return true;
    const m = /^(https?:)\/\/\*\.(.+)$/.exec(pat);
    if (m && u.protocol === m[1]) {
      const suffix = '.' + m[2];
      if (u.host.endsWith(suffix) && u.host.length > suffix.length) return true;
    }
  }
  return false;
}

/** CSP frame-ancestors value. An empty list means the widget may not be embedded anywhere. */
export function frameAncestors(patterns: string[], extra: string[] = []): string {
  const valid = [...patterns.filter(isValidOriginPattern), ...extra];
  return valid.length ? valid.join(' ') : "'none'";
}
