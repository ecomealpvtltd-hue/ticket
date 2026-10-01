// Google integration: admin sign-in, and per-tenant Drive + Sheets sync.
//
// Scope choice: `drive.file` only. The app can see and edit ONLY files it created itself
// (the tenant's support folder, the ticket spreadsheet and uploaded attachments). It cannot
// read anything else in the tenant's Drive. This is the least-privilege option Google
// recommends and avoids the restricted-scope security assessment.

import { env } from '../env.js';
import { withTenant, type Db } from '../db.js';
import { decryptJson, encryptJson } from '../crypto.js';
import { log, errorMessage } from '../log.js';
import { getBlobStore } from '../storage.js';
import { registerJobHandler, enqueueJob, IntegrationNotConnected, PermanentJobError, type Job } from '../services/jobs.js';
import { getTenant, type Tenant } from '../services/tenants.js';
import { formatPhone, PRIORITY_LABEL, STATUS_LABEL, type TicketPriority, type TicketStatus } from '../../shared/model.js';

export const LOGIN_SCOPES = ['openid', 'email', 'profile'];
export const CONNECT_SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/drive.file'];

let fetchImpl: typeof fetch = (...args) => fetch(...args);
/** Tests replace network access with a fake Google. */
export function setGoogleFetch(f: typeof fetch | null) { fetchImpl = f ?? ((...args) => fetch(...args)); }

// ---------------------------------------------------------------------------
// OAuth
// ---------------------------------------------------------------------------

