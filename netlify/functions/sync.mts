// Scheduled every 5 minutes: retries integration jobs (Google Drive, Sheets, AI) that are due,
// and removes uploads that were never attached to a ticket.
import type { Config } from '@netlify/functions';
import { getRouter } from '../../src/server/app.js';
import { runJobs, cleanupOrphanAttachments } from '../../src/server/services/jobs.js';
import { getBlobStore } from '../../src/server/storage.js';
import { log } from '../../src/server/log.js';
import { ensureReady } from '../../src/server/setup/bootstrap.js';

export default async () => {
  await ensureReady();
  getRouter(); // registers job handlers
  const summary = await runJobs({ budgetMs: 22_000, limit: 10 });
  const orphans = await cleanupOrphanAttachments((k) => getBlobStore().delete(k));
  log.info('sync.run', { ...summary, orphansRemoved: orphans });
};

export const config: Config = { schedule: '*/5 * * * *' };
