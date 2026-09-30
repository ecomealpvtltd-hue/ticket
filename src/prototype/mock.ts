// Offline prototype backend. Implements the same HTTP API as the real server, in the browser,
// so the real widget and dashboard code can run without a server. Data lives in this browser
// only (localStorage). The production system uses Postgres, Netlify Blobs and Google instead.

import { COUNTRIES, normalizePhone, PRIORITIES, STATUSES } from '../shared/constants.js';
import ecomeal from '../../tenants/ecomeal.json';

type Status = (typeof STATUSES)[number];
type Priority = (typeof PRIORITIES)[number];

interface Attachment { id: string; ticketId: string | null; fileName: string; mimeType: string; size: number; dataUrl: string | null; createdAt: string }
interface Event { id: string; ticketId: string; actorType: string; actorLabel: string | null; type: string; data: any; createdAt: string }
interface Ticket {
  id: string; seq: number; number: string; name: string; phone: string; orgName: string; category: string | null;
  description: string; status: Status; priority: Priority; duplicateOf: string | null; example?: boolean;
  aiCategory: string | null; aiPriority: Priority | null; aiSummary: string | null;
  meta: any; createdAt: string; updatedAt: string; resolvedAt: string | null;
}
interface Member { id: string; email: string; name: string | null; role: string; status: string; createdAt: string; lastLoginAt: string | null }
interface State {
  v: 2; seq: number; config: any; allowedOrigins: string[];
  keys: Array<{ id: string; publicKey: string; label: string; createdAt: string; revokedAt: string | null; lastSeenAt: string | null; lastSeenOrigin: string | null }>;
  tickets: Ticket[]; events: Event[]; attachments: Attachment[]; team: Member[];
}

const KEY = 'sp-prototype-state';
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36));
const now = () => new Date().toISOString();
const ago = (min: number) => new Date(Date.now() - min * 60000).toISOString();
const PUBLIC_KEY = 'pk_live_demo7Kq2Xw9Lm4Rt8Vn3';
export const DEMO_ADMIN = { id: 'admin-1', email: 'you@ecomeal.in', name: 'Ecomeal Support', role: 'owner' as const };

function seed(): State {
  const s: State = {
    v: 2, seq: 0, config: ecomeal.config, allowedOrigins: ecomeal.allowedOrigins,
    keys: [{ id: 'key-1', publicKey: PUBLIC_KEY, label: 'Default', createdAt: ago(60 * 24 * 3), revokedAt: null, lastSeenAt: ago(2), lastSeenOrigin: 'https://ecomeal.in' }],
    tickets: [], events: [], attachments: [],
    team: [
      { id: DEMO_ADMIN.id, email: DEMO_ADMIN.email, name: DEMO_ADMIN.name, role: 'owner', status: 'active', createdAt: ago(60 * 24 * 3), lastLoginAt: now() },
      { id: 'admin-2', email: 'ops@ecomeal.in', name: null, role: 'agent', status: 'active', createdAt: ago(60 * 24 * 2), lastLoginAt: ago(180) },
    ],
  };
  const examples: Array<[string, string, string, string, Priority, Status, string, string, number]> = [
    ['Arjun Rao', '+919845012345', 'Tandoor House, Koramangala', 'Kitchen display shows orders twice after the evening update. Staff are cooking duplicate dishes.', 'high', 'in_progress', 'Technical issue', 'Duplicate orders on the kitchen display since the evening update.', 95],
    ['Meera Iyer', '+919900112233', 'Dosa Point, Jayanagar', 'Wastello closing stock for paneer is off by 2 kg compared to our manual count.', 'medium', 'open', 'Technical issue', 'Closing stock mismatch for paneer versus manual count.', 240],
    ['Farhan Ali', '+918123456789', 'Biryani Bros, HSR Layout', 'Please add GST number to invoices. Our accountant needs it for this month.', 'low', 'resolved', 'Billing', 'Needs GST number on invoices.', 60 * 26],
  ];
  for (const [name, phone, org, desc, prio, status, cat, summary, minutesAgo] of examples) {
    const t = makeTicket(s, { name, phone, orgName: org, description: desc, category: cat }, ago(minutesAgo));
    t.example = true; t.priority = prio; t.status = status; t.aiCategory = cat; t.aiPriority = prio; t.aiSummary = summary;
    if (status === 'resolved') { t.resolvedAt = ago(minutesAgo - 90); addEvent(s, t.id, 'admin', DEMO_ADMIN.name, 'status_changed', { from: 'open', to: 'resolved' }, t.resolvedAt); }
    if (status === 'in_progress') addEvent(s, t.id, 'admin', DEMO_ADMIN.name, 'status_changed', { from: 'open', to: 'in_progress' }, ago(minutesAgo - 10));
  }
  return s;
}

