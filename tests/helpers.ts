import { randomBytes } from 'node:crypto';
import { withSystem, withTenant } from '../src/server/db.js';
import { createSession } from '../src/server/services/auth.js';
import { handleApi } from '../src/server/app.js';
import { tenantConfigSchema } from '../src/shared/model.js';

export const BASE = 'http://localhost:8888';

export interface TestTenant { id: string; slug: string; key: string; prefix: string; ownerEmail: string; ownerId: string; cookie: string }

let counter = 0;
export function uniqueIp() {
  counter++;
  return `10.${(counter >> 16) & 255}.${(counter >> 8) & 255}.${counter & 255}`;
}

export async function createTestTenant(opts: { prefix?: string; origins?: string[]; config?: Record<string, unknown> } = {}): Promise<TestTenant> {
  const slug = 't-' + randomBytes(4).toString('hex');
  const prefix = opts.prefix ?? 'TST';
  const key = 'pk_test_' + randomBytes(18).toString('base64url');
  const ownerEmail = `owner-${slug}@example.com`;
  const config = tenantConfigSchema.parse({ brand: { name: slug }, categories: ['Technical issue', 'Billing', 'Other'], ...(opts.config ?? {}) });
  const { id, ownerId } = await withSystem(async (db) => {
    const t = await db.query(
      `INSERT INTO tenants (slug, name, ticket_prefix, config, allowed_origins) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [slug, slug, prefix, JSON.stringify(config), opts.origins ?? ['https://customer.example', 'https://*.customer.example']],
    );
    await db.query(`INSERT INTO widget_keys (tenant_id, public_key) VALUES ($1, $2)`, [t.rows[0].id, key]);
    const a = await db.query(`INSERT INTO admins (tenant_id, email, role) VALUES ($1, $2, 'owner') RETURNING id`, [t.rows[0].id, ownerEmail]);
    return { id: t.rows[0].id as string, ownerId: a.rows[0].id as string };
  });
  const setCookie = await createSession(ownerId, id, 'test');
  const cookie = setCookie.split(';')[0];
  return { id, slug, key, prefix, ownerEmail, ownerId, cookie };
}

/** Pull the embed token out of the rendered embed page, exactly as the widget does. */
export async function embedToken(t: TestTenant): Promise<string> {
  const { handleEmbed } = await import('../src/server/app.js');
  const res = await handleEmbed(new Request(`${BASE}/embed/${t.key}`));
  const html = await res.text();
  const m = /<script type="application\/json" id="sp-boot">(.*?)<\/script>/s.exec(html);
  if (!m) throw new Error('No boot data in embed page');
  return JSON.parse(m[1]).token;
}

export function widgetHeaders(t: TestTenant, token: string, ip = uniqueIp()): Record<string, string> {
  return { origin: BASE, 'x-widget-key': t.key, 'x-embed-token': token, 'x-forwarded-for': ip };
}

let phoneSeq = 0;
/** A fresh valid Indian mobile number per call, so per-phone rate limits don't interfere. */
export const nextPhone = () => `9${String(800000000 + ++phoneSeq * 7919).padStart(9, '0').slice(-9)}`;

export const validTicket = (over: Record<string, unknown> = {}) => ({
  name: 'Rahul Sharma',
  country: 'IN',
  phone: nextPhone(),
  orgName: 'ABC Cafe',
  description: 'Unable to receive orders since 7 PM, the POS shows a sync error.',
  elapsed: 20,
  ...over,
});

export async function submitTicket(t: TestTenant, token: string, body: Record<string, unknown> = validTicket(), ip?: string) {
  const res = await handleApi(new Request(`${BASE}/api/widget/tickets`, {
    method: 'POST',
    headers: { ...widgetHeaders(t, token, ip), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
  return { res, data: (await res.json()) as any };
}

export async function upload(t: TestTenant, token: string, name: string, bytes: Uint8Array, type = 'application/octet-stream') {
  const fd = new FormData();
  fd.append('file', new File([bytes as unknown as BlobPart], name, { type }));
  const res = await handleApi(new Request(`${BASE}/api/widget/uploads`, { method: 'POST', headers: widgetHeaders(t, token), body: fd }));
  return { res, data: (await res.json()) as any };
}

export async function admin(t: TestTenant | { cookie: string }, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { cookie: t.cookie };
  if (method !== 'GET') {
    headers.origin = BASE;
    headers['x-requested-with'] = 'fetch';
    headers['content-type'] = 'application/json';
  }
  const res = await handleApi(new Request(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }));
  const text = await res.text();
  let data: any = null;
  try { data = JSON.parse(text); } catch { data = text; }
  return { res, data };
}

export async function ticketCount(tenantId: string) {
  return withTenant(tenantId, async (db) => (await db.query(`SELECT count(*)::int AS n FROM tickets`)).rows[0].n as number);
}

// A 1x1 PNG
export const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
export const PDF = new TextEncoder().encode('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
