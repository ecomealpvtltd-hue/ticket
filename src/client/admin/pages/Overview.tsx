import { AlertTriangle, ArrowRight } from 'lucide-preact';
import { useApi, formatDuration, relativeTime } from '../lib.js';
import { Empty, ErrorState, Notice, PageHeader, PriorityMark, Section, Skeleton, StatusBadge } from '../ui.js';
import type { TicketItem } from './Tickets.js';
import { PRIORITY_LABEL } from '../../../shared/constants.js';

interface OverviewData {
  counts: { open: number; in_progress: number; resolved: number; closed: number; total: number; high_open: number; last_24h: number; median_resolution_seconds: number | null };
  attention: TicketItem[];
  sync: { failed: number; pending: number; blocked: number };
}

export function Overview() {
  const { data, error, loading, reload } = useApi<OverviewData>('/api/admin/overview');

  return (
    <div class="page">
      <PageHeader title="Overview" />
      {error && <ErrorState message={error.message} onRetry={() => reload()} />}

      {data && data.sync.failed > 0 && (
        <Notice tone="warn" action={<a class="notice-link" href="/admin/integrations">Review</a>}>
          {data.sync.failed === 1 ? '1 ticket' : `${data.sync.failed} tickets`} could not be synced to Google. The tickets themselves are safe.
        </Notice>
      )}
      {data && data.sync.blocked > 0 && data.sync.failed === 0 && (
        <Notice tone="info" action={<a class="notice-link" href="/admin/integrations">Connect</a>}>
          {data.sync.blocked === 1 ? '1 ticket is' : `${data.sync.blocked} tickets are`} waiting for Google Sheets and Drive to be connected.
        </Notice>
      )}

      <dl class="metrics">
        <Metric label="Open" value={data?.counts.open} href="/admin/tickets?status=open" loading={loading} />
        <Metric label="In progress" value={data?.counts.in_progress} href="/admin/tickets?status=in_progress" loading={loading} />
        <Metric label="Resolved" value={data?.counts.resolved} href="/admin/tickets?status=resolved" loading={loading} />
        <Metric label="Total" value={data?.counts.total} href="/admin/tickets" loading={loading} />
      </dl>
      {data && data.counts.total > 0 && (
        <p class="metrics-foot">
          {data.counts.last_24h} new in the last 24 hours
          {data.counts.median_resolution_seconds != null && <>. Median time to resolve over 30 days: {formatDuration(data.counts.median_resolution_seconds)}</>}
        </p>
      )}

      <Section title="Needs attention" description="Open tickets, highest priority and oldest first."
        actions={<a class="link" href="/admin/tickets?status=active&sort=priority">All open tickets <ArrowRight size={14} aria-hidden="true" /></a>}>
        {loading && !data ? (
          <div class="list">{[0, 1, 2].map(() => <div class="list-row"><Skeleton w="60%" /></div>)}</div>
        ) : data && data.attention.length === 0 ? (
          <Empty title="No open tickets">New tickets from the widget will appear here.</Empty>
        ) : (
          <ul class="list">
            {data?.attention.map((t) => (
              <li>
                <a class="list-row" href={`/admin/tickets/${t.number}`}>
                  <span class="mono num">{t.number}</span>
                  <PriorityMark priority={t.priority} />
                  <span class="list-main">
                    <span class="list-title">{t.orgName}</span>
                    <span class="list-sub">{t.excerpt}</span>
                  </span>
                  {t.aiPriority && (t.aiPriority === 'urgent' || t.aiPriority === 'high') && t.priority !== t.aiPriority && (
                    <span class="hint-chip" title="AI-suggested priority"><AlertTriangle size={12} aria-hidden="true" /> AI suggests {PRIORITY_LABEL[t.aiPriority]}</span>
                  )}
                  <StatusBadge status={t.status} />
                  <span class="list-time">{relativeTime(t.createdAt)}</span>
                </a>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

function Metric({ label, value, href, loading }: { label: string; value?: number; href: string; loading: boolean }) {
  return (
    <a class="metric" href={href}>
      <dt>{label}</dt>
      <dd>{loading && value === undefined ? <Skeleton w={40} h={28} /> : (value ?? 0).toLocaleString('en-IN')}</dd>
    </a>
  );
}