function load(): State {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) { const s = JSON.parse(raw); if (s.v === 2) return s; }
  } catch { /* storage unavailable */ }
  const s = seed();
  save(s);
  return s;
}
function save(s: State) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* quota or blocked: keep in memory */ }
  memory = s;
}
let memory: State | null = null;
const state = () => (memory ??= load());
export function resetPrototype() { try { localStorage.removeItem(KEY); } catch { /* ignore */ } memory = null; }

function addEvent(s: State, ticketId: string, actorType: string, actorLabel: string | null, type: string, data: any = {}, at = now()) {
  s.events.push({ id: uid(), ticketId, actorType, actorLabel, type, data, createdAt: at });
}

function makeTicket(s: State, input: { name: string; phone: string; orgName: string; description: string; category?: string | null }, at = now()): Ticket {
  s.seq += 1;
  const dup = s.tickets.find((t) => t.phone === input.phone && (t.status === 'open' || t.status === 'in_progress') && Date.now() - Date.parse(t.createdAt) < 86400000);
  const t: Ticket = {
    id: uid(), seq: s.seq, number: `ECM-${String(s.seq).padStart(6, '0')}`, name: input.name, phone: input.phone, orgName: input.orgName,
    category: input.category ?? null, description: input.description, status: 'open', priority: 'medium', duplicateOf: dup?.id ?? null,
    aiCategory: null, aiPriority: null, aiSummary: null, meta: { pageUrl: 'https://ecomeal.in/dashboard' }, createdAt: at, updatedAt: at, resolvedAt: null,
  };
  s.tickets.push(t);
  addEvent(s, t.id, 'customer', t.name, 'created', { attachments: 0 }, at);
  if (dup) addEvent(s, t.id, 'system', null, 'possible_duplicate', { of: dup.number }, at);
  return t;
}

// ---------------------------------------------------------------------------
// HTTP layer
// ---------------------------------------------------------------------------

class HttpError extends Error { constructor(public status: number, public code: string, message: string, public fields?: Record<string, string>) { super(message); } }
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

function listItem(s: State, t: Ticket) {
  return {
    id: t.id, number: t.number, name: t.name, phone: t.phone, orgName: t.orgName, category: t.category ?? t.aiCategory,
    excerpt: (t.aiSummary || t.description).slice(0, 160), status: t.status, priority: t.priority, aiPriority: t.aiPriority,
    attachmentCount: s.attachments.filter((a) => a.ticketId === t.id).length, createdAt: t.createdAt, updatedAt: t.updatedAt,
  };
}

function detail(s: State, t: Ticket) {
  const dup = t.duplicateOf ? s.tickets.find((x) => x.id === t.duplicateOf) : null;
  return {
    id: t.id, number: t.number, status: t.status, priority: t.priority, category: t.category, description: t.description,
    customer: { id: t.phone, name: t.name, phone: t.phone, email: null, orgName: t.orgName, ticketCount: s.tickets.filter((x) => x.phone === t.phone).length },
    ai: { status: t.aiSummary ? 'done' : 'disabled', category: t.aiCategory, priority: t.aiPriority, summary: t.aiSummary, reason: t.aiSummary ? 'Suggested from the ticket text' : null },
    duplicateOf: dup?.number ?? null, meta: t.meta, createdAt: t.createdAt, updatedAt: t.updatedAt, resolvedAt: t.resolvedAt,
    attachments: s.attachments.filter((a) => a.ticketId === t.id).map((a) => ({ id: a.id, fileName: a.fileName, mimeType: a.mimeType, size: a.size, driveUrl: null })),
    events: s.events.filter((e) => e.ticketId === t.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    sync: { sheet_sync: { id: 'job-' + t.id, status: 'blocked', attempts: 0, lastError: null, updatedAt: t.updatedAt } },
  };
}

const RANK: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 };

