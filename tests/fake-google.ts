// An in-memory stand-in for the parts of Google's APIs the platform uses. It lets the tests
// exercise the real integration code paths (token refresh, folder/sheet creation, uploads,
// row upserts) and inject failures, without network access.

export class FakeGoogle {
  files = new Map<string, { name: string; mimeType?: string; parents?: string[]; trashed?: boolean; size?: number }>();
  sheets = new Map<string, string[][]>(); // spreadsheetId -> rows
  failNext: Record<string, number> = {}; // e.g. { sheets: 2 } => next 2 sheets calls return 500
  revoked = false;
  calls: string[] = [];
  private n = 0;

  private id(prefix: string) { return `${prefix}_${++this.n}`; }

  private fail(area: string): Response | null {
    if ((this.failNext[area] ?? 0) > 0) {
      this.failNext[area]--;
      return new Response(JSON.stringify({ error: { message: `${area} temporarily unavailable` } }), { status: 500 });
    }
    return null;
  }

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? 'GET';
    this.calls.push(`${method} ${url.host}${url.pathname}`);
    const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

    if (url.host === 'oauth2.googleapis.com' && url.pathname === '/token') {
      const params = new URLSearchParams(String(init?.body));
      if (params.get('grant_type') === 'refresh_token') {
        if (this.revoked) return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
        return ok({ access_token: 'at_' + this.n++, expires_in: 3600 });
      }
      return ok({ access_token: 'at_first', refresh_token: 'rt_1', expires_in: 3600, scope: 'openid email https://www.googleapis.com/auth/drive.file' });
    }
    if (url.host === 'oauth2.googleapis.com' && url.pathname === '/revoke') return ok({});

    if (url.host === 'www.googleapis.com' && url.pathname.startsWith('/drive/v3/files') || url.pathname.startsWith('/upload/drive/v3/files')) {
      const f = this.fail('drive'); if (f) return f;
      const idMatch = /\/files\/([^/?]+)/.exec(url.pathname);
      if (method === 'GET' && !idMatch && url.searchParams.get('q')) {
        const q = url.searchParams.get('q')!;
        const name = /name = '((?:[^'\\]|\\.)*)'/.exec(q)?.[1].replace(/\\'/g, "'");
        const parent = /'([^']+)' in parents/.exec(q)?.[1];
        const found = [...this.files.entries()].filter(([, f]) => f.name === name && f.parents?.includes(parent!) && f.mimeType === 'application/vnd.google-apps.folder' && !f.trashed);
        return ok({ files: found.slice(0, 1).map(([id]) => ({ id, webViewLink: `https://drive.google.com/drive/folders/${id}` })) });
      }
      if (method === 'GET' && idMatch) {
        const file = this.files.get(idMatch[1]);
        return file ? ok({ id: idMatch[1], trashed: !!file.trashed }) : new Response('{"error":{"message":"not found"}}', { status: 404 });
      }
      if (method === 'PATCH' && idMatch) {
        const file = this.files.get(idMatch[1]);
        if (file) file.parents = [url.searchParams.get('addParents')!];
        return ok({ id: idMatch[1] });
      }
      if (url.pathname.startsWith('/upload/')) {
        const body = init?.body as Buffer;
        const text = body.toString('latin1');
        const meta = JSON.parse(/\r\n\r\n(\{.*?\})\r\n--/s.exec(text)![1]);
        const id = this.id('file');
        this.files.set(id, { name: meta.name, parents: meta.parents, size: body.length });
        return ok({ id, webViewLink: `https://drive.google.com/file/d/${id}/view` });
      }
      const meta = JSON.parse(String(init?.body));
      if (meta.mimeType === 'application/vnd.google-apps.spreadsheet') {
        const id = this.id('sheet');
        this.files.set(id, { name: meta.name, mimeType: meta.mimeType, parents: meta.parents });
        this.sheets.set(id, []);
        return ok({ id, webViewLink: `https://docs.google.com/spreadsheets/d/${id}/edit` });
      }
      const id = this.id('folder');
      this.files.set(id, { name: meta.name, mimeType: meta.mimeType, parents: meta.parents });
      return ok({ id, webViewLink: `https://drive.google.com/drive/folders/${id}` });
    }

    if (url.host === 'sheets.googleapis.com') {
      const f = this.fail('sheets'); if (f) return f;
      if (url.pathname === '/v4/spreadsheets' && method === 'POST') {
        const id = this.id('sheet');
        this.files.set(id, { name: JSON.parse(String(init?.body)).properties.title });
        this.sheets.set(id, []);
        return ok({ spreadsheetId: id, spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${id}`, sheets: [{ properties: { sheetId: 0 } }] });
      }
      const m = /^\/v4\/spreadsheets\/([^/:]+)(?:\/values\/(.+?))?(?::(append|batchUpdate))?$/.exec(decodeURIComponent(url.pathname));
      if (!m) return new Response('unknown', { status: 404 });
      const [, ssId, range, action] = m;
      const rows = this.sheets.get(ssId);
      if (!rows) return new Response('{"error":{"message":"Requested entity was not found."}}', { status: 404 });
      if (action === 'batchUpdate') return ok({});
      if (!range && method === 'GET') return ok({ sheets: [{ properties: { sheetId: 0 } }] });
      if (range && action === 'append') {
        const { values } = JSON.parse(String(init?.body));
        rows.push(values[0]);
        return ok({ updates: { updatedRange: `Tickets!A${rows.length}` } });
      }
      if (range && method === 'PUT') {
        const { values } = JSON.parse(String(init?.body));
        const row = Number(/!A(\d+)/.exec(range)![1]);
        rows[row - 1] = values[0];
        return ok({});
      }
      if (range && method === 'GET') {
        return ok({ values: rows.length ? [rows.map((r) => r?.[0] ?? '')] : [] });
      }
    }
    return new Response(`FakeGoogle: unhandled ${method} ${url}`, { status: 501 });
  };
}

/** A minimal id_token as Google's token endpoint would return it. */
export function fakeIdToken(email: string, clientId = process.env.GOOGLE_CLIENT_ID!) {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${enc({ alg: 'RS256' })}.${enc({ iss: 'https://accounts.google.com', aud: clientId, email, email_verified: true, sub: '123', exp: Math.floor(Date.now() / 1000) + 600 })}.sig`;
}
