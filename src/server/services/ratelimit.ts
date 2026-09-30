import { withSystem } from '../db.js';
import { HttpError } from '../http.js';
import { env } from '../env.js';

/**
 * Fixed-window counter in Postgres. Good enough for abuse protection at this scale and it
 * needs no extra infrastructure (no Redis). Returns true when the request is allowed.
 */
export async function allow(bucket: string, limit: number, windowSeconds: number): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  const windowStart = new Date((now - (now % windowSeconds)) * 1000);
  const count = await withSystem(async (db) => {
    const r = await db.query(
      `INSERT INTO rate_limits (bucket, window_start, count) VALUES ($1, $2, 1)
       ON CONFLICT (bucket, window_start) DO UPDATE SET count = rate_limits.count + 1
       RETURNING count`,
      [bucket, windowStart],
    );
    if (Math.random() < 0.02) {
      await db.query(`DELETE FROM rate_limits WHERE window_start < now() - interval '1 day'`);
    }
    return r.rows[0].count as number;
  });
  return count <= limit;
}

export async function enforce(checks: Array<[bucket: string, limit: number, windowSeconds: number]>): Promise<void> {
  // Local development only: repeated QA runs from 127.0.0.1 would otherwise trip the limits.
  const factor = env.appEnv === 'development' && process.env.RELAX_RATE_LIMITS === 'true' ? 100 : 1;
  for (const [bucket, limit, windowSeconds] of checks) {
    if (!(await allow(bucket, limit * factor, windowSeconds))) {
      throw new HttpError(429, 'rate_limited', 'Too many requests. Please wait a few minutes and try again.');
    }
  }
}
