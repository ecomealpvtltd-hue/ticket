import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { withTenant } from '../src/server/db.js';
import { runJobs } from '../src/server/services/jobs.js';
import { connectGoogle, setGoogleFetch } from '../src/server/integrations/google.js';
import { getTenant } from '../src/server/services/tenants.js';
import { setAIProvider, type AIProvider } from '../src/server/ai/index.js';
import { setBlobStore } from '../src/server/storage.js';
import { getRouter } from '../src/server/app.js';
import { admin, createTestTenant, embedToken, PDF, PNG, submitTicket, upload, validTicket, type TestTenant } from './helpers.js';
import { FakeGoogle, fakeIdToken } from './fake-google.js';

getRouter(); // register job handlers

async function connect(t: TestTenant, google: FakeGoogle) {
  setGoogleFetch(google.fetch);
  const tenant = await withTenant(t.id, (db) => getTenant(db, t.id));
  return connectGoogle(tenant, t.ownerId,
    { access_token: 'at', refresh_token: 'rt', expires_in: 3600, scope: 'openid email https://www.googleapis.com/auth/drive.file', id_token: fakeIdToken(t.ownerEmail) },
    { email: t.ownerEmail, emailVerified: true, name: null, hd: null, sub: '1' });
}

async function jobs(t: TestTenant, number: string) {
  return withTenant(t.id, async (db) =>
    (await db.query(`SELECT j.kind, j.status, j.attempts, j.last_error FROM integration_jobs j JOIN tickets t ON t.id = j.ticket_id WHERE t.number = $1 ORDER BY kind, j.created_at`, [number])).rows);
}

async function forceDue(t: TestTenant) {
  await withTenant(t.id, (db) => db.query(`UPDATE integration_jobs SET run_after = now() WHERE status = 'pending'`));
}

afterEach(() => {
  setGoogleFetch(null);
  setAIProvider(undefined);
  setBlobStore(null);
});