export function authUrl(opts: { scopes: string[]; redirectUri: string; state: string; offline?: boolean; loginHint?: string; hd?: string }) {
  const p = new URLSearchParams({
    client_id: env.googleClientId ?? '',
    redirect_uri: opts.redirectUri,
    response_type: 'code',
    scope: opts.scopes.join(' '),
    state: opts.state,
    include_granted_scopes: 'false',
    prompt: opts.offline ? 'consent' : 'select_account',
  });
  if (opts.offline) p.set('access_type', 'offline');
  if (opts.loginHint) p.set('login_hint', opts.loginHint);
  if (opts.hd) p.set('hd', opts.hd);
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

export interface TokenResponse { access_token: string; refresh_token?: string; expires_in: number; id_token?: string; scope?: string }

export async function exchangeCode(code: string, redirectUri: string): Promise<TokenResponse> {
  const res = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.googleClientId ?? '',
      client_secret: env.googleClientSecret ?? '',
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  if (!res.ok) throw new Error(`Google token exchange failed (${res.status})`);
  return (await res.json()) as TokenResponse;
}

export interface GoogleIdentity { email: string; emailVerified: boolean; name: string | null; hd: string | null; sub: string }

/**
 * The id_token came straight from Google's token endpoint over TLS in exchange for a
 * one-time code we sent with our client secret, so its claims can be trusted without
 * re-verifying the signature (Google documents this). We still check audience and issuer.
 */
export function decodeIdToken(idToken: string): GoogleIdentity {
  const [, payload] = idToken.split('.');
  const c = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  if (c.aud !== env.googleClientId) throw new Error('id_token audience mismatch');
  if (c.iss !== 'https://accounts.google.com' && c.iss !== 'accounts.google.com') throw new Error('id_token issuer mismatch');
  if (typeof c.exp !== 'number' || c.exp < Date.now() / 1000 - 60) throw new Error('id_token expired');
  return { email: String(c.email ?? '').toLowerCase(), emailVerified: c.email_verified === true, name: c.name ?? null, hd: c.hd ?? null, sub: String(c.sub) };
}

// ---------------------------------------------------------------------------
// Authenticated client for one tenant
// ---------------------------------------------------------------------------

interface StoredCredentials { refresh_token: string; access_token?: string; expires_at?: number; scope?: string }

export interface GoogleSettings {
  rootFolderId?: string;
  rootFolderUrl?: string;
  spreadsheetId?: string;
  spreadsheetUrl?: string;
  sheetTitle?: string;
}

export class GoogleApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export class GoogleClient {
  private creds: StoredCredentials;
  constructor(public tenantId: string, sealed: string, public settings: GoogleSettings) {
    this.creds = decryptJson<StoredCredentials>(sealed);
  }

  static async forTenant(db: Db, tenantId: string): Promise<GoogleClient> {
    const r = await db.query(`SELECT status, encrypted_credentials, settings FROM integrations WHERE tenant_id = $1 AND provider = 'google'`, [tenantId]);
    const row = r.rows[0];
    if (!row || row.status !== 'connected' || !row.encrypted_credentials) {
      throw new IntegrationNotConnected('Google is not connected for this workspace');
    }
    return new GoogleClient(tenantId, row.encrypted_credentials, row.settings ?? {});
  }

  private async accessToken(): Promise<string> {
    if (this.creds.access_token && (this.creds.expires_at ?? 0) > Date.now() + 60_000) return this.creds.access_token;
    const res = await fetchImpl('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.googleClientId ?? '',
        client_secret: env.googleClientSecret ?? '',
        refresh_token: this.creds.refresh_token,
        grant_type: 'refresh_token',
      }),
    });
    if (!res.ok) {
      const body: any = await res.json().catch(() => ({}));
      if (body.error === 'invalid_grant') {
        // Access was revoked or expired: stop retrying until an admin reconnects.
        await withTenant(this.tenantId, (db) =>
          db.query(`UPDATE integrations SET status = 'error', last_error = 'Google access was revoked or expired. Reconnect Google.', updated_at = now() WHERE tenant_id = $1 AND provider = 'google'`, [this.tenantId]),
        );
        throw new IntegrationNotConnected('Google access was revoked. Reconnect Google.');
      }
      throw new Error(`Google token refresh failed (${res.status})`);
    }
    const t = (await res.json()) as TokenResponse;
    this.creds.access_token = t.access_token;
    this.creds.expires_at = Date.now() + t.expires_in * 1000;
    return t.access_token;
  }

  async request(url: string, init: RequestInit = {}): Promise<any> {
    const token = await this.accessToken();
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${token}`);
    const res = await fetchImpl(url, { ...init, headers });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let msg = text.slice(0, 300);
      try { msg = JSON.parse(text).error?.message ?? msg; } catch { /* keep text */ }
      throw new GoogleApiError(res.status, `Google API ${res.status}: ${msg}`);
    }
    return res.status === 204 ? null : res.json();
  }

  // ---- Drive -------------------------------------------------------------

  createFolder(name: string, parentId?: string) {
    return this.request('https://www.googleapis.com/drive/v3/files?fields=id,webViewLink', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', ...(parentId ? { parents: [parentId] } : {}) }),
    }) as Promise<{ id: string; webViewLink: string }>;
  }

  async fileExists(id: string): Promise<boolean> {
    try {
      const f = await this.request(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?fields=id,trashed`);
      return !f.trashed;
    } catch (err) {
      if (err instanceof GoogleApiError && (err.status === 404 || err.status === 403)) return false;
      throw err;
    }
  }

  uploadFile(opts: { name: string; mimeType: string; parentId: string; data: Uint8Array; description?: string }) {
    const boundary = 'sp' + Math.random().toString(36).slice(2);
    const meta = JSON.stringify({ name: opts.name, parents: [opts.parentId], description: opts.description });
    const head = Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${opts.mimeType}\r\n\r\n`);
    const tail = Buffer.from(`\r\n--${boundary}--`);
    return this.request('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink', {
      method: 'POST',
      headers: { 'content-type': `multipart/related; boundary=${boundary}` },
      body: Buffer.concat([head, Buffer.from(opts.data), tail]),
    }) as Promise<{ id: string; webViewLink: string }>;
  }

  // ---- Sheets ------------------------------------------------------------

  /**
   * Create the spreadsheet directly inside our folder via Drive (no later "move", which needs
   * access to My Drive's root that drive.file doesn't grant), then rename its first tab.
   */
  async createSpreadsheet(title: string, sheetTitle: string, parentId: string) {
    const file = await this.request('https://www.googleapis.com/drive/v3/files?fields=id,webViewLink', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: title, mimeType: 'application/vnd.google-apps.spreadsheet', parents: [parentId] }),
    }) as { id: string; webViewLink: string };
    const meta = await this.request(`https://sheets.googleapis.com/v4/spreadsheets/${file.id}?fields=sheets.properties.sheetId`) as { sheets?: Array<{ properties: { sheetId: number } }> };
    const sheetId = meta.sheets?.[0]?.properties?.sheetId ?? 0;
    await this.batchUpdate(file.id, [
      { updateSheetProperties: { properties: { sheetId, title: sheetTitle, gridProperties: { frozenRowCount: 1 } }, fields: 'title,gridProperties.frozenRowCount' } },
    ]);
    return { spreadsheetId: file.id, spreadsheetUrl: file.webViewLink, sheetId };
  }

  values(spreadsheetId: string, range: string) {
    return this.request(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}?majorDimension=COLUMNS`) as Promise<{ values?: string[][] }>;
  }

  /** valueInputOption=RAW: user text is stored as text, never evaluated as a formula. */
  putRow(spreadsheetId: string, range: string, row: string[]) {
    return this.request(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=RAW`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ range, majorDimension: 'ROWS', values: [row] }),
    });
  }

  appendRow(spreadsheetId: string, range: string, row: string[]) {
    return this.request(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ majorDimension: 'ROWS', values: [row] }),
    });
  }

  batchUpdate(spreadsheetId: string, requests: unknown[]) {
    return this.request(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requests }),
    });
  }
}

