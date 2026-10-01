import { describe, it, expect, beforeAll } from 'vitest';
import { handleApi, handleEmbed } from '../src/server/app.js';
import { withTenant } from '../src/server/db.js';
import { BASE, createTestTenant, embedToken, PDF, PNG, submitTicket, upload, validTicket, ticketCount, uniqueIp, type TestTenant } from './helpers.js';

let t: TestTenant;
let token: string;

beforeAll(async () => {
  t = await createTestTenant({ prefix: 'ECM' });
  token = await embedToken(t);
});

describe('widget configuration (publishable key)', () => {
  it('returns launcher config for a valid key from an allowed origin', async () => {
    const res = await handleApi(new Request(`${BASE}/api/widget/config?key=${t.key}`, { headers: { origin: 'https://customer.example' } }));
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://customer.example');
    const body: any = await res.json();
    expect(body.embedUrl).toBe(`${BASE}/embed/${t.key}`);
    expect(JSON.stringify(body)).not.toMatch(/secret|token|database/i);
  });

  it('accepts wildcard subdomains', async () => {
    const res = await handleApi(new Request(`${BASE}/api/widget/config?key=${t.key}`, { headers: { origin: 'https://app.customer.example' } }));
    expect(res.status).toBe(200);
  });

  it('falls back to the Referer when the browser omits Origin', async () => {
    const ok = await handleApi(new Request(`${BASE}/api/widget/config?key=${t.key}`, { headers: { referer: 'https://customer.example/menu' } }));
    expect(ok.status).toBe(200);
    const bad = await handleApi(new Request(`${BASE}/api/widget/config?key=${t.key}`, { headers: { referer: 'https://evil.example/' } }));
    expect(bad.status).toBe(403);
  });

  it("allows the platform's own origin (hosted demo page)", async () => {
    const res = await handleApi(new Request(`${BASE}/api/widget/config?key=${t.key}`, { headers: { origin: BASE } }));
    expect(res.status).toBe(200);
  });

  it('rejects an unknown key', async () => {
    const res = await handleApi(new Request(`${BASE}/api/widget/config?key=pk_test_doesnotexist000000000`, { headers: { origin: 'https://customer.example' } }));
    expect(res.status).toBe(404);
  });

  it('rejects a site that is not in the allowed domains', async () => {
    for (const origin of ['https://evil.example', 'https://customer.example.evil.com', 'http://customer.example']) {
      const res = await handleApi(new Request(`${BASE}/api/widget/config?key=${t.key}`, { headers: { origin } }));
      expect(res.status, origin).toBe(403);
    }
  });

  it('embed page is framed only by allowed domains (CSP frame-ancestors)', async () => {
    const res = await handleEmbed(new Request(`${BASE}/embed/${t.key}`));
    expect(res.status).toBe(200);
    const csp = res.headers.get('content-security-policy')!;
    expect(csp).toContain("frame-ancestors https://customer.example https://*.customer.example 'self'");
    expect(csp).toContain("script-src 'self'");
    const html = await res.text();
    expect(html).not.toMatch(/DATABASE_URL|SESSION_SECRET|ENCRYPTION_KEY|client_secret/);
  });

  it('embed page for an invalid key shows an unavailable state', async () => {
    const res = await handleEmbed(new Request(`${BASE}/embed/pk_test_nope`));
    expect(res.status).toBe(404);
  });
});

