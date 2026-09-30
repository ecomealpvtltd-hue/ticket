// Minimal HTTP toolkit on top of the standard Request/Response API
// (the same API Netlify Functions v2 and Node 22 expose).

import { ZodError } from 'zod';
import { log, errorMessage } from './log.js';

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, details?: unknown) => new HttpError(400, 'bad_request', message, details);
export const unauthorized = (message = 'Sign in required.') => new HttpError(401, 'unauthorized', message);
export const forbidden = (message = 'You do not have access to this.') => new HttpError(403, 'forbidden', message);
export const notFound = (message = 'Not found.') => new HttpError(404, 'not_found', message);

export function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  const h = new Headers(headers);
  if (!h.has('content-type')) h.set('content-type', 'application/json; charset=utf-8');
  if (!h.has('cache-control')) h.set('cache-control', 'no-store');
  h.set('x-content-type-options', 'nosniff');
  return new Response(JSON.stringify(data), { status, headers: h });
}

export function errorResponse(err: unknown, headers: Record<string, string> = {}): Response {
  if (err instanceof HttpError) {
    const extra = err.details && typeof err.details === 'object' ? (err.details as Record<string, unknown>) : {};
    return json({ error: { code: err.code, message: err.message, ...extra } }, err.status, headers);
  }
  if (err instanceof ZodError) {
    const fields: Record<string, string> = {};
    for (const issue of err.issues) {
      const key = issue.path.join('.') || '_';
      if (!fields[key]) fields[key] = issue.message;
    }
    return json({ error: { code: 'validation_failed', message: 'Please check the highlighted fields.', fields } }, 422, headers);
  }
  log.error('http.unhandled', { message: errorMessage(err) });
  return json({ error: { code: 'internal', message: 'Something went wrong. Please try again.' } }, 500, headers);
}

export async function readJson(req: Request, maxBytes = 64 * 1024): Promise<unknown> {
  const len = Number(req.headers.get('content-length') ?? '0');
  if (len > maxBytes) throw new HttpError(413, 'payload_too_large', 'Request is too large.');
  const text = await req.text();
  if (text.length > maxBytes) throw new HttpError(413, 'payload_too_large', 'Request is too large.');
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw badRequest('Malformed JSON.');
  }
}

/**
 * True when a browser request comes from our own origin. Browsers do not always send Origin
 * on same-origin requests, so Sec-Fetch-Site (which page scripts cannot forge) is the fallback.
 * Requests with neither header are non-browser clients; they get no ambient cookies from a
 * victim's browser, so CSRF does not apply and other checks (tokens, sessions) still hold.
 */
export function isSameOriginRequest(req: Request, baseUrl: string): boolean {
  const origin = req.headers.get('origin');
  if (origin && origin !== 'null') return origin === new URL(baseUrl).origin;
  if (origin === 'null') return false;
  const site = req.headers.get('sec-fetch-site');
  if (site) return site === 'same-origin';
  return true;
}

export function clientIp(req: Request, context?: { ip?: string }): string {
  return (
    context?.ip ||
    req.headers.get('x-nf-client-connection-ip') ||
    req.headers.get('x-forwarded-for')?.split(',')[0].trim() ||
    'unknown'
  );
}

export function getCookie(req: Request, name: string): string | null {
  const header = req.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

export function cookie(
  name: string,
  value: string,
  opts: { maxAge?: number; secure: boolean; sameSite?: 'Lax' | 'Strict'; path?: string },
): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${opts.path ?? '/'}`, 'HttpOnly', `SameSite=${opts.sameSite ?? 'Lax'}`];
  if (opts.secure) parts.push('Secure');
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${opts.maxAge}`);
  return parts.join('; ');
}

export function redirect(location: string, headers: Headers | Record<string, string> = {}): Response {
  const h = new Headers(headers);
  h.set('location', location);
  h.set('cache-control', 'no-store');
  return new Response(null, { status: 302, headers: h });
}

// ---------------------------------------------------------------------------
// Tiny router
// ---------------------------------------------------------------------------

export interface Ctx {
  req: Request;
  url: URL;
  params: Record<string, string>;
  ip: string;
  waitUntil: (p: Promise<unknown>) => void;
}

type Handler = (ctx: Ctx) => Promise<Response>;
interface Route { method: string; pattern: RegExp; keys: string[]; handler: Handler }

export class Router {
  private routes: Route[] = [];

  on(method: string, path: string, handler: Handler): this {
    const keys: string[] = [];
    const pattern = new RegExp(
      '^' + path.replace(/:([a-zA-Z_]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$',
    );
    this.routes.push({ method, pattern, keys, handler });
    return this;
  }

  match(method: string, pathname: string): { handler: Handler; params: Record<string, string> } | 'method_not_allowed' | null {
    let pathMatched = false;
    for (const r of this.routes) {
      const m = r.pattern.exec(pathname);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method) continue;
      const params: Record<string, string> = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      return { handler: r.handler, params };
    }
    return pathMatched ? 'method_not_allowed' : null;
  }
}
