import { render } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  AlertCircle, ArrowLeft, Check, ChevronRight, Copy, ExternalLink, FileText, Image as ImageIcon,
  Loader2, Mail, Paperclip, Phone, RotateCw, X,
} from 'lucide-preact';
import type { TenantConfig, ContactOption } from '../../shared/model.js';
import { formatPhone, normalizePhone } from '../../shared/constants.js';
import './styles.css';

// ---------------------------------------------------------------------------
// Boot data (rendered by the server into the page)
// ---------------------------------------------------------------------------

interface Boot {
  key: string;
  token: string;
  config: Pick<TenantConfig, 'brand' | 'theme' | 'copy' | 'contactOptions' | 'form' | 'poweredBy'> & { categories: string[] };
  limits: { maxBytes: number; maxFiles: number };
  countries: Array<{ code: string; dial: string; name: string }>;
}

const boot: Boot = JSON.parse(document.getElementById('sp-boot')!.textContent || '{}');
const cfg = boot.config;
const hostOrigin = (() => {
  const h = new URLSearchParams(location.search).get('host');
  return h && /^https?:\/\/[^/]+$/.test(h) ? h : '*';
})();

function toParent(msg: Record<string, unknown>) {
  if (window.parent !== window) window.parent.postMessage(msg, hostOrigin);
}

// ---------------------------------------------------------------------------
// Theme: tenant colours become CSS custom properties
// ---------------------------------------------------------------------------

function applyTheme() {
  const t = cfg.theme;
  const s = document.documentElement.style;
  const dark = t.mode === 'dark';
  s.setProperty('--accent', t.accent);
  s.setProperty('--accent-text', t.accentText);
  if (t.background) s.setProperty('--bg', t.background);
  if (t.surface) s.setProperty('--surface', t.surface);
  if (t.text) s.setProperty('--text', t.text);
  if (t.fontFamily) s.setProperty('--font', `"${t.fontFamily}", ${getComputedStyle(document.documentElement).getPropertyValue('--font-fallback')}`);
  document.documentElement.dataset.mode = dark ? 'dark' : 'light';
}
applyTheme();

// ---------------------------------------------------------------------------
// Local persistence (conveniences only; every access guarded)
// ---------------------------------------------------------------------------

const CONTACT_KEY = `sp:${boot.key}:contact`;
const DRAFT_KEY = `sp:${boot.key}:draft`;

function load<T>(store: 'local' | 'session', key: string): T | null {
  try {
    const raw = (store === 'local' ? localStorage : sessionStorage).getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}
function save(store: 'local' | 'session', key: string, value: unknown) {
  try {
    const s = store === 'local' ? localStorage : sessionStorage;
    if (value === null) s.removeItem(key);
    else s.setItem(key, JSON.stringify(value));
  } catch { /* storage unavailable: fine */ }
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public fields?: Record<string, string>) { super(message); }
}

const apiHeaders = () => ({ 'x-widget-key': boot.key, 'x-embed-token': boot.token });

async function createTicket(body: Record<string, unknown>): Promise<{ number: string }> {
  let res: Response;
  try {
    res = await fetch('/api/widget/tickets', {
      method: 'POST',
      headers: { ...apiHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'network', 'Check your connection and try again.');
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(res.status, data?.error?.code ?? 'error', data?.error?.message ?? 'Something went wrong. Please try again.', data?.error?.fields);
  }
  return data.ticket;
}

function uploadFile(file: Blob, name: string, onProgress: (p: number) => void): Promise<{ id: string; fileName: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/widget/uploads');
    for (const [k, v] of Object.entries(apiHeaders())) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      let data: any = null;
      try { data = JSON.parse(xhr.responseText); } catch { /* ignore */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new ApiError(xhr.status, data?.error?.code ?? 'error', data?.error?.message ?? "We couldn't upload this file."));
    };
    xhr.onerror = () => reject(new ApiError(0, 'network', "We couldn't upload this file. Check your connection."));
    const fd = new FormData();
    fd.append('file', file, name);
    xhr.send(fd);
  });
}