describe('ticket creation', () => {
  it('creates a ticket with a tenant-prefixed number', async () => {
    const { res, data } = await submitTicket(t, token, validTicket({ phone: '98765 43210' }));
    expect(res.status).toBe(201);
    expect(data.ticket.number).toMatch(/^ECM-\d{6}$/);
    const row = await withTenant(t.id, async (db) => (await db.query(`SELECT * FROM tickets WHERE number = $1`, [data.ticket.number])).rows[0]);
    expect(row.phone).toBe('+919876543210');
    expect(row.org_name).toBe('ABC Cafe');
    expect(row.status).toBe('open');
    const ev = await withTenant(t.id, async (db) => (await db.query(`SELECT type FROM ticket_events WHERE ticket_id = $1`, [row.id])).rows);
    expect(ev.map((e) => e.type)).toContain('created');
  });

  it('gives every ticket a unique, sequential number under concurrency', async () => {
    const t2 = await createTestTenant({ prefix: 'SEQ' });
    const tok = await embedToken(t2);
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => submitTicket(t2, tok, validTicket({ phone: `98765${String(10000 + i).slice(-5)}` }))),
    );
    const numbers = results.map((r) => r.data.ticket.number).sort();
    expect(new Set(numbers).size).toBe(12);
    expect(numbers[0]).toBe('SEQ-000001');
    expect(numbers[11]).toBe('SEQ-000012');
  });

  it('rejects a ticket with missing required fields and names each field', async () => {
    const { res, data } = await submitTicket(t, token, { country: 'IN', elapsed: 20 });
    expect(res.status).toBe(422);
    expect(Object.keys(data.error.fields)).toEqual(expect.arrayContaining(['name', 'phone', 'orgName', 'description']));
  });

  it('rejects an invalid Indian mobile number', async () => {
    for (const phone of ['12345', '5876543210', '98765432101']) {
      const { res, data } = await submitTicket(t, token, validTicket({ phone }));
      expect(res.status, phone).toBe(422);
      expect(data.error.fields.phone).toBeTruthy();
    }
  });

  it('normalises common Indian phone formats', async () => {
    for (const phone of ['+91 98765 43210', '09876543210', '919876543210', '98765-43210']) {
      const { res } = await submitTicket(t, token, validTicket({ phone }));
      expect(res.status, phone).toBe(201);
    }
  });

  it('stores user text as data (no HTML interpretation happens server-side)', async () => {
    const description = '<script>alert(1)</script> =HYPERLINK("http://x") the printer is offline';
    const { res, data } = await submitTicket(t, token, validTicket({ description }));
    expect(res.status).toBe(201);
    const row = await withTenant(t.id, async (db) => (await db.query(`SELECT description FROM tickets WHERE number = $1`, [data.ticket.number])).rows[0]);
    expect(row.description).toBe(description);
  });

  it('flags a possible duplicate from the same phone within 24 hours', async () => {
    const t3 = await createTestTenant();
    const tok = await embedToken(t3);
    const a = await submitTicket(t3, tok, validTicket({ phone: '9000000001' }));
    const b = await submitTicket(t3, tok, validTicket({ phone: '9000000001' }));
    const row = await withTenant(t3.id, async (db) =>
      (await db.query(`SELECT d.number FROM tickets t JOIN tickets d ON d.id = t.duplicate_of WHERE t.number = $1`, [b.data.ticket.number])).rows[0]);
    expect(row.number).toBe(a.data.ticket.number);
  });

  it('honeypot and too-fast submissions are refused without creating a ticket', async () => {
    const t4 = await createTestTenant();
    const tok = await embedToken(t4);
    expect((await submitTicket(t4, tok, validTicket({ website: 'http://spam' }))).res.status).toBe(400);
    expect((await submitTicket(t4, tok, validTicket({ elapsed: 1 }))).res.status).toBe(429);
    expect(await ticketCount(t4.id)).toBe(0);
  });

  it('rate-limits a single IP', async () => {
    const t5 = await createTestTenant();
    const tok = await embedToken(t5);
    const ip = uniqueIp();
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      statuses.push((await submitTicket(t5, tok, validTicket({ phone: `9${String(100000000 + i)}` }), ip)).res.status);
    }
    expect(statuses.filter((s) => s === 201)).toHaveLength(10);
    expect(statuses.slice(10)).toEqual([429, 429]);
  });
});