// ---------------------------------------------------------------------------
// Connecting a tenant
// ---------------------------------------------------------------------------

export const SHEET_TITLE = 'Tickets';
export function sheetHeader(tenant: Tenant): string[] {
  return ['Ticket ID', 'Created', 'Name', 'Phone', tenant.config.form.orgLabel.replace(/ name$/i, '') || 'Organisation',
    'Category', 'Priority', 'Status', 'Issue', 'Summary', 'Attachments', 'Last updated', 'Open in dashboard'];
}

/** Store credentials and make sure the tenant's folder and spreadsheet exist (reusing them if still there). */
export async function connectGoogle(tenant: Tenant, adminId: string, tokens: TokenResponse, identity: GoogleIdentity) {
  if (!tokens.refresh_token) {
    throw new Error('Google did not return offline access. Remove the app from your Google account permissions and connect again.');
  }
  const granted = (tokens.scope ?? '').split(' ');
  if (!granted.includes('https://www.googleapis.com/auth/drive.file')) {
    throw new Error('Drive access was not granted. Connect again and allow access to files created by this app.');
  }
  const sealed = encryptJson({
    refresh_token: tokens.refresh_token,
    access_token: tokens.access_token,
    expires_at: Date.now() + tokens.expires_in * 1000,
    scope: tokens.scope,
  } satisfies StoredCredentials);

  const previous = await withTenant(tenant.id, async (db) => {
    const r = await db.query(`SELECT settings FROM integrations WHERE tenant_id = $1 AND provider = 'google'`, [tenant.id]);
    return (r.rows[0]?.settings ?? {}) as GoogleSettings;
  });

  const client = new GoogleClient(tenant.id, sealed, previous);
  const settings: GoogleSettings = { ...previous };

  if (!settings.rootFolderId || !(await client.fileExists(settings.rootFolderId))) {
    const folder = await client.createFolder(`${tenant.config.brand.name} Support`);
    settings.rootFolderId = folder.id;
    settings.rootFolderUrl = folder.webViewLink;
    settings.spreadsheetId = undefined;
  }
  if (!settings.spreadsheetId || !(await client.fileExists(settings.spreadsheetId))) {
    const ss = await client.createSpreadsheet(`${tenant.config.brand.name} Support — Tickets`, SHEET_TITLE, settings.rootFolderId!);
    await client.putRow(ss.spreadsheetId, `${SHEET_TITLE}!A1`, sheetHeader(tenant));
    const sheetId = ss.sheetId;
    await client.batchUpdate(ss.spreadsheetId, [
      { repeatCell: { range: { sheetId, startRowIndex: 0, endRowIndex: 1 }, cell: { userEnteredFormat: { textFormat: { bold: true } } }, fields: 'userEnteredFormat.textFormat.bold' } },
      { updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: 8, endIndex: 10 }, properties: { pixelSize: 360 }, fields: 'pixelSize' } },
    ]).catch((e) => log.warn('google.sheet_format_failed', { message: errorMessage(e) }));
    settings.spreadsheetId = ss.spreadsheetId;
    settings.spreadsheetUrl = ss.spreadsheetUrl;
    settings.sheetTitle = SHEET_TITLE;
  }

  await withTenant(tenant.id, async (db) => {
    await db.query(
      `INSERT INTO integrations (tenant_id, provider, status, account_email, encrypted_credentials, settings, connected_by, last_error)
       VALUES ($1, 'google', 'connected', $2, $3, $4, $5, NULL)
       ON CONFLICT (tenant_id, provider) DO UPDATE SET status = 'connected', account_email = EXCLUDED.account_email,
         encrypted_credentials = EXCLUDED.encrypted_credentials, settings = EXCLUDED.settings,
         connected_by = EXCLUDED.connected_by, last_error = NULL, updated_at = now()`,
      [tenant.id, identity.email, sealed, JSON.stringify(settings), adminId],
    );
    // Everything that was waiting for Google becomes runnable, and every existing ticket is (re)synced.
    await db.query(
      `INSERT INTO integration_jobs (tenant_id, ticket_id, kind, status, max_attempts)
       SELECT t.tenant_id, t.id, 'sheet_sync', 'pending', 8 FROM tickets t
        WHERE t.tenant_id = $1
       ON CONFLICT (ticket_id, kind) WHERE status IN ('pending', 'blocked')
       DO UPDATE SET status = 'pending', run_after = now(), updated_at = now()`,
      [tenant.id],
    );
    await db.query(
      `UPDATE integration_jobs SET status = 'pending', run_after = now(), updated_at = now()
        WHERE tenant_id = $1 AND status = 'blocked'`,
      [tenant.id],
    );
  });
  return settings;
}