describe('Google Sheets and Drive sync', () => {
  it('tickets created before Google is connected wait, then sync after connecting', async () => {
    const t = await createTestTenant({ prefix: 'GGL' });
    const tok = await embedToken(t);
    const { data } = await submitTicket(t, tok, validTicket({ phone: '98765 43210' }));
    expect((await jobs(t, data.ticket.number)).map((j) => j.status)).toEqual(['blocked']);

    const google = new FakeGoogle();
    const settings = await connect(t, google);
    expect(settings.spreadsheetId).toBeTruthy();
    expect(google.sheets.get(settings.spreadsheetId!)![0][0]).toBe('Ticket ID');
    // Created directly inside the support folder (no move from My Drive).
    expect(google.files.get(settings.spreadsheetId!)!.parents).toEqual([settings.rootFolderId]);
    expect(google.calls.some((c) => c.startsWith('PATCH'))).toBe(false);

    await runJobs({ budgetMs: 5000 });
    const rows = google.sheets.get(settings.spreadsheetId!)!;
    expect(rows).toHaveLength(2);
    expect(rows[1][0]).toBe(data.ticket.number);
    expect(rows[1][3]).toBe('+91 98765 43210');
    expect(rows[1][7]).toBe('Open');
  });

  it('files attachments under Attachments/<date>/ named after the ticket, and links them in the Sheet', async () => {
    const t = await createTestTenant({ prefix: 'DRV', config: { timezone: 'Asia/Kolkata' } });
    const google = new FakeGoogle();
    const settings = await connect(t, google);
    const tok = await embedToken(t);
    const a1 = await upload(t, tok, 'Screenshot 2026-10-01 at 7.02 PM.png', PNG, 'image/png');
    const a2 = await upload(t, tok, 'invoice.pdf', PDF, 'application/pdf');
    const { data } = await submitTicket(t, tok, validTicket({ attachmentIds: [a1.data.id, a2.data.id] }));
    const second = await submitTicket(t, tok, validTicket({ attachmentIds: [(await upload(t, tok, 'x.png', PNG, 'image/png')).data.id] }));
    await runJobs({ budgetMs: 5000 });

    const byName = (n: string) => [...google.files.entries()].filter(([, f]) => f.name === n);
    const attachments = byName('Attachments');
    expect(attachments).toHaveLength(1);
    expect(attachments[0][1].parents).toEqual([settings.rootFolderId]);
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const dayFolders = byName(today);
    expect(dayFolders).toHaveLength(1); // both tickets share one day folder
    expect(dayFolders[0][1].parents).toEqual([attachments[0][0]]);
    expect(byName(`${data.ticket.number}.png`)[0][1].parents).toEqual([dayFolders[0][0]]);
    expect(byName(`${data.ticket.number}-2.pdf`)).toHaveLength(1);
    expect(byName(`${second.data.ticket.number}.png`)[0][1].parents).toEqual([dayFolders[0][0]]);
    expect(byName(data.ticket.number)).toHaveLength(0); // no per-ticket folders any more

    const row = google.sheets.get(settings.spreadsheetId!)!.find((r) => r[0] === data.ticket.number)!;
    expect(row[10]).toMatch(new RegExp(`^${data.ticket.number}\\.png: https://drive\\.google\\.com/file/d/.+\\n${data.ticket.number}-2\\.pdf: https://`));
    const detail = (await admin(t, 'GET', `/api/admin/tickets/${data.ticket.number}`)).data;
    expect(detail.attachments.every((x: any) => /drive\.google\.com/.test(x.driveUrl))).toBe(true);
    expect(detail.sync.drive_upload.status).toBe('done');
    expect(detail.sync.sheet_sync.status).toBe('done');
  });

  it('a status change updates the same Sheet row instead of adding one', async () => {
    const t = await createTestTenant({ prefix: 'UPD' });
    const google = new FakeGoogle();
    const settings = await connect(t, google);
    const tok = await embedToken(t);
    const { data } = await submitTicket(t, tok);
    await runJobs({ budgetMs: 5000 });
    const detail = (await admin(t, 'GET', `/api/admin/tickets/${data.ticket.number}`)).data;
    await admin(t, 'PATCH', `/api/admin/tickets/${detail.id}`, { status: 'resolved' });
    await runJobs({ budgetMs: 5000 });
    const rows = google.sheets.get(settings.spreadsheetId!)!;
    expect(rows.filter((r) => r[0] === data.ticket.number)).toHaveLength(1);
    expect(rows.find((r) => r[0] === data.ticket.number)![7]).toBe('Resolved');
  });

  it('Google failing never loses the ticket: it retries, and a manual retry recovers', async () => {
    const t = await createTestTenant({ prefix: 'FLR' });
    const google = new FakeGoogle();
    const settings = await connect(t, google);
    google.failNext.sheets = 100;
    const tok = await embedToken(t);
    const { res, data } = await submitTicket(t, tok);
    expect(res.status).toBe(201); // the customer sees success

    await runJobs({ budgetMs: 3000 });
    let j = (await jobs(t, data.ticket.number)).find((x) => x.kind === 'sheet_sync')!;
    expect(j.status).toBe('pending');
    expect(j.attempts).toBe(1);
    expect(j.last_error).toMatch(/500/);

    // Exhaust retries → failed, visible in the dashboard.
    for (let i = 0; i < 10; i++) { await forceDue(t); await runJobs({ budgetMs: 3000 }); }
    j = (await jobs(t, data.ticket.number)).find((x) => x.kind === 'sheet_sync')!;
    expect(j.status).toBe('failed');
    const integ = (await admin(t, 'GET', '/api/admin/integrations')).data;
    expect(integ.failedJobs.some((f: any) => f.ticketNumber === data.ticket.number)).toBe(true);

    // Ticket is intact.
    const detail = (await admin(t, 'GET', `/api/admin/tickets/${data.ticket.number}`)).data;
    expect(detail.status).toBe('open');

    // Google recovers; the admin retries.
    google.failNext.sheets = 0;
    const retry = await admin(t, 'POST', `/api/admin/jobs/${detail.sync.sheet_sync.id}/retry`);
    expect(retry.res.status).toBe(200);
    expect(google.sheets.get(settings.spreadsheetId!)!.some((r) => r[0] === data.ticket.number)).toBe(true);
  });

  it('revoked Google access pauses sync instead of failing tickets', async () => {
    const t = await createTestTenant({ prefix: 'RVK' });
    const google = new FakeGoogle();
    await connect(t, google);
    google.revoked = true;
    // Force a token refresh by expiring the cached access token.
    const { encryptJson } = await import('../src/server/crypto.js');
    await withTenant(t.id, (db) => db.query(`UPDATE integrations SET encrypted_credentials = $1`, [encryptJson({ refresh_token: 'rt' })]));
    const tok = await embedToken(t);
    const { res, data } = await submitTicket(t, tok);
    expect(res.status).toBe(201);
    await runJobs({ budgetMs: 3000 });
    const j = (await jobs(t, data.ticket.number)).find((x) => x.kind === 'sheet_sync')!;
    expect(j.status).toBe('blocked');
    const integ = (await admin(t, 'GET', '/api/admin/integrations')).data;
    expect(integ.google.status).toBe('error');
  });

  it('never stores tokens in plain text', async () => {
    const t = await createTestTenant();
    await connect(t, new FakeGoogle());
    const row = await withTenant(t.id, async (db) => (await db.query(`SELECT encrypted_credentials FROM integrations`)).rows[0]);
    expect(row.encrypted_credentials).toMatch(/^v1\./);
    expect(row.encrypted_credentials).not.toContain('rt');
  });
});

