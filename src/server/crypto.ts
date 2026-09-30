import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { env } from './env.js';

/** URL-safe random token. */
export function randomToken(bytes = 24): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** New publishable widget key. The prefix states the environment it belongs to. */
export function newPublicKey(): string {
  const prefix = env.appEnv === 'production' ? 'pk_live_' : 'pk_test_';
  return prefix + randomBytes(18).toString('base64url');
}

// ---------------------------------------------------------------------------
// Signed values (HMAC-SHA256). Used for OAuth state and short-lived embed tokens.
// ---------------------------------------------------------------------------

function hmac(purpose: string, payload: string): string {
  return createHmac('sha256', env.sessionSecret).update(`${purpose}.${payload}`).digest('base64url');
}

export function sign(purpose: string, data: Record<string, unknown>, ttlSeconds: number): string {
  const payload = Buffer.from(JSON.stringify({ ...data, exp: Math.floor(Date.now() / 1000) + ttlSeconds }))
    .toString('base64url');
  return `${payload}.${hmac(purpose, payload)}`;
}

export function verify<T extends Record<string, unknown>>(purpose: string, token: string | null | undefined): T | null {
  if (!token || typeof token !== 'string') return null;
  const dot = token.lastIndexOf('.');
  if (dot < 1) return null;
  const payload = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = hmac(purpose, payload);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as T & { exp: number };
    if (typeof data.exp !== 'number' || data.exp < Date.now() / 1000) return null;
    return data;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Encryption at rest (AES-256-GCM) for integration credentials.
// Format: v1.<iv>.<tag>.<ciphertext> (base64url parts)
// ---------------------------------------------------------------------------

export function encryptJson(value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', env.encryptionKey, iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join('.');
}

export function decryptJson<T>(sealed: string): T {
  const [v, iv, tag, ct] = sealed.split('.');
  if (v !== 'v1' || !iv || !tag || !ct) throw new Error('Unrecognised credential format');
  const decipher = createDecipheriv('aes-256-gcm', env.encryptionKey, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  const pt = Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]);
  return JSON.parse(pt.toString('utf8')) as T;
}