export async function disconnectGoogle(db: Db, tenantId: string) {
  const r = await db.query(`SELECT encrypted_credentials FROM integrations WHERE tenant_id = $1 AND provider = 'google'`, [tenantId]);
  const sealed = r.rows[0]?.encrypted_credentials;
  if (sealed) {
    try {
      const creds = decryptJson<StoredCredentials>(sealed);
      await fetchImpl('https://oauth2.googleapis.com/revoke', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: creds.refresh_token }),
      });
    } catch (err) {
      log.warn('google.revoke_failed', { message: errorMessage(err) });
    }
  }
  // Keep folder/sheet ids so a reconnect reuses them.
  await db.query(
    `UPDATE integrations SET status = 'disconnected', encrypted_credentials = NULL, updated_at = now()
      WHERE tenant_id = $1 AND provider = 'google'`,
    [tenantId],
  );
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

function formatDate(d: Date, timeZone: string) {
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
  } catch {
    return d.toISOString();
  }
}

async function driveUpload(job: Job) {
  const { tenant, client, ticket, pending } = await withTenant(job.tenant_id, async (db) => {
    const client = await GoogleClient.forTenant(db, job.tenant_id);
    const tenant = await getTenant(db, job.tenant_id);
    const t = await db.query(`SELECT id, number, meta FROM tickets WHERE id = $1`, [job.ticket_id]);
    const a = await db.query(`SELECT id, file_name, mime_type, blob_key FROM attachments WHERE ticket_id = $1 AND drive_file_id IS NULL ORDER BY created_at`, [job.ticket_id]);
    return { tenant, client, ticket: t.rows[0], pending: a.rows };
  });
  if (!ticket) throw new PermanentJobError('Ticket no longer exists');
  if (!pending.length) return;
  if (!client.settings.rootFolderId) throw new IntegrationNotConnected('Google Drive folder is not set up. Reconnect Google.');

  let folderId: string | undefined = ticket.meta?.driveFolderId;
  if (!folderId) {
    const folder = await client.createFolder(ticket.number, client.settings.rootFolderId);
    folderId = folder.id;
    await withTenant(job.tenant_id, (db) =>
      db.query(`UPDATE tickets SET meta = meta || jsonb_build_object('driveFolderId', $2::text, 'driveFolderUrl', $3::text) WHERE id = $1`, [ticket.id, folder.id, folder.webViewLink]),
    );
  }

  const store = getBlobStore();
  for (const a of pending) {
    const data = await store.get(a.blob_key);
    if (!data) throw new PermanentJobError(`Stored file missing for attachment ${a.id}`);
    const file = await client.uploadFile({ name: a.file_name, mimeType: a.mime_type, parentId: folderId!, data, description: `${tenant.name} ticket ${ticket.number}` });
    await withTenant(job.tenant_id, (db) =>
      db.query(`UPDATE attachments SET drive_file_id = $2, drive_url = $3 WHERE id = $1`, [a.id, file.id, file.webViewLink]),
    );
  }
  // Put the new links into the Sheet.
  await withTenant(job.tenant_id, (db) => enqueueJob(db, job.tenant_id, job.ticket_id, 'sheet_sync', { blocked: false }));
}