/** Large photos are downscaled in the browser so they fit the upload limit. */
async function prepareFile(file: File): Promise<{ blob: Blob; name: string } | { error: string }> {
  const limit = boot.limits.maxBytes;
  if (file.size <= limit) return { blob: file, name: file.name };
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) return { error: `Larger than ${Math.round(limit / 1048576)} MB` };
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 2560 / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const blob: Blob | null = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.85));
    if (!blob || blob.size > limit) return { error: `Larger than ${Math.round(limit / 1048576)} MB` };
    return { blob, name: file.name.replace(/\.[^.]+$/, '') + '.jpg' };
  } catch {
    return { error: `Larger than ${Math.round(limit / 1048576)} MB` };
  }
}

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

function Header(props: { title: string; onBack?: () => void }) {
  return (
    <header class="hd">
      {props.onBack ? (
        <button class="icon-btn" type="button" onClick={props.onBack} aria-label="Back">
          <ArrowLeft size={20} strokeWidth={1.75} />
        </button>
      ) : cfg.brand.logoUrl ? (
        <img class="logo" src={cfg.brand.logoUrl} alt="" width={28} height={28} />
      ) : null}
      <h1 class="hd-title">{props.title}</h1>
      <button class="icon-btn" type="button" onClick={() => toParent({ type: 'sp:close' })} aria-label="Close support">
        <X size={20} strokeWidth={1.75} />
      </button>
    </header>
  );
}

function contactHref(o: ContactOption) {
  if (o.type === 'email') return `mailto:${o.value}`;
  if (o.type === 'phone') return `tel:${o.value.replace(/[^\d+]/g, '')}`;
  return /^https:\/\//.test(o.value) ? o.value : '#';
}

function ContactIcon({ type }: { type: ContactOption['type'] }) {
  const p = { size: 18, strokeWidth: 1.75, 'aria-hidden': true } as const;
  if (type === 'email') return <Mail {...p} />;
  if (type === 'phone') return <Phone {...p} />;
  return <ExternalLink {...p} />;
}

