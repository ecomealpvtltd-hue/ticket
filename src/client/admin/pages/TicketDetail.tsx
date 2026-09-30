import { useState } from 'preact/hooks';
import { ArrowLeft, Download, FileText, Phone, Sparkles, RotateCw, ExternalLink, Copy as CopyIcon, Link2 } from 'lucide-preact';
import { api, formatBytes, formatDateTime, relativeTime, useApi, type ApiError } from '../lib.js';
import { Button, ErrorState, Notice, PriorityMark, Skeleton, StatusBadge, useToast } from '../ui.js';
import { PRIORITIES, PRIORITY_LABEL, STATUSES, STATUS_LABEL, formatPhone, type TicketPriority, type TicketStatus } from '../../../shared/constants.js';
import { can, useMe } from '../main.js';

interface Detail {
  id: string; number: string; status: TicketStatus; priority: TicketPriority; category: string | null; description: string;
  customer: { id: string; name: string; phone: string; email: string | null; orgName: string; ticketCount: number };
  ai: { status: string; category: string | null; priority: TicketPriority | null; summary: string | null; reason: string | null };
  duplicateOf: string | null;
  meta: { pageUrl?: string | null; driveFolderUrl?: string };
  createdAt: string; updatedAt: string; resolvedAt: string | null;
  attachments: Array<{ id: string; fileName: string; mimeType: string; size: number; driveUrl: string | null }>;
  events: Array<{ id: string; actorType: string; actorLabel: string | null; type: string; data: any; createdAt: string }>;
  sync: Record<string, { id: string; status: string; attempts: number; lastError: string | null; updatedAt: string } | undefined>;
}

