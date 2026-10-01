import { describe, it, expect, beforeAll } from 'vitest';
import { handleApi } from '../src/server/app.js';
import { withTenant } from '../src/server/db.js';
import { admin, BASE, createTestTenant, embedToken, PNG, submitTicket, upload, validTicket, type TestTenant } from './helpers.js';

let A: TestTenant, B: TestTenant;
let aTicket: { number: string; id: string };
let aAttachmentId: string;

beforeAll(async () => {
  A = await createTestTenant({ prefix: 'AAA' });
  B = await createTestTenant({ prefix: 'BBB' });
  const tok = await embedToken(A);
  const up = await upload(A, tok, 'secret.png', PNG, 'image/png');
  aAttachmentId = up.data.id;
  const { data } = await submitTicket(A, tok, validTicket({ description: 'Tenant A confidential issue about billing', attachmentIds: [up.data.id] }));
  const id = await withTenant(A.id, async (db) => (await db.query(`SELECT id FROM tickets WHERE number = $1`, [data.ticket.number])).rows[0].id);
  aTicket = { number: data.ticket.number, id };
  await submitTicket(B, await embedToken(B));
});

describe('tenant isolation', () => {
  it("tenant B's ticket list never contains tenant A's tickets", async () => {
    const { res, data } = await admin(B, 'GET', '/api/admin/tickets?q=confidential');
    expect(res.status).toBe(200);
    expect(data.total).toBe(0);
    const all = await admin(B, 'GET', '/api/admin/tickets');
    expect(all.data.tickets.every((x: any) => x.number.startsWith('BBB-'))).toBe(true);
  });

  it("tenant B cannot open tenant A's ticket by number or id", async () => {
    expect((await admin(B, 'GET', `/api/admin/tickets/${aTicket.number}`)).res.status).toBe(404);
    expect((await admin(B, 'GET', `/api/admin/tickets/${aTicket.id}`)).res.status).toBe(404);
  });

  it("tenant B cannot modify tenant A's ticket or add notes", async () => {
    expect((await admin(B, 'PATCH', `/api/admin/tickets/${aTicket.id}`, { status: 'closed' })).res.status).toBe(404);
    expect((await admin(B, 'POST', `/api/admin/tickets/${aTicket.id}/notes`, { body: 'x' })).res.status).toBe(404);
    const row = await withTenant(A.id, async (db) => (await db.query(`SELECT status FROM tickets WHERE id = $1`, [aTicket.id])).rows[0]);
    expect(row.status).toBe('open');
  });

  it("tenant B cannot download tenant A's attachment", async () => {
    expect((await admin(B, 'GET', `/api/admin/attachments/${aAttachmentId}`)).res.status).toBe(404);
    const own = await handleApi(new Request(`${BASE}/api/admin/attachments/${aAttachmentId}`, { headers: { cookie: A.cookie } }));
    expect(own.status).toBe(200);
    expect(own.headers.get('content-disposition')).toMatch(/^attachment/);
  });

  it("tenant B's overview counts only its own tickets", async () => {
    const { data } = await admin(B, 'GET', '/api/admin/overview');
    expect(data.counts.total).toBe(1);
  });

  it('row-level security blocks cross-tenant reads even without a WHERE clause', async () => {
    const rows = await withTenant(B.id, async (db) => (await db.query(`SELECT number FROM tickets`)).rows);
    expect(rows.every((r) => r.number.startsWith('BBB-'))).toBe(true);
    const leaked = await withTenant(B.id, async (db) => (await db.query(`SELECT count(*)::int AS n FROM attachments WHERE id = $1`, [aAttachmentId])).rows[0].n);
    expect(leaked).toBe(0);
  });

  it('row-level security blocks writing rows into another tenant', async () => {
    await expect(
      withTenant(B.id, (db) => db.query(`INSERT INTO ticket_events (tenant_id, ticket_id, actor_type, type) VALUES ($1, $2, 'system', 'x')`, [A.id, aTicket.id])),
    ).rejects.toThrow(/row-level security/);
  });

  it('a transaction with no tenant bound sees nothing', async () => {
    const { getPool } = await import('../src/server/db.js');
    const c = await getPool().connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE support_app');
      const n = (await c.query(`SELECT count(*)::int AS n FROM tickets`)).rows[0].n;
      expect(n).toBe(0);
      await c.query('ROLLBACK');
    } finally {
      c.release();
    }
  });
});