describe('AI triage', () => {
  it('fills category, priority suggestion and summary without changing the human-set priority', async () => {
    const calls: string[] = [];
    const provider: AIProvider = {
      name: 'test',
      async triage(input) {
        calls.push(input.description);
        return { category: 'Technical issue', priority: 'urgent', summary: 'Restaurant cannot receive orders since 7 PM.', reason: 'Revenue-impacting outage' };
      },
    };
    setAIProvider(provider);
    const t = await createTestTenant({ prefix: 'AIX' });
    const tok = await embedToken(t);
    const { data } = await submitTicket(t, tok, validTicket({ description: 'Orders stopped since 7 PM, call me on 9876543210 or a@b.com' }));
    await runJobs({ budgetMs: 5000 });
    const detail = (await admin(t, 'GET', `/api/admin/tickets/${data.ticket.number}`)).data;
    expect(detail.ai.status).toBe('done');
    expect(detail.ai.priority).toBe('urgent');
    expect(detail.priority).toBe('medium');
    expect(detail.category).toBe('Technical issue');
    expect(detail.events.map((e: any) => e.type)).toContain('ai_triage');
  });

  it('redacts phone numbers and emails before calling the model', async () => {
    const { redactPII } = await import('../src/server/ai/index.js');
    expect(redactPII('call 98765 43210 or +91-98765-43210, mail me at rahul@abc.in')).toBe('call [phone] or [phone], mail me at [email]');
  });

  it('AI failures never affect the ticket', async () => {
    setAIProvider({ name: 'broken', async triage() { throw new Error('model timeout'); } });
    const t = await createTestTenant({ prefix: 'AIF' });
    const tok = await embedToken(t);
    const { res, data } = await submitTicket(t, tok);
    expect(res.status).toBe(201);
    for (let i = 0; i < 4; i++) { await forceDue(t); await runJobs({ budgetMs: 3000 }); }
    const detail = (await admin(t, 'GET', `/api/admin/tickets/${data.ticket.number}`)).data;
    expect(detail.ai.status).toBe('failed');
    expect(detail.status).toBe('open');
    expect(detail.description).toMatch(/Unable to receive orders/);
  });

  it('with no AI configured, tickets are created with AI disabled and no AI job', async () => {
    setAIProvider(null);
    const t = await createTestTenant();
    const { data } = await submitTicket(t, await embedToken(t));
    const kinds = (await jobs(t, data.ticket.number)).map((j) => j.kind);
    expect(kinds).not.toContain('ai_triage');
  });
});

describe('failure handling', () => {
  it('storage outage: upload fails cleanly and nothing half-saved remains', async () => {
    const t = await createTestTenant();
    const tok = await embedToken(t);
    setBlobStore({ async put() { throw new Error('blob store down'); }, async get() { return null; }, async delete() {} });
    const r = await upload(t, tok, 'x.png', PNG, 'image/png');
    expect(r.res.status).toBe(503);
    expect(r.data.error.message).toMatch(/couldn't upload/i);
    const n = await withTenant(t.id, async (db) => (await db.query(`SELECT count(*)::int AS n FROM attachments`)).rows[0].n);
    expect(n).toBe(0);
  });

  it('database outage returns a safe error with no internal details', async () => {
    const t = await createTestTenant();
    const tok = await embedToken(t);
    const { closePool } = await import('../src/server/db.js');
    await closePool();
    const prev = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'postgres://postgres:postgres@localhost:1/none';
    try {
      const { res, data } = await submitTicket(t, tok);
      expect(res.status).toBe(500);
      expect(data.error.message).toBe('Something went wrong. Please try again.');
      expect(JSON.stringify(data)).not.toMatch(/ECONNREFUSED|postgres|localhost/);
    } finally {
      await closePool();
      process.env.DATABASE_URL = prev;
    }
    expect((await submitTicket(t, tok)).res.status).toBe(201);
  });
});