export function TicketDetail({ ticketRef }: { ticketRef: string }) {
  const { me } = useMe();
  const toast = useToast();
  const { data: t, error, loading, reload, setData } = useApi<Detail>(`/api/admin/tickets/${encodeURIComponent(ticketRef)}`);
  const [saving, setSaving] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [noteBusy, setNoteBusy] = useState(false);
  const canEdit = can(me, 'agent');
  const orgLabel = me.tenant.config.form.orgLabel;

  async function patch(field: 'status' | 'priority' | 'category', value: string | null) {
    if (!t) return;
    setSaving(field);
    try {
      const updated = await api<Detail>(`/api/admin/tickets/${t.id}`, { method: 'PATCH', body: { [field]: value } });
      setData(updated);
      const label = field === 'status' ? STATUS_LABEL[value as TicketStatus] : field === 'priority' ? PRIORITY_LABEL[value as TicketPriority] : value ?? 'None';
      toast('success', `${field[0].toUpperCase() + field.slice(1)} changed to ${label}.`);
    } catch (e) {
      toast('error', (e as ApiError).message);
    } finally {
      setSaving(null);
    }
  }

  async function addNote(e: Event) {
    e.preventDefault();
    if (!t || !note.trim()) return;
    setNoteBusy(true);
    try {
      const updated = await api<Detail>(`/api/admin/tickets/${t.id}/notes`, { method: 'POST', body: { body: note } });
      setData(updated);
      setNote('');
      toast('success', 'Note added.');
    } catch (err) {
      toast('error', (err as ApiError).message);
    } finally {
      setNoteBusy(false);
    }
  }

  async function retry(jobId: string) {
    try {
      await api(`/api/admin/jobs/${jobId}/retry`, { method: 'POST' });
      await reload(true);
      toast('success', 'Sync retried.');
    } catch (e) {
      toast('error', (e as ApiError).message);
    }
  }

  const back = <a class="back" href="/admin/tickets"><ArrowLeft size={15} strokeWidth={1.75} aria-hidden="true" />Tickets</a>;

  if (error) return <div class="page">{back}<ErrorState message={error.status === 404 ? 'This ticket does not exist in your workspace.' : error.message} onRetry={error.status === 404 ? undefined : () => reload()} /></div>;
  if (loading || !t) {
    return (
      <div class="page page-wide">{back}
        <div class="detail-hd"><Skeleton w={160} h={30} /></div>
        <div class="detail"><div class="detail-main"><Skeleton h={140} /></div><div class="detail-side"><Skeleton h={200} /></div></div>
      </div>
    );
  }

  const aiUseful = t.ai.status === 'done' && t.ai.priority && t.ai.priority !== t.priority;
  const images = t.attachments.filter((a) => a.mimeType.startsWith('image/'));
  const files = t.attachments.filter((a) => !a.mimeType.startsWith('image/'));

  return (
    <div class="page page-wide">
      {back}
      <header class="detail-hd">
        <div class="detail-title-row">
          <h1 class="page-title mono">{t.number}</h1>
          <StatusBadge status={t.status} />
          <PriorityMark priority={t.priority} />
        </div>
        <p class="page-desc">{t.customer.orgName}, raised {relativeTime(t.createdAt)} by {t.customer.name}</p>
      </header>

      <div class="detail">
        <div class="detail-main">
          {t.duplicateOf && (
            <div class="p-notice"><Notice tone="info" action={<a class="notice-link" href={`/admin/tickets/${t.duplicateOf}`}>Open {t.duplicateOf}</a>}>
              Possible duplicate: the same phone number has another open ticket from the last 24 hours.
            </Notice></div>
          )}

          <section class="panel p-issue">
            <h2 class="panel-title">Issue</h2>
            <p class="issue-text">{t.description}</p>
            {t.ai.status === 'done' && t.ai.summary && (
              <div class="ai">
                <Sparkles size={15} strokeWidth={1.75} aria-hidden="true" />
                <div class="ai-body">
                  <p class="ai-summary">{t.ai.summary}</p>
                  <p class="ai-meta">
                    Suggested: {t.ai.category}{t.ai.priority && <>, {PRIORITY_LABEL[t.ai.priority]} priority</>}
                    {t.ai.reason && <> — {t.ai.reason}</>}
                  </p>
                  {aiUseful && canEdit && (
                    <Button size="sm" onClick={() => patch('priority', t.ai.priority!)} loading={saving === 'priority'}>
                      Set priority to {PRIORITY_LABEL[t.ai.priority!]}
                    </Button>
                  )}
                </div>
              </div>
            )}
            {t.ai.status === 'pending' && <p class="ai-pending"><Sparkles size={14} aria-hidden="true" /> Summarising…</p>}
          </section>

          {t.attachments.length > 0 && (
            <section class="panel p-attach">
              <h2 class="panel-title">Attachments <span class="count">{t.attachments.length}</span></h2>
              {images.length > 0 && (
                <div class="thumbs">
                  {images.map((a) => (
                    <div class="thumb">
                      <a href={`/api/admin/attachments/${a.id}?inline=1`} target="_blank" rel="noopener" title={`Open ${a.fileName}`}>
                        <img src={`/api/admin/attachments/${a.id}?inline=1`} alt={a.fileName} loading="lazy" />
                      </a>
                      <div class="thumb-bar">
                        <span class="thumb-name">{a.fileName}</span>
                        {a.driveUrl && <a class="icon-link" href={a.driveUrl} target="_blank" rel="noopener noreferrer" aria-label={`Open ${a.fileName} in Google Drive`}><ExternalLink size={14} /></a>}
                        <a class="icon-link" href={`/api/admin/attachments/${a.id}`} aria-label={`Download ${a.fileName}`}><Download size={14} /></a>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {files.length > 0 && <ul class="files-list">
                {files.map((a) => (
                  <li>
                    <FileText size={16} strokeWidth={1.75} aria-hidden="true" />
                    <span class="file-name">{a.fileName}</span>
                    <span class="file-size">{formatBytes(a.size)}</span>
                    {a.driveUrl && <a class="icon-link" href={a.driveUrl} target="_blank" rel="noopener noreferrer" title="Open in Google Drive" aria-label={`Open ${a.fileName} in Google Drive`}><ExternalLink size={15} /></a>}
                    <a class="icon-link" href={`/api/admin/attachments/${a.id}`} title="Download" aria-label={`Download ${a.fileName}`}><Download size={15} /></a>
                  </li>
                ))}
              </ul>}
            </section>
          )}

          <section class="panel p-timeline">
            <h2 class="panel-title">Timeline</h2>
            <ol class="timeline">
              {t.events.map((e) => <TimelineItem e={e} />)}
            </ol>
            {canEdit && (
              <form class="note-form" onSubmit={addNote}>
                <label class="field-label" for="note">Internal note</label>
                <textarea id="note" class="input" rows={3} maxLength={4000} placeholder="Visible to your team only" value={note}
                  onInput={(e) => setNote((e.target as HTMLTextAreaElement).value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) addNote(e); }} />
                <div class="note-actions">
                  <span class="hint">Ctrl + Enter to add</span>
                  <Button type="submit" variant="primary" size="sm" loading={noteBusy} disabled={!note.trim()}>Add note</Button>
                </div>
              </form>
            )}
          </section>
        </div>

        <aside class="detail-side">
          <section class="panel p-controls">
            <div class="field">
              <label class="field-label" for="status">Status</label>
              <select id="status" class="input" value={t.status} disabled={!canEdit || saving === 'status'} onChange={(e) => patch('status', (e.target as HTMLSelectElement).value)}>
                {STATUSES.map((s) => <option value={s}>{STATUS_LABEL[s]}</option>)}
              </select>
            </div>
            <div class="field">
              <label class="field-label" for="priority">Priority</label>
              <select id="priority" class="input" value={t.priority} disabled={!canEdit || saving === 'priority'} onChange={(e) => patch('priority', (e.target as HTMLSelectElement).value)}>
                {PRIORITIES.map((p) => <option value={p}>{PRIORITY_LABEL[p]}</option>)}
              </select>
            </div>
            <div class="field">
              <label class="field-label" for="category">Category</label>
              <select id="category" class="input" value={t.category ?? ''} disabled={!canEdit || saving === 'category'} onChange={(e) => patch('category', (e.target as HTMLSelectElement).value || null)}>
                <option value="">None</option>
                {me.tenant.config.categories.map((c) => <option value={c}>{c}</option>)}
              </select>
            </div>
          </section>

          <section class="panel p-customer">
            <h2 class="panel-title">Customer</h2>
            <dl class="props">
              <dt>Name</dt><dd>{t.customer.name}</dd>
              <dt>Phone</dt>
              <dd class="with-action">
                <a href={`tel:${t.customer.phone}`}><Phone size={13} aria-hidden="true" /> {formatPhone(t.customer.phone)}</a>
                <button type="button" class="icon-btn xs" aria-label="Copy phone number" onClick={() => { navigator.clipboard?.writeText(t.customer.phone); toast('success', 'Phone number copied.'); }}><CopyIcon size={13} /></button>
              </dd>
              {t.customer.email && <><dt>Email</dt><dd><a href={`mailto:${t.customer.email}`}>{t.customer.email}</a></dd></>}
              <dt>{orgLabel}</dt><dd>{t.customer.orgName}</dd>
              <dt>History</dt>
              <dd>{t.customer.ticketCount === 1 ? 'First ticket' : <a href={`/admin/tickets?q=${encodeURIComponent(t.customer.phone.slice(-10))}`}>{t.customer.ticketCount} tickets</a>}</dd>
            </dl>
          </section>

          <section class="panel p-details">
            <h2 class="panel-title">Details</h2>
            <dl class="props">
              <dt>Created</dt><dd>{formatDateTime(t.createdAt)}</dd>
              <dt>Updated</dt><dd>{formatDateTime(t.updatedAt)}</dd>
              {t.resolvedAt && <><dt>Resolved</dt><dd>{formatDateTime(t.resolvedAt)}</dd></>}
              {t.meta.pageUrl && <><dt>Raised from</dt><dd class="truncate" title={t.meta.pageUrl}><Link2 size={13} aria-hidden="true" /> {t.meta.pageUrl.replace(/^https?:\/\//, '')}</dd></>}
            </dl>
          </section>

          <section class="panel p-sync">
            <h2 class="panel-title">Sync</h2>
            <ul class="sync">
              <SyncRow label="Google Sheet" job={t.sync.sheet_sync} onRetry={retry} canRetry={canEdit} />
              {t.attachments.length > 0 && <SyncRow label="Google Drive" job={t.sync.drive_upload} onRetry={retry} canRetry={canEdit} extra={t.meta.driveFolderUrl ? <a class="icon-link" href={t.meta.driveFolderUrl} target="_blank" rel="noopener noreferrer" aria-label="Open Drive folder"><ExternalLink size={14} /></a> : null} />}
            </ul>
          </section>
        </aside>
      </div>
    </div>
  );
}

function SyncRow({ label, job, onRetry, canRetry, extra }: { label: string; job?: Detail['sync'][string]; onRetry: (id: string) => void; canRetry: boolean; extra?: any }) {
  const state = !job ? { text: 'Not queued', tone: 'muted' }
    : job.status === 'done' ? { text: 'Synced', tone: 'ok' }
    : job.status === 'failed' ? { text: 'Failed', tone: 'bad' }
    : job.status === 'blocked' ? { text: 'Waiting for Google', tone: 'muted' }
    : { text: job.attempts > 0 ? `Retrying (attempt ${job.attempts})` : 'Pending', tone: 'warn' };
  return (
    <li class="sync-row">
      <span class="sync-label">{label}</span>
      <span class={`sync-state tone-${state.tone}`} title={job?.lastError ?? undefined}>{state.text}</span>
      {extra}
      {job && (job.status === 'failed') && canRetry && (
        <button type="button" class="icon-btn xs" aria-label={`Retry ${label} sync`} title="Retry now" onClick={() => onRetry(job.id)}><RotateCw size={13} /></button>
      )}
    </li>
  );
}

function TimelineItem({ e }: { e: Detail['events'][number] }) {
  const who = e.actorLabel ?? (e.actorType === 'system' ? 'System' : e.actorType === 'ai' ? 'AI' : 'Someone');
  let text: any;
  switch (e.type) {
    case 'created': text = <><b>{who}</b> raised this ticket{e.data?.attachments ? ` with ${e.data.attachments} attachment${e.data.attachments > 1 ? 's' : ''}` : ''}</>; break;
    case 'status_changed': text = <><b>{who}</b> changed status from {STATUS_LABEL[e.data.from as TicketStatus]} to <b>{STATUS_LABEL[e.data.to as TicketStatus]}</b></>; break;
    case 'priority_changed': text = <><b>{who}</b> changed priority from {PRIORITY_LABEL[e.data.from as TicketPriority]} to <b>{PRIORITY_LABEL[e.data.to as TicketPriority]}</b></>; break;
    case 'category_changed': text = <><b>{who}</b> set category to <b>{e.data.to ?? 'None'}</b></>; break;
    case 'ai_triage': text = <>AI suggested <b>{e.data.category}</b>, {PRIORITY_LABEL[e.data.priority as TicketPriority]} priority</>; break;
    case 'possible_duplicate': text = <>Flagged as a possible duplicate of <a href={`/admin/tickets/${e.data.of}`}>{e.data.of}</a></>; break;
    case 'note': text = <><b>{who}</b> added a note</>; break;
    default: text = <>{who}: {e.type.replace(/_/g, ' ')}</>;
  }
  return (
    <li class={`tl tl-type-${e.type}`}>
      <span class="tl-dot" aria-hidden="true" />
      <div class="tl-body">
        <p class="tl-text">{text}</p>
        {e.type === 'note' && <p class="tl-note">{e.data.body}</p>}
        <time class="tl-time" dateTime={e.createdAt} title={formatDateTime(e.createdAt)}>{formatDateTime(e.createdAt)}</time>
      </div>
    </li>
  );
}