describe('admin authentication and authorization', () => {
  it('requires a session', async () => {
    const res = await handleApi(new Request(`${BASE}/api/admin/tickets`));
    expect(res.status).toBe(401);
  });

  it('rejects mutations without the CSRF header or from another origin', async () => {
    const noHeader = await handleApi(new Request(`${BASE}/api/admin/tickets/${aTicket.id}`, {
      method: 'PATCH', headers: { cookie: A.cookie, origin: BASE, 'content-type': 'application/json' }, body: '{"status":"closed"}',
    }));
    expect(noHeader.status).toBe(403);
    const otherOrigin = await handleApi(new Request(`${BASE}/api/admin/tickets/${aTicket.id}`, {
      method: 'PATCH', headers: { cookie: A.cookie, origin: 'https://evil.example', 'x-requested-with': 'fetch', 'content-type': 'application/json' }, body: '{"status":"closed"}',
    }));
    expect(otherOrigin.status).toBe(403);
  });

  it('viewers can read but not change tickets', async () => {
    const { withSystem } = await import('../src/server/db.js');
    const { createSession } = await import('../src/server/services/auth.js');
    const viewerId = await withSystem(async (db) => (await db.query(`INSERT INTO admins (tenant_id, email, role) VALUES ($1, 'viewer@example.com', 'viewer') RETURNING id`, [A.id])).rows[0].id);
    const cookie = (await createSession(viewerId, A.id, 'test')).split(';')[0];
    expect((await admin({ cookie }, 'GET', `/api/admin/tickets/${aTicket.number}`)).res.status).toBe(200);
    expect((await admin({ cookie }, 'PATCH', `/api/admin/tickets/${aTicket.id}`, { status: 'closed' })).res.status).toBe(403);
  });

  it('disabling a member ends their sessions', async () => {
    const { withSystem } = await import('../src/server/db.js');
    const { createSession } = await import('../src/server/services/auth.js');
    const agentId = await withSystem(async (db) => (await db.query(`INSERT INTO admins (tenant_id, email, role) VALUES ($1, 'agent@example.com', 'agent') RETURNING id`, [A.id])).rows[0].id);
    const cookie = (await createSession(agentId, A.id, 'test')).split(';')[0];
    expect((await admin({ cookie }, 'GET', '/api/admin/overview')).res.status).toBe(200);
    expect((await admin(A, 'PATCH', `/api/admin/team/${agentId}`, { status: 'disabled' })).res.status).toBe(200);
    expect((await admin({ cookie }, 'GET', '/api/admin/overview')).res.status).toBe(401);
  });

  it('cannot remove the last owner', async () => {
    const { res } = await admin(A, 'PATCH', `/api/admin/team/${A.ownerId}`, { role: 'agent' });
    expect(res.status).toBe(422);
  });

  it('logout revokes the session server-side', async () => {
    const t = await createTestTenant();
    expect((await admin(t, 'GET', '/api/admin/me')).res.status).toBe(200);
    await admin(t, 'POST', '/api/auth/logout');
    expect((await admin(t, 'GET', '/api/admin/me')).res.status).toBe(401);
  });

  it('dev login does not exist outside development', async () => {
    const prev = process.env.APP_ENV;
    process.env.APP_ENV = 'production';
    process.env.DEV_LOGIN = 'true';
    try {
      const res = await handleApi(new Request(`http://localhost:8888/api/auth/dev-login`, { method: 'POST', body: JSON.stringify({ email: A.ownerEmail }) }));
      expect(res.status).toBe(404);
    } finally {
      process.env.APP_ENV = prev;
      delete process.env.DEV_LOGIN;
    }
  });
});

