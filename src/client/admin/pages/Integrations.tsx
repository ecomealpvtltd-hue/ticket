import { useState } from 'preact/hooks';
import { ExternalLink, RotateCw } from 'lucide-preact';
import { api, prototype, relativeTime, useApi, useLocation, type ApiError } from '../lib.js';
import { Button, Empty, ErrorState, Notice, PageHeader, Section, Skeleton, useToast } from '../ui.js';
import { can, useMe } from '../main.js';

interface IntegrationsData {
  googleConfigured: boolean;
  aiConfigured: boolean;
  google: { status: 'connected' | 'error' | 'disconnected'; accountEmail: string | null; folderUrl: string | null; spreadsheetUrl: string | null; lastError: string | null; updatedAt: string } | null;
  queue: { waiting: number; queued: number };
  failedJobs: Array<{ id: string; kind: string; attempts: number; lastError: string | null; updatedAt: string; ticketNumber: string }>;
}

const CONNECT_ERRORS: Record<string, string> = {
  cancelled: 'Connection was cancelled.',
  failed: "Google didn't finish connecting. Please try again.",
  no_refresh_token: 'Google did not grant offline access. Remove this app from your Google account permissions, then connect again.',
  scope_missing: 'Drive access was not granted. Connect again and allow access to files created by this app.',
  session_changed: 'Your session changed during sign-in. Please try again.',
  google_not_configured: 'Google is not configured on this server yet.',
};

export function Integrations() {
  const { me } = useMe();
  const toast = useToast();
  const { search } = useLocation();
  const { data, error, loading, reload } = useApi<IntegrationsData>('/api/admin/integrations');
  const [busy, setBusy] = useState<string | null>(null);
  const isAdmin = can(me, 'admin');
  const connected = search.get('connected') === '1';
  const connectError = search.get('error');

  async function disconnect() {
    if (!confirm('Disconnect Google? New tickets will wait until you reconnect. Existing files in Drive and the Sheet are kept.')) return;
    setBusy('disconnect');
    try {
      await api('/api/admin/integrations/google/disconnect', { method: 'POST' });
      await reload(true);
      toast('success', 'Google disconnected.');
    } catch (e) { toast('error', (e as ApiError).message); } finally { setBusy(null); }
  }

  async function retry(id: string) {
    setBusy(id);
    try {
      await api(`/api/admin/jobs/${id}/retry`, { method: 'POST' });
      await reload(true);
      toast('success', 'Retried.');
    } catch (e) { toast('error', (e as ApiError).message); } finally { setBusy(null); }
  }

  if (error) return <div class="page"><PageHeader title="Integrations" /><ErrorState message={error.message} onRetry={() => reload()} /></div>;

  const g = data?.google;
  const waiting = data?.queue.waiting ?? 0;
  const pending = data?.queue.queued ?? 0;

  return (
    <div class="page">
      <PageHeader title="Integrations" description="Tickets are always saved here first. Integrations receive a copy." />
      {connected && <Notice tone="success">Google connected. Existing tickets are being copied to your Sheet.</Notice>}
      {connectError && (
        <Notice tone="error">
          {CONNECT_ERRORS[connectError] ?? CONNECT_ERRORS.failed}
          {search.get('detail') && <span class="notice-detail">Google said: {search.get('detail')}</span>}
        </Notice>
      )}

      <Section title="Google Sheets and Drive" description="Every ticket is added as a row in a Google Sheet, and attachments are copied to a Drive folder per ticket. The app can only access files it creates.">
        {loading && !data ? <Skeleton h={96} /> : !data!.googleConfigured ? (
          <Notice tone="warn">Google is not configured on this server yet. An administrator needs to add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (see README, Google setup).</Notice>
        ) : (
          <div class="integration">
            <div class="integration-status">
              <span class={`dot ${g?.status === 'connected' ? 'dot-ok' : g?.status === 'error' ? 'dot-bad' : 'dot-off'}`} aria-hidden="true" />
              <div>
                <p class="integration-title">
                  {g?.status === 'connected' ? 'Connected' : g?.status === 'error' ? 'Needs reconnecting' : 'Not connected'}
                </p>
                <p class="integration-sub">
                  {g?.status === 'connected' && g.accountEmail && <>as {g.accountEmail}</>}
                  {g?.status === 'error' && g.lastError}
                  {(!g || g.status === 'disconnected') && 'Connect a Google account to start syncing.'}
                </p>
              </div>
            </div>
            {g?.status === 'connected' && (
              <div class="integration-links">
                {g.spreadsheetUrl && <a class="btn btn-secondary btn-sm" href={g.spreadsheetUrl} target="_blank" rel="noopener noreferrer">Open Sheet <ExternalLink size={13} aria-hidden="true" /></a>}
                {g.folderUrl && <a class="btn btn-secondary btn-sm" href={g.folderUrl} target="_blank" rel="noopener noreferrer">Open Drive folder <ExternalLink size={13} aria-hidden="true" /></a>}
              </div>
            )}
            {isAdmin && (
              <div class="integration-actions">
                {g?.status === 'connected'
                  ? <Button size="sm" variant="ghost" onClick={disconnect} loading={busy === 'disconnect'}>Disconnect</Button>
                  : prototype ? <span class="integration-sub">Connecting Google is available on the live deployment.</span>
                  : <Button variant="primary" href="/api/integrations/google/start">{g?.status === 'error' ? 'Reconnect Google' : 'Connect Google'}</Button>}
              </div>
            )}
          </div>
        )}
        {data && (waiting > 0 || pending > 0) && (
          <p class="section-foot">
            {waiting > 0 && <>{waiting === 1 ? '1 ticket is' : `${waiting} tickets are`} waiting for Google. </>}
            {pending > 0 && <>{pending === 1 ? '1 ticket is' : `${pending} tickets are`} queued for sync.</>}
          </p>
        )}
      </Section>

      <Section title="Sync failures" description="Items that failed after automatic retries. The tickets are safe; only the copy to Google is missing.">
        {data?.failedJobs.length ? (
          <ul class="list">
            {data.failedJobs.map((j) => (
              <li class="list-row static">
                <a class="mono num" href={`/admin/tickets/${j.ticketNumber}`}>{j.ticketNumber}</a>
                <span class="list-main">
                  <span class="list-title">{j.kind === 'sheet_sync' ? 'Google Sheet row' : j.kind === 'drive_upload' ? 'Drive attachments' : 'AI summary'}</span>
                  <span class="list-sub">{j.lastError ?? 'Unknown error'}</span>
                </span>
                <span class="list-time">{relativeTime(j.updatedAt)}</span>
                {can(me, 'agent') && <Button size="sm" onClick={() => retry(j.id)} loading={busy === j.id}><RotateCw size={13} aria-hidden="true" />Retry</Button>}
              </li>
            ))}
          </ul>
        ) : data ? <Empty title="No failures">Everything that should be in Google is there or on its way.</Empty> : <Skeleton h={48} />}
      </Section>

      <Section title="AI triage" description="Suggests a category, a priority and a one-line summary for each new ticket. It never blocks a ticket and never changes priority on its own.">
        {data && (data.aiConfigured
          ? <p class="integration-sub"><span class="dot dot-ok" aria-hidden="true" /> On. Phone numbers and emails are removed before text is sent to the model.</p>
          : <p class="integration-sub"><span class="dot dot-off" aria-hidden="true" /> Off. Add an ANTHROPIC_API_KEY on the server to turn it on.</p>)}
      </Section>
    </div>
  );
}
