import pg from 'pg';
import { env } from './env.js';
import { log } from './log.js';

export type Db = pg.PoolClient;

let pool: pg.Pool | null = null;
let restrictedRoleAvailable: boolean | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    const url = env.databaseUrl;
    const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
    pool = new pg.Pool({
      connectionString: url,
      // Serverless: keep each function instance's footprint small.
      max: 3,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 8_000,
      ssl: local ? undefined : { rejectUnauthorized: true },
    });
    pool.on('error', (err) => log.error('db.pool_error', { message: err.message }));
  }
  return pool;
}

/** For tests and scripts. */
export async function closePool(): Promise<void> {
  if (pool) {
    const p = pool;
    pool = null;
    restrictedRoleAvailable = null;
    await p.end();
  }
}

async function useRestrictedRole(client: Db): Promise<void> {
  if (restrictedRoleAvailable === null) {
    // 'SET' privilege exists on Postgres 16+; older versions only know 'MEMBER'.
    const pgVersion = Number((await client.query('SHOW server_version_num')).rows[0].server_version_num);
    const priv = pgVersion >= 160000 ? 'SET' : 'MEMBER';
    const r = await client.query(
      `SELECT pg_has_role(current_user, 'support_app', '${priv}') AS ok
         FROM pg_roles WHERE rolname = 'support_app'`,
    );
    restrictedRoleAvailable = Boolean(r.rows[0]?.ok);
    if (!restrictedRoleAvailable) {
      log.warn('db.restricted_role_unavailable', {
        note: 'Row-level security relies on the connecting role not bypassing RLS.',
      });
    }
  }
  if (restrictedRoleAvailable) await client.query('SET LOCAL ROLE support_app');
}

async function inTransaction<T>(setup: (c: Db) => Promise<void>, fn: (c: Db) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await useRestrictedRole(client);
    await setup(client);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Run `fn` inside a transaction bound to one tenant. Row-level security guarantees that
 * every read and write in `fn` can only touch rows belonging to `tenantId`, even if a
 * query forgets its own WHERE tenant_id clause.
 */
export function withTenant<T>(tenantId: string, fn: (c: Db) => Promise<T>): Promise<T> {
  if (!/^[0-9a-f-]{36}$/i.test(tenantId)) throw new Error('withTenant: invalid tenant id');
  return inTransaction(
    async (c) => { await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]); },
    fn,
  );
}

/**
 * Cross-tenant access for narrow platform operations only: resolving a widget key,
 * finding an admin by email at sign-in, validating a session, draining the job queue,
 * rate limiting. Never use this for request handling that returns tenant data.
 */
export function withSystem<T>(fn: (c: Db) => Promise<T>): Promise<T> {
  return inTransaction(
    async (c) => { await c.query(`SELECT set_config('app.system', 'on', true)`); },
    fn,
  );
}
