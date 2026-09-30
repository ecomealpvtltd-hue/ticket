// CLI: create tenants from tenants/*.json (normally not needed: the app does this on first request).
import { readdir, readFile } from 'node:fs/promises';
import { seedTenants } from '../src/server/setup/seed.js';
import { closePool } from '../src/server/db.js';

export async function seed(opts: { ownerEmails?: string[]; extraOrigins?: string[]; log?: (s: string) => void } = {}) {
  const files = (await readdir('tenants')).filter((f) => f.endsWith('.json')).sort();
  const defs = await Promise.all(files.map(async (f) => JSON.parse(await readFile(`tenants/${f}`, 'utf8'))));
  return seedTenants(defs, { log: console.log, ...opts });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const ownerEmails = (process.env.BOOTSTRAP_OWNER_EMAILS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  seed({ ownerEmails }).then(() => closePool()).catch(async (e) => { console.error(`seed failed: ${e.message}`); await closePool(); process.exit(1); });
}
