// CLI: apply migrations to DATABASE_URL (normally not needed: the app migrates on first request).
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import { runMigrations } from '../src/server/setup/migrations.js';

export async function migrate(databaseUrl: string, log: (s: string) => void = console.log) {
  const local = /@(localhost|127\.0\.0\.1)[:/]/.test(databaseUrl);
  const client = new pg.Client({ connectionString: databaseUrl, ssl: local ? undefined : { rejectUnauthorized: true } });
  await client.connect();
  try {
    const files = (await readdir('db/migrations')).filter((f) => f.endsWith('.sql'));
    const migrations = await Promise.all(files.map(async (name) => ({ name, sql: await readFile(`db/migrations/${name}`, 'utf8') })));
    await runMigrations(client, migrations, log);
  } finally {
    await client.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.DATABASE_URL ?? process.env.NETLIFY_DB_URL;
  if (!url) { console.error('migrate: DATABASE_URL is not set'); process.exit(1); }
  migrate(url).then(() => console.log('migrate: up to date')).catch((e) => { console.error(e.message); process.exit(1); });
}
