// Creates tenants defined in tenants/*.json if they don't exist yet (create-only: settings
// edited later in the dashboard are never overwritten), and bootstraps the first owner.
import { z } from 'zod';
import { withSystem } from '../db.js';
import { newPublicKey } from '../crypto.js';
import { isValidOriginPattern } from '../services/tenants.js';
import { tenantConfigSchema } from '../../shared/model.js';

export const tenantFileSchema = z.object({
  slug: z.string(),
  name: z.string(),
  ticketPrefix: z.string().regex(/^[A-Z]{2,6}$/),
  allowedOrigins: z.array(z.string()).default([]),
  config: tenantConfigSchema,
});

export async function seedTenants(
  defs: unknown[],
  opts: { ownerEmails?: string[]; extraOrigins?: string[]; log?: (s: string) => void } = {},
) {
  const log = opts.log ?? (() => {});
  const results: Array<{ slug: string; created: boolean; publicKey?: string; tenantId: string }> = [];
  for (const raw of defs) {
    const def = tenantFileSchema.parse(raw);
    const origins = [...new Set([...def.allowedOrigins, ...(opts.extraOrigins ?? [])])];
    for (const o of origins) if (!isValidOriginPattern(o)) throw new Error(`Tenant ${def.slug}: invalid allowed origin ${o}`);

    const r = await withSystem(async (db) => {
      const existing = await db.query(`SELECT id FROM tenants WHERE slug = $1`, [def.slug]);
      let tenantId: string = existing.rows[0]?.id;
      let publicKey: string | undefined;
      const created = !tenantId;
      if (created) {
        const t = await db.query(
          `INSERT INTO tenants (slug, name, ticket_prefix, config, allowed_origins) VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (slug) DO NOTHING RETURNING id`,
          [def.slug, def.name, def.ticketPrefix, JSON.stringify(def.config), origins],
        );
        if (!t.rows[0]) return { slug: def.slug, created: false, tenantId: (await db.query(`SELECT id FROM tenants WHERE slug = $1`, [def.slug])).rows[0].id };
        tenantId = t.rows[0].id;
        publicKey = newPublicKey();
        await db.query(`INSERT INTO widget_keys (tenant_id, public_key, label) VALUES ($1, $2, 'Default')`, [tenantId, publicKey]);
      }
      const owners = await db.query(`SELECT count(*)::int AS n FROM admins WHERE tenant_id = $1 AND role = 'owner' AND status = 'active'`, [tenantId]);
      if (owners.rows[0].n === 0) {
        for (const email of opts.ownerEmails ?? []) {
          await db.query(
            `INSERT INTO admins (tenant_id, email, role) VALUES ($1, $2, 'owner')
             ON CONFLICT (tenant_id, email) DO UPDATE SET role = 'owner', status = 'active'`,
            [tenantId, email.toLowerCase().trim()],
          );
          log(`seed: ${def.slug}: added owner ${email.replace(/^(.{2}).*@/, '$1***@')}`);
        }
      }
      return { slug: def.slug, created, publicKey, tenantId };
    });
    log(r.created ? `seed: created tenant ${r.slug}` : `seed: tenant ${r.slug} exists, left unchanged`);
    results.push(r);
  }
  return results;
}