describe('ticket workflow', () => {
  it('status, priority and notes are recorded in the timeline', async () => {
    const tok = await embedToken(A);
    const { data } = await submitTicket(A, tok, validTicket({ phone: '9123456789' }));
    const detail = (await admin(A, 'GET', `/api/admin/tickets/${data.ticket.number}`)).data;
    await admin(A, 'PATCH', `/api/admin/tickets/${detail.id}`, { priority: 'high' });
    await admin(A, 'PATCH', `/api/admin/tickets/${detail.id}`, { status: 'in_progress' });
    await admin(A, 'POST', `/api/admin/tickets/${detail.id}/notes`, { body: 'Called the restaurant, restarting the POS.' });
    const res = await admin(A, 'PATCH', `/api/admin/tickets/${detail.id}`, { status: 'resolved' });
    expect(res.data.status).toBe('resolved');
    expect(res.data.resolvedAt).toBeTruthy();
    expect(res.data.events.map((e: any) => e.type)).toEqual(['created', 'auto_triage', 'priority_changed', 'status_changed', 'note', 'status_changed']);
  });

  it('search finds tickets by number, name, phone, restaurant and text', async () => {
    const t = await createTestTenant({ prefix: 'SRC' });
    const tok = await embedToken(t);
    await submitTicket(t, tok, validTicket({ name: 'Priya Nair', phone: '9000012345', orgName: 'Masala Box', description: 'Printer keeps jamming during rush hour' }));
    for (const q of ['SRC-000001', '1', 'priya', '12345', 'masala', 'jamming']) {
      const { data } = await admin(t, 'GET', `/api/admin/tickets?q=${encodeURIComponent(q)}`);
      expect(data.total, q).toBe(1);
    }
    expect((await admin(t, 'GET', `/api/admin/tickets?q=nothing-matches`)).data.total).toBe(0);
  });
});

describe('Google sign-in (OAuth callback)', () => {
  async function start(path: string) {
    const res = await handleApi(new Request(`${BASE}${path}`));
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith('sp_oauth='))!.split(';')[0];
    const state = new URL(res.headers.get('location')!).searchParams.get('state')!;
    return { cookie, state, location: res.headers.get('location')! };
  }

  it('signs in a listed admin and ignores unknown accounts', async () => {
    const { setGoogleFetch } = await import('../src/server/integrations/google.js');
    const { fakeIdToken } = await import('./fake-google.js');
    const t = await createTestTenant();
    let email = t.ownerEmail;
    setGoogleFetch(async () => new Response(JSON.stringify({ access_token: 'a', expires_in: 3600, id_token: fakeIdToken(email) }), { status: 200 }));
    try {
      const s = await start('/api/auth/google/start?next=/admin/tickets');
      expect(s.location).toMatch(/^https:\/\/accounts\.google\.com\//);
      const ok = await handleApi(new Request(`${BASE}/api/auth/google/callback?code=c&state=${encodeURIComponent(s.state)}`, { headers: { cookie: s.cookie } }));
      expect(ok.status).toBe(302);
      expect(ok.headers.get('location')).toBe('/admin/tickets');
      const session = ok.headers.getSetCookie().find((c) => c.startsWith('sp_session='))!.split(';')[0];
      expect((await admin({ cookie: session }, 'GET', '/api/admin/me')).data.tenant.id).toBe(t.id);

      email = 'stranger@example.com';
      const s2 = await start('/api/auth/google/start');
      const denied = await handleApi(new Request(`${BASE}/api/auth/google/callback?code=c&state=${encodeURIComponent(s2.state)}`, { headers: { cookie: s2.cookie } }));
      expect(denied.headers.get('location')).toBe('/admin/login?error=no_access');
    } finally {
      setGoogleFetch(null);
    }
  });

  it('rejects a callback whose state does not match the browser', async () => {
    const s = await start('/api/auth/google/start');
    const res = await handleApi(new Request(`${BASE}/api/auth/google/callback?code=c&state=${encodeURIComponent(s.state)}`, { headers: { cookie: 'sp_oauth=someone-else' } }));
    expect(res.headers.get('location')).toBe('/admin/login?error=failed');
  });

  it('never redirects outside the admin after sign-in', async () => {
    const res = await handleApi(new Request(`${BASE}/api/auth/google/start?next=https://evil.example`));
    const state = new URL(res.headers.get('location')!).searchParams.get('state')!;
    const payload = JSON.parse(Buffer.from(state.split('.')[0], 'base64url').toString());
    expect(payload.next).toBe('/admin');
  });
});
