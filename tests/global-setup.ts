import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { migrate } from '../scripts/migrate.js';

let server: EmbeddedPostgres | null = null;
let startedHere = false;

export async function setup() {
  server = new EmbeddedPostgres({
    databaseDir: '/var/tmp/support-pg/data',
    user: 'postgres', password: 'postgres', port: 54329, persistent: true,
    onLog: () => {}, onError: () => {},
  });
  try { await server.start(); startedHere = true; } catch { /* already running (e.g. dev server) */ }
  const admin = new pg.Client({ connectionString: 'postgres://postgres:postgres@localhost:54329/postgres' });
  await admin.connect();
  await admin.query('DROP DATABASE IF EXISTS support_test WITH (FORCE)');
  await admin.query('CREATE DATABASE support_test');
  await admin.end();
  await migrate('postgres://postgres:postgres@localhost:54329/support_test', () => {});
}

export async function teardown() {
  // Only stop Postgres if this run started it (a dev server may be using it).
  if (startedHere && server) await server.stop();
}