describe('attachments', () => {
  it('accepts an image and a PDF, then links them to the ticket', async () => {
    const png = await upload(t, token, 'Screen Shot 2026.png', PNG, 'image/png');
    const pdf = await upload(t, token, '../../invoice<1>.pdf', PDF, 'application/pdf');
    expect(png.res.status).toBe(201);
    expect(pdf.res.status).toBe(201);
    expect(pdf.data.fileName).toBe('invoice1.pdf');
    const { res, data } = await submitTicket(t, token, validTicket({ attachmentIds: [png.data.id, pdf.data.id] }));
    expect(res.status).toBe(201);
    const rows = await withTenant(t.id, async (db) =>
      (await db.query(`SELECT a.file_name FROM attachments a JOIN tickets tk ON tk.id = a.ticket_id WHERE tk.number = $1`, [data.ticket.number])).rows);
    expect(rows).toHaveLength(2);
  });

  it('rejects executables, HTML, SVG and disguised files', async () => {
    const cases: Array<[string, Uint8Array]> = [
      ['setup.exe', new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 1, 2, 3])],
      ['screenshot.png', new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 1, 2, 3])],
      ['page.html', new TextEncoder().encode('<!doctype html><script>alert(1)</script>')],
      ['notes.txt', new TextEncoder().encode('<html><body>hi</body></html>')],
      ['logo.svg', new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')],
      ['archive.zip', new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0])],
    ];
    for (const [name, bytes] of cases) {
      const r = await upload(t, token, name, bytes);
      expect(r.res.status, name).toBe(415);
    }
  });

  it('rejects files over the size limit', async () => {
    const big = new Uint8Array(4 * 1024 * 1024 + 10);
    big.set(PNG.subarray(0, 8));
    const r = await upload(t, token, 'huge.png', big, 'image/png');
    expect(r.res.status).toBe(413);
  });

  it("does not let one tenant attach another tenant's upload", async () => {
    const other = await createTestTenant();
    const otherTok = await embedToken(other);
    const up = await upload(other, otherTok, 'x.png', PNG, 'image/png');
    const { res } = await submitTicket(t, token, validTicket({ attachmentIds: [up.data.id] }));
    expect(res.status).toBe(422);
  });
});

describe('widget request authenticity', () => {
  it('rejects ticket calls that do not come from the embed iframe origin', async () => {
    const res = await handleApi(new Request(`${BASE}/api/widget/tickets`, {
      method: 'POST',
      headers: { origin: 'https://evil.example', 'x-widget-key': t.key, 'x-embed-token': token, 'content-type': 'application/json' },
      body: JSON.stringify(validTicket()),
    }));
    expect(res.status).toBe(403);
  });

  it('rejects cross-site browser requests even when the Origin header is absent', async () => {
    const res = await handleApi(new Request(`${BASE}/api/widget/tickets`, {
      method: 'POST',
      headers: { 'sec-fetch-site': 'cross-site', 'x-widget-key': t.key, 'x-embed-token': token, 'content-type': 'application/json' },
      body: JSON.stringify(validTicket()),
    }));
    expect(res.status).toBe(403);
  });

  it('accepts same-origin browser requests that carry only Sec-Fetch-Site', async () => {
    const res = await handleApi(new Request(`${BASE}/api/widget/tickets`, {
      method: 'POST',
      headers: { 'sec-fetch-site': 'same-origin', 'x-widget-key': t.key, 'x-embed-token': token, 'content-type': 'application/json', 'x-forwarded-for': uniqueIp() },
      body: JSON.stringify(validTicket()),
    }));
    expect(res.status).toBe(201);
  });

  it('rejects a missing or forged embed token', async () => {
    const other = await createTestTenant();
    const otherToken = await embedToken(other);
    for (const tok of ['', 'abc.def', otherToken]) {
      const res = await handleApi(new Request(`${BASE}/api/widget/tickets`, {
        method: 'POST',
        headers: { origin: BASE, 'x-widget-key': t.key, 'x-embed-token': tok, 'content-type': 'application/json' },
        body: JSON.stringify(validTicket()),
      }));
      expect(res.status).toBe(401);
    }
  });

  it('rejects a revoked key', async () => {
    const t6 = await createTestTenant();
    const tok = await embedToken(t6);
    await withTenant(t6.id, (db) => db.query(`UPDATE widget_keys SET revoked_at = now()`));
    expect((await submitTicket(t6, tok)).res.status).toBe(401);
  });
});