function displayValue(o: ContactOption) {
  if (o.type === 'phone' && o.value.startsWith('+')) return formatPhone(o.value.replace(/[^\d+]/g, ''));
  if (o.type === 'link') return o.value.replace(/^https:\/\//, '').replace(/\/$/, '');
  return o.value;
}

function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------

function Home({ onRaise }: { onRaise: () => void }) {
  const c = cfg.copy;
  return (
    <div class="screen">
      <Header title={c.title} />
      <main class="body" id="main">
        <h2 class="h2" tabIndex={-1} data-autofocus>{c.heading}</h2>
        <p class="lede">{c.description}</p>
        {cfg.contactOptions.length > 0 && (
          <ul class="contacts" aria-label="Contact options">
            {cfg.contactOptions.map((o) => (
              <li>
                <a class="contact" href={contactHref(o)} target={o.type === 'link' ? '_blank' : '_top'} rel="noopener noreferrer">
                  <span class="contact-icon"><ContactIcon type={o.type} /></span>
                  <span class="contact-text">
                    <span class="contact-label">{o.label}</span>
                    <span class="contact-value">{displayValue(o)}</span>
                    {o.description && <span class="contact-desc">{o.description}</span>}
                  </span>
                </a>
              </li>
            ))}
          </ul>
        )}
      </main>
      <footer class="ft">
        <button class="cta" type="button" onClick={onRaise}>
          <span class="cta-text">
            <span class="cta-title">{c.ticketCta}</span>
            <span class="cta-desc">{c.ticketCtaDescription}</span>
          </span>
          <ChevronRight size={20} strokeWidth={2} aria-hidden="true" />
        </button>
        {cfg.poweredBy && <p class="powered">Support by {cfg.brand.name}</p>}
      </footer>
    </div>
  );
}

interface Attachment {
  localId: string;
  name: string;
  size: number;
  isImage: boolean;
  status: 'uploading' | 'done' | 'error';
  progress: number;
  id?: string;
  error?: string;
  retryable?: boolean;
  blob?: Blob;
}

interface Draft { name: string; country: string; phone: string; orgName: string; description: string; category: string; email: string }

function TicketForm({ onBack, onDone }: { onBack: () => void; onDone: (n: string, phone: string) => void }) {
  const contact = load<Partial<Draft>>('local', CONTACT_KEY) ?? {};
  const draft = load<Partial<Draft>>('session', DRAFT_KEY) ?? {};
  const [v, setV] = useState<Draft>({
    name: draft.name ?? contact.name ?? '',
    country: draft.country ?? contact.country ?? cfg.form.defaultCountry,
    phone: draft.phone ?? contact.phone ?? '',
    orgName: draft.orgName ?? contact.orgName ?? '',
    description: draft.description ?? '',
    category: draft.category ?? '',
    email: '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [files, setFiles] = useState<Attachment[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [banner, setBanner] = useState<{ message: string; reload?: boolean } | null>(null);
  const openedAt = useRef(Date.now());
  const fileInput = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const honeypot = useRef<HTMLInputElement>(null);

  useEffect(() => { save('session', DRAFT_KEY, { ...v, email: undefined }); }, [v]);

  const set = (k: keyof Draft) => (e: Event) => {
    const value = (e.target as HTMLInputElement).value;
    setV((p) => ({ ...p, [k]: value }));
    if (errors[k]) setErrors((p) => { const n = { ...p }; delete n[k]; return n; });
  };

  function validate(): Record<string, string> {
    const e: Record<string, string> = {};
    if (v.name.trim().length < 2) e.name = 'Enter your name';
    if (!v.phone.trim()) e.phone = 'Enter your phone number';
    else if (!normalizePhone(v.country, v.phone)) e.phone = 'Enter a valid phone number';
    if (v.orgName.trim().length < 2) e.orgName = `Enter your ${cfg.form.orgLabel.toLowerCase()}`;
    if (v.description.trim().length < 10) e.description = 'Please add a little more detail (at least 10 characters)';
    else if (v.description.length > 5000) e.description = 'Please keep this under 5,000 characters';
    return e;
  }

  async function startUpload(a: Attachment) {
    const update = (patch: Partial<Attachment>) => setFiles((fs) => fs.map((f) => (f.localId === a.localId ? { ...f, ...patch } : f)));
    update({ status: 'uploading', progress: 0, error: undefined });
    try {
      const r = await uploadFile(a.blob!, a.name, (p) => update({ progress: p }));
      update({ status: 'done', id: r.id, progress: 1, name: r.fileName });
    } catch (err) {
      const retryable = !(err instanceof ApiError) || err.status === 0 || err.status >= 500 || err.status === 429;
      update({ status: 'error', retryable, error: err instanceof ApiError ? err.message : "We couldn't upload this file." });
    }
  }

  async function onPick(e: Event) {
    const input = e.target as HTMLInputElement;
    const picked = Array.from(input.files ?? []);
    input.value = '';
    const room = boot.limits.maxFiles - files.length;
    if (picked.length > room) setBanner({ message: `You can attach up to ${boot.limits.maxFiles} files.` });
    for (const file of picked.slice(0, Math.max(0, room))) {
      const localId = Math.random().toString(36).slice(2);
      const base: Attachment = { localId, name: file.name, size: file.size, isImage: file.type.startsWith('image/'), status: 'uploading', progress: 0 };
      const prepared = await prepareFile(file);
      if ('error' in prepared) {
        setFiles((fs) => [...fs, { ...base, status: 'error', error: prepared.error }]);
        continue;
      }
      const a = { ...base, name: prepared.name, size: prepared.blob.size, blob: prepared.blob };
      setFiles((fs) => [...fs, a]);
      startUpload(a);
    }
  }

  async function submit(e: Event) {
    e.preventDefault();
    if (submitting) return;
    setBanner(null);
    const errs = validate();
    setErrors(errs);
    if (Object.keys(errs).length) {
      const first = formRef.current?.querySelector<HTMLElement>(`[name="${Object.keys(errs)[0]}"]`);
      first?.focus();
      return;
    }
    if (files.some((f) => f.status === 'uploading')) {
      setBanner({ message: 'Wait for attachments to finish uploading.' });
      return;
    }
    if (files.some((f) => f.status === 'error')) {
      setBanner({ message: 'Remove or retry the attachment that failed to upload.' });
      return;
    }
    setSubmitting(true);
    try {
      const t = await createTicket({
        name: v.name,
        country: v.country,
        phone: v.phone,
        orgName: v.orgName,
        description: v.description,
        category: v.category || undefined,
        attachmentIds: files.filter((f) => f.id).map((f) => f.id),
        website: honeypot.current?.value ?? '',
        elapsed: Math.round((Date.now() - openedAt.current) / 1000),
        pageUrl: document.referrer || undefined,
      });
      save('local', CONTACT_KEY, { name: v.name, country: v.country, phone: v.phone, orgName: v.orgName });
      save('session', DRAFT_KEY, null);
      onDone(t.number, normalizePhone(v.country, v.phone) ?? v.phone);
    } catch (err) {
      const a = err instanceof ApiError ? err : new ApiError(0, 'error', 'Something went wrong. Please try again.');
      if (a.fields) setErrors(a.fields);
      if (a.code === 'session_expired') setBanner({ message: 'Your session expired. Reload to continue. Your information will be kept.', reload: true });
      else if (a.code === 'network') setBanner({ message: "We couldn't submit your ticket. Check your connection and try again. Your information hasn't been lost." });
      else if (a.status >= 500) setBanner({ message: "We couldn't submit your ticket. Please try again. Your information hasn't been lost." });
      else setBanner({ message: a.message });
    } finally {
      setSubmitting(false);
    }
  }

  const f = cfg.form;
  const descLeft = 5000 - v.description.length;
  const country = boot.countries.find((c) => c.code === v.country);

  return (
    <div class="screen">
      <Header title={cfg.copy.formHeading} onBack={onBack} />
      <form class="body form" onSubmit={submit} noValidate ref={formRef} aria-describedby="form-desc">
        <p class="lede" id="form-desc" tabIndex={-1} data-autofocus>{cfg.copy.formDescription}</p>

        {banner && (
          <div class="banner" role="alert">
            <AlertCircle size={18} strokeWidth={1.75} aria-hidden="true" />
            <div>
              <p>{banner.message}</p>
              {banner.reload && <button type="button" class="link-btn" onClick={() => location.reload()}>Reload</button>}
            </div>
          </div>
        )}

        <Field id="name" label="Name" error={errors.name}>
          <input id="name" name="name" type="text" autoComplete="name" value={v.name} onInput={set('name')} maxLength={100}
            aria-invalid={!!errors.name} aria-describedby={errors.name ? 'name-err' : undefined} disabled={submitting} />
        </Field>

        <Field id="phone" label="Phone number" error={errors.phone}>
          <div class={`phone ${errors.phone ? 'invalid' : ''}`}>
            <label class="sr-only" for="country">Country code</label>
            <div class="country">
              <select id="country" name="country" value={v.country} onChange={set('country')} disabled={submitting} autoComplete="tel-country-code">
                {boot.countries.map((c) => <option value={c.code}>{c.name} (+{c.dial})</option>)}
              </select>
              <span class="country-face" aria-hidden="true">+{country?.dial}</span>
            </div>
            <input id="phone" name="phone" type="tel" inputMode="tel" autoComplete="tel-national" value={v.phone} onInput={set('phone')}
              maxLength={24} placeholder={v.country === 'IN' ? '98765 43210' : ''}
              aria-invalid={!!errors.phone} aria-describedby={errors.phone ? 'phone-err' : undefined} disabled={submitting} />
          </div>
        </Field>

        <Field id="orgName" label={f.orgLabel} error={errors.orgName}>
          <input id="orgName" name="orgName" type="text" autoComplete="organization" value={v.orgName} onInput={set('orgName')} maxLength={120}
            placeholder={f.orgPlaceholder} aria-invalid={!!errors.orgName} aria-describedby={errors.orgName ? 'orgName-err' : undefined} disabled={submitting} />
        </Field>

        {cfg.categories.length > 0 && (
          <Field id="category" label="Topic" optional>
            <select id="category" name="category" value={v.category} onChange={set('category')} disabled={submitting}>
              <option value="">Choose a topic</option>
              {cfg.categories.map((c) => <option value={c}>{c}</option>)}
            </select>
          </Field>
        )}

        <Field id="description" label={f.descriptionLabel} error={errors.description}
          hint={descLeft < 500 ? `${descLeft.toLocaleString()} characters left` : undefined}>
          <textarea id="description" name="description" rows={5} value={v.description} onInput={set('description')} maxLength={5000}
            placeholder={f.descriptionPlaceholder} aria-invalid={!!errors.description}
            aria-describedby={errors.description ? 'description-err' : undefined} disabled={submitting} />
        </Field>

        {f.allowAttachments && (
          <div class="field">
            <span class="label" id="att-label">Attachments <span class="optional">Optional</span></span>
            {files.length > 0 && (
              <ul class="files" aria-labelledby="att-label">
                {files.map((a) => (
                  <li class={`file ${a.status}`}>
                    <span class="file-icon">{a.isImage ? <ImageIcon size={18} strokeWidth={1.75} /> : <FileText size={18} strokeWidth={1.75} />}</span>
                    <span class="file-text">
                      <span class="file-name">{a.name}</span>
                      <span class="file-meta">
                        {a.status === 'uploading' && `Uploading… ${Math.round(a.progress * 100)}%`}
                        {a.status === 'done' && formatBytes(a.size)}
                        {a.status === 'error' && a.error}
                      </span>
                      {a.status === 'uploading' && <span class="bar" role="progressbar" aria-valuenow={Math.round(a.progress * 100)} aria-valuemin={0} aria-valuemax={100} aria-label={`Uploading ${a.name}`}><span style={{ width: `${Math.max(4, a.progress * 100)}%` }} /></span>}
                    </span>
                    {a.status === 'error' && a.retryable && a.blob && (
                      <button type="button" class="icon-btn sm" onClick={() => startUpload(a)} aria-label={`Retry ${a.name}`} disabled={submitting}>
                        <RotateCw size={16} strokeWidth={1.75} />
                      </button>
                    )}
                    <button type="button" class="icon-btn sm" onClick={() => setFiles((fs) => fs.filter((x) => x.localId !== a.localId))} aria-label={`Remove ${a.name}`} disabled={submitting}>
                      <X size={16} strokeWidth={1.75} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {files.length < boot.limits.maxFiles && (
              <button type="button" class="attach" onClick={() => fileInput.current?.click()} disabled={submitting}>
                <Paperclip size={16} strokeWidth={1.75} aria-hidden="true" />
                Add attachment
              </button>
            )}
            <span class="hint">Screenshots, photos or PDFs, up to {Math.round(boot.limits.maxBytes / 1048576)} MB each</span>
            <input ref={fileInput} type="file" multiple hidden accept="image/png,image/jpeg,image/webp,image/gif,application/pdf,.txt,.csv,.docx,.xlsx" onChange={onPick} />
          </div>
        )}

        {/* Honeypot: invisible to people and to assistive technology */}
        <div class="hp" aria-hidden="true">
          <label>Website <input ref={honeypot} type="text" name="website" tabIndex={-1} autoComplete="off" /></label>
        </div>
      </form>
      <footer class="ft">
        <button class="btn-primary" type="button" onClick={(e) => submit(e)} disabled={submitting} aria-busy={submitting}>
          {submitting ? <><Loader2 class="spin" size={18} strokeWidth={2} aria-hidden="true" /> Submitting…</> : 'Submit ticket'}
        </button>
      </footer>
    </div>
  );
}

function Field(props: { id: string; label: string; error?: string; hint?: string; optional?: boolean; children: preact.ComponentChildren }) {
  return (
    <div class={`field ${props.error ? 'has-error' : ''}`}>
      <label class="label" for={props.id}>
        {props.label} {props.optional && <span class="optional">Optional</span>}
      </label>
      {props.children}
      {props.error ? (
        <span class="error" id={`${props.id}-err`}><AlertCircle size={14} strokeWidth={2} aria-hidden="true" />{props.error}</span>
      ) : props.hint ? <span class="hint">{props.hint}</span> : null}
    </div>
  );
}

function Success({ number, phone, onAnother }: { number: string; phone: string; onAnother: () => void }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(number);
    } catch {
      const r = document.createRange();
      const el = document.getElementById('ticket-number');
      if (el) { r.selectNodeContents(el); getSelection()?.removeAllRanges(); getSelection()?.addRange(r); document.execCommand('copy'); }
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }
  return (
    <div class="screen">
      <Header title={cfg.copy.title} />
      <main class="body success">
        <span class="success-mark" aria-hidden="true"><Check size={22} strokeWidth={2.25} /></span>
        <h2 class="h2" tabIndex={-1} data-autofocus>{cfg.copy.successHeading}</h2>
        <p class="lede">{cfg.copy.successMessage}</p>
        <div class="ticket-id">
          <span class="ticket-id-label" id="ticket-id-label">Ticket ID</span>
          <div class="ticket-id-row">
            <span class="ticket-id-value" id="ticket-number" aria-labelledby="ticket-id-label">{number}</span>
            <button type="button" class="copy" onClick={copy} aria-label={copied ? 'Copied' : 'Copy ticket ID'}>
              {copied ? <Check size={16} strokeWidth={2} /> : <Copy size={16} strokeWidth={1.75} />}
              <span>{copied ? 'Copied' : 'Copy'}</span>
            </button>
          </div>
        </div>
        <p class="note">Keep this ID for reference. We'll contact you on <span class="nowrap">{formatPhone(phone)}</span>.</p>
        <p class="sr-only" role="status">Ticket submitted. Your ticket ID is {number}.</p>
      </main>
      <footer class="ft ft-split">
        <button class="btn-secondary" type="button" onClick={onAnother}>Raise another ticket</button>
        <button class="btn-primary" type="button" onClick={() => toParent({ type: 'sp:close' })}>Close</button>
      </footer>
    </div>
  );
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

type View = { name: 'home' } | { name: 'form' } | { name: 'success'; number: string; phone: string };

function App() {
  const hasDraft = useMemo(() => !!load<Draft>('session', DRAFT_KEY)?.description, []);
  const [view, setView] = useState<View>(hasDraft ? { name: 'form' } : { name: 'home' });
  const root = useRef<HTMLDivElement>(null);

  // Move focus to the screen's heading whenever the screen changes (screen-reader friendly).
  useEffect(() => {
    const el = root.current?.querySelector<HTMLElement>('[data-autofocus]');
    el?.focus({ preventScroll: true });
    root.current?.querySelector('.body')?.scrollTo?.(0, 0);
  }, [view.name]);

  useEffect(() => {
    toParent({ type: 'sp:ready' });
    const onMsg = (e: MessageEvent) => {
      if (e.source !== window.parent) return;
      if (e.data?.type === 'sp:open') root.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus({ preventScroll: true });
    };
    // Keep keyboard focus inside the panel; Escape closes it.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        toParent({ type: 'sp:close' });
        return;
      }
      if (e.key !== 'Tab' || !root.current) return;
      const items = Array.from(root.current.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),input:not([disabled]):not([type=hidden]):not([tabindex="-1"]),select:not([disabled]),textarea:not([disabled])'))
        .filter((el) => el.offsetParent !== null);
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && (document.activeElement === first || !root.current.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    window.addEventListener('message', onMsg);
    document.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('message', onMsg); document.removeEventListener('keydown', onKey); };
  }, []);

  return (
    <div class="app" ref={root}>
      {view.name === 'home' && <Home onRaise={() => setView({ name: 'form' })} />}
      {view.name === 'form' && <TicketForm onBack={() => setView({ name: 'home' })} onDone={(number, phone) => setView({ name: 'success', number, phone })} />}
      {view.name === 'success' && <Success number={view.number} phone={view.phone} onAnother={() => setView({ name: 'form' })} />}
    </div>
  );
}

render(<App />, document.getElementById('app')!);
