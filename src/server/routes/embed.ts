// Server-rendered shell for the widget panel (loaded inside an iframe on the customer's site).
// Rendered per tenant so the browser itself enforces the tenant's allowed domains through
// the Content-Security-Policy frame-ancestors directive.

import { env } from '../env.js';
import { randomToken } from '../crypto.js';
import { frameAncestors, resolveWidgetKey, type ResolvedKey } from '../services/tenants.js';
import { issueEmbedToken } from './widget.js';
import assets from '../generated/assets.json' with { type: 'json' };
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS, COUNTRIES } from '../../shared/model.js';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
/** JSON safe to embed in a <script type="application/json"> block. */
const safeJson = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

function csp(ancestors: string, nonce: string): string {
  return [
    "default-src 'none'",
    "script-src 'self'",
    `style-src 'self' 'nonce-${nonce}' https://fonts.googleapis.com`,
    'font-src https://fonts.gstatic.com',
    "img-src 'self' https: data: blob:",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    `frame-ancestors ${ancestors}`,
  ].join('; ');
}

function bootData(r: ResolvedKey) {
  const c = r.tenant.config;
  return {
    key: r.publicKey,
    token: issueEmbedToken(r),
    config: {
      brand: c.brand,
      theme: c.theme,
      copy: c.copy,
      contactOptions: c.contactOptions,
      form: c.form,
      categories: c.form.showCategory ? c.categories : [],
      poweredBy: c.poweredBy,
    },
    limits: { maxBytes: MAX_ATTACHMENT_BYTES, maxFiles: MAX_ATTACHMENTS },
    countries: COUNTRIES.map((x) => ({ code: x.code, dial: x.dial, name: x.name })),
  };
}

export async function renderEmbed(publicKey: string): Promise<Response> {
  const resolved = await resolveWidgetKey(publicKey).catch(() => null);
  const nonce = randomToken(12);
  if (!resolved) {
    const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Support unavailable</title>
<style nonce="${nonce}">body{margin:0;font:15px/1.5 system-ui,sans-serif;color:#374151;display:grid;place-items:center;height:100vh;text-align:center;padding:24px;box-sizing:border-box}</style></head>
<body><p>Support is not available right now.</p></body></html>`;
    return new Response(body, { status: 404, headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': csp('*', nonce), 'cache-control': 'no-store' } });
  }

  const t = resolved.tenant.config.theme;
  const fontLink = t.googleFont
    ? `<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=${esc(t.googleFont)}&display=swap">`
    : '';
  const title = esc(resolved.tenant.config.copy.title);
  const embed = (assets as any).embed as { js: string; css: string[] };
  const html = `<!doctype html>
<html lang="en" data-mode="${t.mode}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<title>${title}</title>
${fontLink}
${embed.css.map((href) => `<link rel="stylesheet" href="${esc(href)}">`).join('\n')}
<script type="application/json" id="sp-boot">${safeJson(bootData(resolved))}</script>
<script type="module" src="${esc(embed.js)}"></script>
</head>
<body><div id="app" aria-live="polite"></div></body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      // 'self' lets the tenant's own admin dashboard show a live preview of the widget.
      'content-security-policy': csp(frameAncestors(resolved.tenant.allowedOrigins, ["'self'"]), nonce),
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'strict-origin-when-cross-origin',
      'permissions-policy': 'camera=(), microphone=(), geolocation=()',
      // Short cache: the embed token inside is time-limited.
      'cache-control': 'private, no-cache',
    },
  });
}

export { env };
