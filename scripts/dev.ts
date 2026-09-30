// Local development: embedded Postgres + the same handlers Netlify runs, plus a separate
// "customer website" on another port to test embedding across origins.
//
//   npm run dev            → platform on http://localhost:8888, demo site on http://localhost:8899
//
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';

const PLATFORM_PORT = Number(process.env.PORT ?? 8888);
const DEMO_PORT = 8899;
const PG_PORT = 54329;

process.env.APP_ENV ??= 'development';
process.env.DATABASE_URL ??= `postgres://postgres:postgres@localhost:${PG_PORT}/support_dev`;
process.env.PUBLIC_BASE_URL ??= `http://localhost:${PLATFORM_PORT}`;
process.env.SESSION_SECRET ??= 'dev-only-session-secret-not-for-production-use';
process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 1).toString('base64');
process.env.BLOB_STORE ??= 'fs';
process.env.BLOB_DIR ??= '.local/blobs';
process.env.DEV_LOGIN ??= 'true';
process.env.DEV_EXTRA_ORIGINS ??= 'http://localhost:8899';
process.env.RELAX_RATE_LIMITS ??= 'true';

const { migrate } = await import('./migrate.js');
const { seed } = await import('./seed.js');
const { handleApi, handleEmbed, getRouter } = await import('../src/server/app.js');
const { runJobs } = await import('../src/server/services/jobs.js');

// ---- Database -------------------------------------------------------------
const pgServer = new EmbeddedPostgres({
  databaseDir: '/var/tmp/support-pg/data', user: 'postgres', password: 'postgres', port: PG_PORT, persistent: true,
  onLog: () => {}, onError: () => {},
});
try { await pgServer.initialise(); } catch { /* already initialised */ }
try { await pgServer.start(); } catch { /* already running */ }
const admin = new pg.Client({ connectionString: `postgres://postgres:postgres@localhost:${PG_PORT}/postgres` });
await admin.connect();
if (!(await admin.query(`SELECT 1 FROM pg_database WHERE datname = 'support_dev'`)).rowCount) await admin.query('CREATE DATABASE support_dev');
await admin.end();
await migrate(process.env.DATABASE_URL!);
const seeded = await seed({ ownerEmails: (process.env.BOOTSTRAP_OWNER_EMAILS ?? 'dev@ecomeal.in').split(','), extraOrigins: [`http://localhost:${DEMO_PORT}`] });
const ecomeal = seeded.find((s) => s.slug === 'ecomeal')!;
const keyRow = await (await import('../src/server/db.js')).withSystem((db) => db.query(`SELECT public_key FROM widget_keys WHERE tenant_id = $1 AND revoked_at IS NULL ORDER BY created_at LIMIT 1`, [ecomeal.tenantId]));
const ecomealKey: string = keyRow.rows[0].public_key;
getRouter();

// ---- Helpers --------------------------------------------------------------
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.ico': 'image/x-icon' };

async function toRequest(req: IncomingMessage, port: number): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v); else if (Array.isArray(v)) v.forEach((x) => headers.append(k, x));
  return new Request(`http://localhost:${port}${req.url}`, { method: req.method, headers, body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body });
}

async function send(res: ServerResponse, r: Response) {
  const headers: Record<string, string | string[]> = {};
  r.headers.forEach((v, k) => { if (k !== 'set-cookie') headers[k] = v; });
  const cookies = r.headers.getSetCookie();
  if (cookies.length) headers['set-cookie'] = cookies;
  res.writeHead(r.status, headers);
  res.end(Buffer.from(await r.arrayBuffer()));
}

async function serveFile(res: ServerResponse, root: string, path: string, extraHeaders: Record<string, string> = {}, transform?: (s: string) => string) {
  const full = normalize(join(root, path));
  if (!full.startsWith(normalize(root))) { res.writeHead(403).end(); return; }
  try {
    const s = await stat(full);
    if (!s.isFile()) throw new Error('not a file');
    let data: Buffer | string = await readFile(full);
    if (transform) data = transform(data.toString('utf8'));
    res.writeHead(200, { 'content-type': TYPES[extname(full)] ?? 'application/octet-stream', 'cache-control': 'no-cache', ...extraHeaders });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
  }
}

const ADMIN_HEADERS = {
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' https: data: blob:; connect-src 'self'; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self' https://accounts.google.com",
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-content-type-options': 'nosniff',
};

// ---- Platform server ------------------------------------------------------
createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://localhost:${PLATFORM_PORT}`);
    if (url.pathname.startsWith('/api/')) {
      const request = await toRequest(req, PLATFORM_PORT);
      return send(res, await handleApi(request, { ip: req.socket.remoteAddress ?? '127.0.0.1', waitUntil: (p) => { void p; } }));
    }
    if (url.pathname.startsWith('/embed/')) return send(res, await handleEmbed(await toRequest(req, PLATFORM_PORT)));
    if (url.pathname === '/widget.js') return serveFile(res, 'dist', 'widget.js', { 'access-control-allow-origin': '*' });
    if (url.pathname.startsWith('/assets/')) return serveFile(res, 'dist', url.pathname);
    if (url.pathname === '/' ) { res.writeHead(302, { location: '/admin' }).end(); return; }
    if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) return serveFile(res, 'dist', 'admin/index.html', ADMIN_HEADERS);
    res.writeHead(404).end('Not found');
  } catch (err) {
    console.error(err);
    res.writeHead(500).end('Internal error');
  }
}).listen(PLATFORM_PORT, () => console.log(`platform  http://localhost:${PLATFORM_PORT}/admin   (dev sign-in: dev@ecomeal.in)`));

// ---- Demo customer website (different origin) ------------------------------
createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${DEMO_PORT}`);
  const page = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  return serveFile(res, 'demo', page, {}, (html) => html.replaceAll('{{WIDGET_KEY}}', ecomealKey).replaceAll('{{PLATFORM}}', `http://localhost:${PLATFORM_PORT}`));
}).listen(DEMO_PORT, () => console.log(`demo site http://localhost:${DEMO_PORT}      (Ecomeal widget key ${ecomealKey})`));

// ---- Local stand-in for the scheduled function -----------------------------
setInterval(() => { runJobs({ budgetMs: 20_000 }).catch((e) => console.error('jobs', e.message)); }, 60_000);