async function route(method: string, url: URL, body: any): Promise<Response> {
  const s = state();
  const p = url.pathname.replace(/^.*?(\/api\/)/, '/api/');
  let m: RegExpExecArray | null;

  // ---- widget ----
  if (method === 'GET' && p === '/api/widget/config') {
    return json({
      brand: s.config.brand.name, title: s.config.copy.title, launcher: s.config.launcher,
      theme: { accent: s.config.theme.accent, accentText: s.config.theme.accentText, mode: s.config.theme.mode, background: s.config.theme.background ?? null },
      embedUrl: new URL('embed.html', location.href).href,
    });
  }
  if (method === 'POST' && p === '/api/widget/tickets') {
    const fields: Record<string, string> = {};
    const name = String(body.name ?? '').trim();
    const org = String(body.orgName ?? '').trim();
    const desc = String(body.description ?? '').trim();
    const phone = normalizePhone(String(body.country ?? 'IN'), String(body.phone ?? ''));
    if (name.length < 2) fields.name = 'Enter your name';
    if (!phone) fields.phone = 'Enter a valid phone number';
    if (org.length < 2) fields.orgName = 'This field is required';
    if (desc.length < 10) fields.description = 'Please add a little more detail (at least 10 characters)';
    if (Object.keys(fields).length) throw new HttpError(422, 'validation_failed', 'Please check the highlighted fields.', fields);
    if (typeof body.elapsed === 'number' && body.elapsed < 3) throw new HttpError(429, 'too_fast', 'Please take a moment to review your ticket and submit again.');
    const t = makeTicket(s, { name, phone: phone!, orgName: org, description: desc, category: body.category || null });
    const ids: string[] = body.attachmentIds ?? [];
    for (const a of s.attachments) if (ids.includes(a.id) && !a.ticketId) a.ticketId = t.id;
    const ev = s.events.find((e) => e.ticketId === t.id && e.type === 'created');
    if (ev) ev.data.attachments = ids.length;
    save(s);
    await new Promise((r) => setTimeout(r, 450));
    return json({ ticket: { number: t.number } }, 201);
  }

  // ---- auth ----
  if (p === '/api/auth/config') return json({ google: true, devLogin: false });
  if (p === '/api/auth/logout') return json({ ok: true });

  // ---- admin ----
  if (p === '/api/admin/me') {
    return json({
      admin: DEMO_ADMIN,
      tenant: { id: 'tenant-ecomeal', name: 'Ecomeal', slug: 'ecomeal', ticketPrefix: 'ECM', config: s.config },
      memberships: [{ tenantId: 'tenant-ecomeal', name: 'Ecomeal', role: 'owner' }],
      platform: { googleConfigured: true, aiConfigured: true, baseUrl: 'https://support.ecomeal.in', appEnv: 'prototype' },
    });
  }
  if (p === '/api/admin/overview') {
    const c = (st: Status) => s.tickets.filter((t) => t.status === st).length;
    const active = s.tickets.filter((t) => t.status === 'open' || t.status === 'in_progress');
    return json({
      counts: { open: c('open'), in_progress: c('in_progress'), resolved: c('resolved'), closed: c('closed'), total: s.tickets.length,
        high_open: active.filter((t) => RANK[t.priority] <= 1).length, last_24h: s.tickets.filter((t) => Date.now() - Date.parse(t.createdAt) < 86400000).length, median_resolution_seconds: null },
      attention: active.sort((a, b) => RANK[a.priority] - RANK[b.priority] || a.createdAt.localeCompare(b.createdAt)).slice(0, 6).map((t) => listItem(s, t)),
      sync: { failed: 0, pending: 0, blocked: 0 },
    });
  }
  if (method === 'GET' && p === '/api/admin/tickets') {
    const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
    const status = url.searchParams.get('status') ?? 'all';
    const priority = url.searchParams.get('priority') ?? 'all';
    const sort = url.searchParams.get('sort') ?? 'newest';
    const page = Number(url.searchParams.get('page') ?? '1');
    let list = s.tickets.filter((t) =>
      (status === 'all' || (status === 'active' ? t.status === 'open' || t.status === 'in_progress' : t.status === status)) &&
      (priority === 'all' || t.priority === priority) &&
      (!q || [t.number, t.name, t.orgName, t.description, t.phone].some((f) => f.toLowerCase().includes(q)) || String(t.seq) === q));
    list = list.sort((a, b) =>
      sort === 'oldest' ? a.createdAt.localeCompare(b.createdAt)
      : sort === 'priority' ? RANK[a.priority] - RANK[b.priority] || b.createdAt.localeCompare(a.createdAt)
      : sort === 'updated' ? b.updatedAt.localeCompare(a.updatedAt) : b.createdAt.localeCompare(a.createdAt));
    return json({ tickets: list.slice((page - 1) * 25, page * 25).map((t) => listItem(s, t)), total: list.length, page, pageSize: 25 });
  }
  if ((m = /^\/api\/admin\/tickets\/([^/]+)$/.exec(p))) {
    const t = s.tickets.find((x) => x.id === m![1] || x.number === m![1]);
    if (!t) throw new HttpError(404, 'not_found', 'Ticket not found.');
    if (method === 'PATCH') {
      for (const f of ['status', 'priority', 'category'] as const) {
        if (body[f] === undefined || body[f] === t[f]) continue;
        addEvent(s, t.id, 'admin', DEMO_ADMIN.name, `${f}_changed`, { from: t[f], to: body[f] });
        (t as any)[f] = body[f];
        if (f === 'status') t.resolvedAt = body.status === 'resolved' || body.status === 'closed' ? t.resolvedAt ?? now() : null;
      }
      t.updatedAt = now();
      save(s);
    }
    return json(detail(s, t));
  }
  if ((m = /^\/api\/admin\/tickets\/([^/]+)\/notes$/.exec(p))) {
    const t = s.tickets.find((x) => x.id === m![1]);
    if (!t) throw new HttpError(404, 'not_found', 'Ticket not found.');
    const text = String(body.body ?? '').trim();
    if (!text) throw new HttpError(422, 'validation_failed', 'Write a note first');
    addEvent(s, t.id, 'admin', DEMO_ADMIN.name, 'note', { body: text });
    t.updatedAt = now();
    save(s);
    return json(detail(s, t), 201);
  }
  if (/^\/api\/admin\/jobs\//.test(p)) return json({ ok: true });
  if (p === '/api/admin/widget') return json({ baseUrl: 'https://support.ecomeal.in', allowedOrigins: s.allowedOrigins, keys: s.keys });
  if (p === '/api/admin/widget/origins') { s.allowedOrigins = body.origins; save(s); return json({ allowedOrigins: s.allowedOrigins }); }
  if (p === '/api/admin/widget/keys') {
    const k = { id: uid(), publicKey: 'pk_live_' + uid().replace(/-/g, '').slice(0, 20), label: 'Key', createdAt: now(), revokedAt: null, lastSeenAt: null, lastSeenOrigin: null };
    s.keys.push(k); save(s); return json(k, 201);
  }
  if ((m = /^\/api\/admin\/widget\/keys\/([^/]+)\/revoke$/.exec(p))) {
    const k = s.keys.find((x) => x.id === m![1]); if (k) k.revokedAt = now(); save(s); return json({ ok: true });
  }
  if (p === '/api/admin/integrations') return json({ googleConfigured: true, aiConfigured: true, google: null, queue: { waiting: s.tickets.length, queued: 0 }, failedJobs: [] });
  if (p === '/api/admin/settings') { s.config = body.config; save(s); return json({ config: s.config }); }
  if (method === 'GET' && p === '/api/admin/team') return json({ members: s.team });
  if (method === 'POST' && p === '/api/admin/team') {
    if (s.team.some((x) => x.email === body.email)) throw new HttpError(409, 'exists', 'This person is already on the team.');
    s.team.push({ id: uid(), email: String(body.email).toLowerCase(), name: null, role: body.role, status: 'active', createdAt: now(), lastLoginAt: null });
    save(s); return json({ ok: true }, 201);
  }
  if ((m = /^\/api\/admin\/team\/([^/]+)$/.exec(p))) {
    const t = s.team.find((x) => x.id === m![1]); if (t) Object.assign(t, body); save(s); return json({ ok: true });
  }
  throw new HttpError(404, 'not_found', 'Not found.');
}

// ---------------------------------------------------------------------------
// Attachments (images are downscaled so they fit in browser storage)
// ---------------------------------------------------------------------------

const ALLOWED = /\.(png|jpe?g|webp|gif|pdf|txt|csv|docx|xlsx)$/i;
async function storeUpload(file: File): Promise<Response> {
  if (!ALLOWED.test(file.name)) return json({ error: { code: 'unsupported_type', message: 'This file type is not supported. Use an image, PDF, text, Word or Excel file.' } }, 415);
  if (file.size > 4 * 1024 * 1024) return json({ error: { code: 'file_too_large', message: 'This file is larger than 4 MB.' } }, 413);
  let dataUrl: string | null = null;
  if (file.type.startsWith('image/')) {
    try {
      const bmp = await createImageBitmap(file);
      const scale = Math.min(1, 900 / Math.max(bmp.width, bmp.height));
      const c = document.createElement('canvas');
      c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
      c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
      dataUrl = c.toDataURL('image/jpeg', 0.8);
    } catch { dataUrl = null; }
  }
  const s = state();
  const a: Attachment = { id: uid(), ticketId: null, fileName: file.name.replace(/[^\w.\- ()]/g, ''), mimeType: file.type || 'application/octet-stream', size: file.size, dataUrl, createdAt: now() };
  s.attachments.push(a);
  save(s);
  return json({ id: a.id, fileName: a.fileName, size: a.size, mimeType: a.mimeType }, 201);
}

export function attachmentUrl(id: string) {
  const a = state().attachments.find((x) => x.id === id);
  return a?.dataUrl ?? 'data:text/plain,Previews%20of%20this%20file%20type%20are%20available%20on%20the%20live%20deployment.';
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

export function installMockApi() {
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href);
    if (!url.pathname.includes('/api/')) return realFetch(input as any, init);
    const method = (init?.method ?? 'GET').toUpperCase();
    let body: any = {};
    if (typeof init?.body === 'string') { try { body = JSON.parse(init.body); } catch { body = {}; } }
    try {
      await new Promise((r) => setTimeout(r, 120));
      return await route(method, url, body);
    } catch (e) {
      const err = e as HttpError;
      return json({ error: { code: err.code ?? 'error', message: err.message, fields: err.fields } }, err.status ?? 500);
    }
  };

  // The widget uploads with XMLHttpRequest for progress events.
  const RealXHR = window.XMLHttpRequest;
  class MockXHR {
    status = 0; responseText = ''; upload: { onprogress: ((e: any) => void) | null } = { onprogress: null };
    onload: (() => void) | null = null; onerror: (() => void) | null = null;
    private url = '';
    open(_m: string, url: string) { this.url = url; }
    setRequestHeader() {}
    send(fd: FormData) {
      if (!this.url.includes('/api/widget/uploads')) { this.onerror?.(); return; }
      const file = fd.get('file') as File;
      let p = 0;
      const tick = setInterval(() => {
        p = Math.min(1, p + 0.25);
        this.upload.onprogress?.({ lengthComputable: true, loaded: p * file.size, total: file.size });
        if (p >= 1) {
          clearInterval(tick);
          storeUpload(file).then(async (r) => { this.status = r.status; this.responseText = await r.text(); this.onload?.(); });
        }
      }, 120);
    }
  }
  (window as any).XMLHttpRequest = MockXHR;
  void RealXHR;

  (window as any).__SP_PROTOTYPE = {
    attachmentUrl: (id: string) => attachmentUrl(id),
    embedUrl: () => new URL('embed.html?preview=1', location.href).href,
  };
}

export const prototypeBoot = () => {
  const s = state();
  const c = s.config;
  return {
    key: PUBLIC_KEY, token: 'prototype',
    config: { brand: c.brand, theme: c.theme, copy: c.copy, contactOptions: c.contactOptions, form: c.form, categories: c.form.showCategory ? c.categories : [], poweredBy: c.poweredBy },
    limits: { maxBytes: 4 * 1024 * 1024, maxFiles: 3 },
    countries: COUNTRIES.map((x) => ({ code: x.code, dial: x.dial, name: x.name })),
  };
};
