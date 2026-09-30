import { createHash } from 'node:crypto';

// Central, validated access to environment configuration.
// Nothing here is ever sent to a browser.

export type AppEnv = 'development' | 'staging' | 'production';

function read(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === '' ? undefined : v;
}

function required(name: string): string {
  const v = read(name);
  if (!v) throw new Error(`Missing required environment variable ${name}`);
  return v;
}

export const env = {
  get appEnv(): AppEnv {
    // Secure default: anything not explicitly marked development/staging is production.
    const v = read('APP_ENV') ?? 'production';
    if (v !== 'development' && v !== 'staging' && v !== 'production') {
      throw new Error(`APP_ENV must be development, staging or production (got "${v}")`);
    }
    return v;
  },
  get databaseUrl(): string {
    // DATABASE_URL (any Postgres, e.g. Neon) wins; otherwise use Netlify Database's variable.
    const v = read('DATABASE_URL') ?? read('NETLIFY_DB_URL') ?? read('NETLIFY_DATABASE_URL');
    if (!v) throw new Error('No database configured: set DATABASE_URL, or enable Netlify Database (NETLIFY_DB_URL)');
    return v;
  },
  /** Public origin of the platform, e.g. https://support.ecomeal.in (no trailing slash). */
  get baseUrl(): string {
    const v = read('PUBLIC_BASE_URL') ?? read('URL'); // Netlify sets URL automatically
    if (!v) throw new Error('Missing PUBLIC_BASE_URL');
    return v.replace(/\/+$/, '');
  },
  get sessionSecret(): string {
    const v = required('SESSION_SECRET');
    if (v.length < 32) throw new Error('SESSION_SECRET must be at least 32 characters');
    return v;
  },
  /**
   * Key used to encrypt integration credentials at rest (AES-256-GCM). Accepts a 32-byte
   * base64 key, or any random string of 32+ characters (hashed to 32 bytes). Never change it
   * after Google is connected, or stored credentials can't be read (reconnect Google if so).
   */
  get encryptionKey(): Buffer {
    const raw = required('ENCRYPTION_KEY');
    const b64 = Buffer.from(raw, 'base64');
    if (b64.length === 32 && /^[A-Za-z0-9+/]{43}=$/.test(raw)) return b64;
    if (raw.length < 32) throw new Error('ENCRYPTION_KEY must be at least 32 characters');
    return createHash('sha256').update(raw).digest();
  },
  get googleClientId(): string | undefined { return read('GOOGLE_CLIENT_ID'); },
  get googleClientSecret(): string | undefined { return read('GOOGLE_CLIENT_SECRET'); },
  get anthropicApiKey(): string | undefined { return read('ANTHROPIC_API_KEY'); },
  get aiModel(): string { return read('AI_MODEL') ?? 'claude-haiku-4-5'; },
  get blobStore(): 'netlify' | 'fs' {
    return (read('BLOB_STORE') ?? (read('NETLIFY') ? 'netlify' : 'fs')) === 'netlify' ? 'netlify' : 'fs';
  },
  get blobDir(): string { return read('BLOB_DIR') ?? '.local/blobs'; },
  /** Only honoured when APP_ENV=development AND the request comes to localhost. */
  get devLoginEnabled(): boolean { return read('DEV_LOGIN') === 'true'; },
};

export function googleConfigured(): boolean {
  return Boolean(env.googleClientId && env.googleClientSecret);
}
