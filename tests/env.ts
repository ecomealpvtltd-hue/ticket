// Test environment. Real Postgres (embedded), real migrations, local file blob store.
process.env.APP_ENV = 'development';
process.env.DATABASE_URL = 'postgres://postgres:postgres@localhost:54329/support_test';
process.env.PUBLIC_BASE_URL = 'http://localhost:8888';
process.env.SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.BLOB_STORE = 'fs';
process.env.BLOB_DIR = '/var/tmp/support-pg/test-blobs';
process.env.GOOGLE_CLIENT_ID = 'test-client.apps.googleusercontent.com';
process.env.GOOGLE_CLIENT_SECRET = 'test-secret';
delete process.env.ANTHROPIC_API_KEY;

import { setLogSilent } from '../src/server/log.js';
setLogSilent(process.env.TEST_LOGS !== "1");

import { afterAll } from 'vitest';
import { closePool } from '../src/server/db.js';
afterAll(async () => { await closePool(); });
