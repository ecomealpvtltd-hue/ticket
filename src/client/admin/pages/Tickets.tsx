import { useEffect, useState } from 'preact/hooks';
import { Search, Paperclip, ChevronLeft, ChevronRight } from 'lucide-preact';
import { navigate, useApi, useDebounced, useLocation, relativeTime, formatDateTime } from '../lib.js';
import { Empty, ErrorState, PageHeader, PriorityMark, Skeleton, StatusBadge } from '../ui.js';
import { PRIORITY_LABEL, formatPhone, type TicketPriority, type TicketStatus } from '../../../shared/constants.js';
import { useMe } from '../main.js';

export interface TicketItem {
  id: string; number: string; name: string; phone: string; orgName: string; category: string | null; excerpt: string;
  status: TicketStatus; priority: TicketPriority; aiPriority: TicketPriority | null; attachmentCount: number; createdAt: string; updatedAt: string;
}
interface ListData { tickets: TicketItem[]; total: number; page: number; pageSize: number }

const STATUS_TABS: Array<[string, string]> = [['all', 'All'], ['active', 'Active'], ['open', 'Open'], ['in_progress', 'In progress'], ['resolved', 'Resolved'], ['closed', 'Closed']];

export function Tickets() {
  const { me } = useMe();
  const { search } = useLocation();
  const [q, setQ] = useState(search.get('q') ?? '');
  const status = search.get('status') ?? 'all';
  const priority = search.get('priority') ?? 'all';
  const sort = search.get('sort') ?? 'newest';
  const page = Number(search.get('page') ?? '1') || 1;
  const debouncedQ = useDebounced(q.trim(), 250);

  function setParam(changes: Record<string, string | null>) {
    const p = new URLSearchParams(location.search);
    for (const [k, v] of Object.entries(changes)) {
      if (v === null || v === '' || (k === 'status' && v === 'all') || (k === 'priority' && v === 'all') || (k === 'sort' && v === 'newest') || (k === 'page' && v === '1')) p.delete(k);
      else p.set(k, v);
    }
    const qs = p.toString();
    navigate(`/admin/tickets${qs ? `?${qs}` : ''}`, true);
  }

  useEffect(() => {
    if ((search.get('q') ?? '') !== debouncedQ) setParam({ q: debouncedQ || null, page: null });
  }, [debouncedQ]);

  const qs = new URLSearchParams({ status, priority, sort, page: String(page), ...(debouncedQ ? { q: debouncedQ } : {}) });
  const { data, error, loading, reload } = useApi<ListData>(`/api/admin/tickets?${qs}`, [qs.toString()]);
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const filtered = status !== 'all' || priority !== 'all' || !!debouncedQ;
  const orgLabel = me.tenant.config.form.orgLabel.replace(/ name$/i, '');

  return (
    <div class="page page-wide">
      <PageHeader title="Tickets" description={data ? `${data.total.toLocaleString('en-IN')} ${data.total === 1 ? 'ticket' : 'tickets'}${filtered ? ' match' : ''}` : ' '} />

      <div class="toolbar">
        <div class="search">
          <Search size={16} strokeWidth={1.75} aria-hidden="true" />
          <label class="sr-only" for="ticket-search">Search tickets</label>
          <input id="ticket-search" type="search" class="input" placeholder="Search tickets" value={q}
            onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
        </div>
        <div class="toolbar-selects">
          <label class="select-inline">
            <span class="sr-only">Priority</span>
            <select class="input" value={priority} onChange={(e) => setParam({ priority: (e.target as HTMLSelectElement).value, page: null })}>
              <option value="all">Any priority</option>
              {(['urgent', 'high', 'medium', 'low'] as const).map((p) => <option value={p}>{PRIORITY_LABEL[p]}</option>)}
            </select>
          </label>
          <label class="select-inline">
            <span class="sr-only">Sort</span>
            <select class="input" value={sort} onChange={(e) => setParam({ sort: (e.target as HTMLSelectElement).value, page: null })}>
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
              <option value="priority">Priority</option>
              <option value="updated">Recently updated</option>
            </select>
          </label>
        </div>
      </div>

      <div class="tabs" role="tablist" aria-label="Status">
        {STATUS_TABS.map(([value, label]) => (
          <button role="tab" type="button" aria-selected={status === value} class={`tab ${status === value ? 'active' : ''}`}
            onClick={() => setParam({ status: value, page: null })}>{label}</button>
        ))}
      </div>

      {error ? <ErrorState message={error.message} onRetry={() => reload()} /> : (
        <div class={`table-wrap ${loading && data ? 'is-refreshing' : ''}`}>
          <table class="table">
            <thead>
              <tr>
                <th scope="col" class="c-num">Ticket</th>
                <th scope="col">Customer</th>
                <th scope="col" class="c-org">{orgLabel}</th>
                <th scope="col" class="c-issue">Issue</th>
                <th scope="col" class="c-prio">Priority</th>
                <th scope="col" class="c-status">Status</th>
                <th scope="col" class="c-time">Created</th>
              </tr>
            </thead>
            <tbody>
              {loading && !data && [0, 1, 2, 3, 4, 5].map(() => (
                <tr class="skeleton-row">{[70, 110, 110, 220, 60, 70, 60].map((w) => <td><Skeleton w={w} /></td>)}</tr>
              ))}
              {data?.tickets.map((t) => (
                <tr class="row-link" onClick={(e) => { if (!(e.target as HTMLElement).closest('a')) navigate(`/admin/tickets/${t.number}`); }}>
                  <td class="c-num"><a class="mono num" href={`/admin/tickets/${t.number}`}>{t.number}</a></td>
                  <td class="c-cust"><span class="cell-title">{t.name}</span><span class="cell-sub">{formatPhone(t.phone)}</span></td>
                  <td class="c-org"><span class="cell-title">{t.orgName}</span></td>
                  <td class="c-issue">
                    <span class="cell-issue">
                      {t.category && <span class="tag">{t.category}</span>}
                      <span class="excerpt">{t.excerpt}</span>
                      {t.attachmentCount > 0 && <span class="clip" title={`${t.attachmentCount} attachment${t.attachmentCount > 1 ? 's' : ''}`}><Paperclip size={13} aria-hidden="true" /><span class="sr-only">{t.attachmentCount} attachments</span></span>}
                    </span>
                  </td>
                  <td class="c-prio"><PriorityMark priority={t.priority} /></td>
                  <td class="c-status"><StatusBadge status={t.status} /></td>
                  <td class="c-time" title={formatDateTime(t.createdAt)}>{relativeTime(t.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* Mobile cards */}
          <ul class="cards">
            {loading && !data && [0, 1, 2].map(() => <li class="card-item"><Skeleton w="50%" /><Skeleton w="90%" /></li>)}
            {data?.tickets.map((t) => (
              <li>
                <a class="card-item" href={`/admin/tickets/${t.number}`}>
                  <span class="card-top"><span class="mono num">{t.number}</span><StatusBadge status={t.status} /></span>
                  <span class="card-title">{t.orgName}</span>
                  <span class="card-sub">{t.excerpt}</span>
                  <span class="card-meta"><PriorityMark priority={t.priority} /><span>{t.name}</span><span>{relativeTime(t.createdAt)}</span></span>
                </a>
              </li>
            ))}
          </ul>

          {data && data.tickets.length === 0 && (
            filtered
              ? <Empty title="No tickets match" action={<button class="btn btn-secondary btn-sm" type="button" onClick={() => { setQ(''); navigate('/admin/tickets', true); }}>Clear filters</button>}>Try a different search or status.</Empty>
              : <Empty title="No tickets yet">Tickets raised from the support widget will appear here. <a href="/admin/widget">Install the widget</a></Empty>
          )}
        </div>
      )}

      {data && pages > 1 && (
        <nav class="pager" aria-label="Pagination">
          <span class="pager-info">Page {page} of {pages}</span>
          <button type="button" class="btn btn-secondary btn-sm" disabled={page <= 1} onClick={() => setParam({ page: String(page - 1) })}><ChevronLeft size={15} aria-hidden="true" />Previous</button>
          <button type="button" class="btn btn-secondary btn-sm" disabled={page >= pages} onClick={() => setParam({ page: String(page + 1) })}>Next<ChevronRight size={15} aria-hidden="true" /></button>
        </nav>
      )}
    </div>
  );
}
