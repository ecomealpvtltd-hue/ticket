// Bundles database migrations and tenant definitions into the server code, so the deployed
// functions can set up the database themselves on first run.
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';

const migrations = [];
for (const f of (await readdir('db/migrations')).filter((f) => f.endsWith('.sql')).sort()) {
  migrations.push({ name: f, sql: await readFile(`db/migrations/${f}`, 'utf8') });
}
const tenants = [];
for (const f of (await readdir('tenants')).filter((f) => f.endsWith('.json')).sort()) {
  tenants.push(JSON.parse(await readFile(`tenants/${f}`, 'utf8')));
}
await mkdir('src/server/generated', { recursive: true });
await writeFile('src/server/generated/data.json', JSON.stringify({ migrations, tenants }, null, 2) + '\n');
console.log(`generate: ${migrations.length} migration(s), ${tenants.length} tenant(s)`);