async function sheetSync(job: Job) {
  const { tenant, client, t, attachments } = await withTenant(job.tenant_id, async (db) => {
    const client = await GoogleClient.forTenant(db, job.tenant_id);
    const tenant = await getTenant(db, job.tenant_id);
    const r = await db.query(`SELECT * FROM tickets WHERE id = $1`, [job.ticket_id]);
    const a = await db.query(`SELECT file_name, drive_url FROM attachments WHERE ticket_id = $1 ORDER BY created_at`, [job.ticket_id]);
    return { tenant, client, t: r.rows[0], attachments: a.rows };
  });
  if (!t) throw new PermanentJobError('Ticket no longer exists');
  const ssId = client.settings.spreadsheetId;
  const sheet = client.settings.sheetTitle ?? SHEET_TITLE;
  if (!ssId) throw new IntegrationNotConnected('Google Sheet is not set up. Reconnect Google.');

  const tz = tenant.config.timezone;
  const row = [
    t.number,
    formatDate(new Date(t.created_at), tz),
    t.name,
    formatPhone(t.phone),
    t.org_name,
    t.category ?? t.ai_category ?? '',
    PRIORITY_LABEL[t.priority as TicketPriority],
    STATUS_LABEL[t.status as TicketStatus],
    t.description,
    t.ai_summary ?? '',
    attachments.map((a: any) => a.drive_url ? `${a.file_name}: ${a.drive_url}` : `${a.file_name} (uploading)`).join('\n'),
    formatDate(new Date(t.updated_at), tz),
    `${env.baseUrl}/admin/tickets/${t.number}`,
  ];

  const col = await client.values(ssId, `${sheet}!A:A`);
  const ids = col.values?.[0] ?? [];
  const idx = ids.indexOf(t.number);
  if (idx >= 0) await client.putRow(ssId, `${sheet}!A${idx + 1}`, row);
  else await client.appendRow(ssId, `${sheet}!A:A`, row);
}

export function registerGoogleJobs() {
  registerJobHandler('drive_upload', driveUpload);
  registerJobHandler('sheet_sync', sheetSync);
}
