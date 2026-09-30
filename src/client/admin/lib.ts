// Admin API client, tiny router and formatting helpers.

import { useCallback, useEffect, useRef, useState } from 'preact/hooks';

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public fields?: Record<string, string>) { super(message); }
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: opts.method ?? 'GET',
      credentials: 'same-origin',
      headers: {
        'x-requested-with': 'fetch',
        ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'network', 'Could not reach the server. Check your connection.');
  }
  if (res.status === 401 && !path.startsWith('/api/auth/')) {
    const next = currentUrl().pathname + currentUrl().search;
    navigate(`/admin/login?next=${encodeURIComponent(next)}`, true);
    throw new ApiError(401, 'unauthorized', 'Sign in required.');
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data?.error?.code ?? 'error', data?.error?.message ?? 'Something went wrong.', data?.error?.fields);
  return data as T;
}

export function useApi<T>(path: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(!!path);
  const seq = useRef(0);
  const load = useCallback(async (quiet = false) => {
    if (!path) return;
    const n = ++seq.current;
    if (!quiet) setLoading(true);
    try {
      const d = await api<T>(path);
      if (n === seq.current) { setData(d); setError(null); }
    } catch (e) {
      if (n === seq.current) setError(e as ApiError);
    } finally {
      if (n === seq.current) setLoading(false);
    }
  }, [path, ...deps]);
  useEffect(() => { load(); }, [load]);
  return { data, error, loading, reload: load, setData };
}

// ---------------------------------------------------------------------------
// Prototype hooks (only present in the offline prototype build)
// ---------------------------------------------------------------------------

interface PrototypeHooks { attachmentUrl(id: string, inline: boolean): string; embedUrl(key: string): string }
export const prototype: PrototypeHooks | undefined = (window as any).__SP_PROTOTYPE;
export const attachmentUrl = (id: string, inline = false) =>
  prototype ? prototype.attachmentUrl(id, inline) : `/api/admin/attachments/${id}${inline ? '?inline=1' : ''}`;

// ---------------------------------------------------------------------------
// Router (history API with /admin base; in-memory in the prototype)
// ---------------------------------------------------------------------------

const listeners = new Set<() => void>();
let memoryUrl = '/admin';
export function navigate(to: string, replace = false) {
  if (prototype) memoryUrl = to;
  else if (replace) history.replaceState(null, '', to);
  else history.pushState(null, '', to);
  listeners.forEach((l) => l());
  window.scrollTo(0, 0);
}
window.addEventListener('popstate', () => listeners.forEach((l) => l()));

function currentUrl() {
  if (prototype) return new URL(memoryUrl, 'http://x');
  return new URL(location.href);
}
export function currentSearch() { return currentUrl().search; }

export function useLocation() {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, []);
  const u = currentUrl();
  return { pathname: u.pathname.replace(/\/+$/, '') || '/', search: new URLSearchParams(u.search) };
}

/** Intercept clicks on internal links so navigation stays client-side. */
export function onLinkClick(e: MouseEvent) {
  const a = (e.target as HTMLElement).closest('a');
  if (!a || a.target === '_blank' || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
  const href = a.getAttribute('href');
  if (!href || !href.startsWith('/admin')) return;
  e.preventDefault();
  navigate(href);
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

let tz = 'UTC';
export function setTimezone(t: string) { tz = t; }

export function formatDateTime(iso: string | null | undefined) {
  if (!iso) return '';
  try {
    return new Intl.DateTimeFormat('en-IN', { timeZone: tz, day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
  } catch {
    return new Date(iso).toLocaleString();
  }
}

export function formatDate(iso: string) {
  try {
    return new Intl.DateTimeFormat('en-IN', { timeZone: tz, day: 'numeric', month: 'short' }).format(new Date(iso));
  } catch {
    return new Date(iso).toDateString();
  }
}

export function relativeTime(iso: string | null | undefined) {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 7 * 86400) return `${Math.round(s / 86400)} d ago`;
  return formatDate(iso);
}

export function formatDuration(seconds: number | null | undefined) {
  if (seconds == null) return null;
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))} min`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1).replace(/\.0$/, '')} h`;
  return `${(seconds / 86400).toFixed(1).replace(/\.0$/, '')} d`;
}

export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

export function useDebounced<T>(value: T, ms = 250) {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}
