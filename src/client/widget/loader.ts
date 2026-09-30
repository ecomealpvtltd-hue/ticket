/*
 * Support widget loader. This is the only script a customer adds to their site:
 *
 *   <script src="https://support.example.com/widget.js" data-key="pk_live_..." async></script>
 *
 * It renders a launcher button inside a closed Shadow DOM (host CSS cannot reach it) and,
 * on first open, an iframe served from the platform origin that holds the actual support UI.
 * It never touches host styles, never blocks rendering, and fails quietly with one console
 * warning if the key or domain is misconfigured.
 */

interface LauncherConfig {
  brand: string;
  title: string;
  launcher: { label: string; position: 'right' | 'left'; offsetX: number; offsetY: number };
  theme: { accent: string; accentText: string; mode: 'light' | 'dark'; background: string | null };
  embedUrl: string;
}

declare global {
  interface Window {
    SupportWidget?: { open(): void; close(): void; toggle(): void };
    __supportWidgetLoaded?: boolean;
  }
}

(function () {
  if (window.__supportWidgetLoaded) return;
  window.__supportWidgetLoaded = true;

  const script = (document.currentScript ||
    document.querySelector('script[src*="/widget.js"][data-key],script[src*="/widget.js"][data-api-key]')) as HTMLScriptElement | null;
  if (!script) return;
  const key = script.getAttribute('data-key') || script.getAttribute('data-api-key') || '';
  const hideLauncher = script.getAttribute('data-launcher') === 'hidden';
  let base: string;
  try {
    base = new URL(script.src).origin;
  } catch {
    return;
  }
  const warn = (msg: string) => { try { console.warn('[Support widget] ' + msg); } catch { /* ignore */ } };
  if (!key) return warn('Missing data-key attribute on the widget script tag.');

  const ICON_HELP =
    '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/></svg>';
  const ICON_CLOSE =
    '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';

  function start(cfg: LauncherConfig) {
    // A custom tag name so generic host selectors (div, section, …) never match it, and
    // !important inline styles so even aggressive host stylesheets cannot move or hide it.
    const host = document.createElement('support-widget-root');
    const pin: Array<[string, string]> = [
      ['all', 'initial'], ['display', 'block'], ['position', 'fixed'], ['z-index', '2147483000'],
      ['top', 'auto'], ['left', 'auto'], ['right', 'auto'], ['bottom', 'auto'], ['width', '0'], ['height', '0'],
      ['margin', '0'], ['padding', '0'], ['border', '0'], ['transform', 'none'], ['filter', 'none'], ['opacity', '1'], ['visibility', 'visible'],
    ];
    for (const [k, v] of pin) host.style.setProperty(k, v, 'important');
    const root = host.attachShadow({ mode: 'closed' });

    const side = cfg.launcher.position === 'left' ? 'left' : 'right';
    const ox = cfg.launcher.offsetX, oy = cfg.launcher.offsetY;
    const dark = cfg.theme.mode === 'dark';
    const panelBg = cfg.theme.background || (dark ? '#111315' : '#ffffff');

    root.innerHTML = `
<style>
  :host { all: initial; }
  *, *::before, *::after { box-sizing: border-box; }
  .launcher {
    position: fixed; ${side}: ${ox}px; bottom: ${oy}px;
    display: inline-flex; align-items: center; gap: 8px;
    height: 48px; padding: 0 18px 0 14px; border: 0; border-radius: 24px; cursor: pointer;
    background: ${cfg.theme.accent}; color: ${cfg.theme.accentText};
    font: 600 15px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    letter-spacing: 0; text-transform: none;
    box-shadow: 0 1px 2px rgba(0,0,0,.18), 0 6px 20px rgba(0,0,0,.14);
    transition: transform .15s ease, box-shadow .15s ease;
    -webkit-tap-highlight-color: transparent;
  }
  .launcher:hover { transform: translateY(-1px); box-shadow: 0 2px 4px rgba(0,0,0,.18), 0 10px 24px rgba(0,0,0,.16); }
  .launcher:focus-visible { outline: 2px solid ${cfg.theme.accent}; outline-offset: 3px; }
  .launcher svg { flex: none; }
  .launcher[aria-expanded="true"] .label { display: none; }
  .launcher[aria-expanded="true"] { padding: 0; width: 48px; justify-content: center; }
  .launcher .i-close { display: none; }
  .launcher[aria-expanded="true"] .i-help { display: none; }
  .launcher[aria-expanded="true"] .i-close { display: inline-flex; }
  .launcher[hidden] { display: none; }

  .panel {
    position: fixed; ${side}: ${ox}px; bottom: ${oy + 48 + 12}px;
    width: 400px; height: min(680px, calc(100vh - ${oy + 48 + 12 + 16}px));
    max-width: calc(100vw - ${ox * 2}px);
    border-radius: 14px; overflow: hidden; background: ${panelBg};
    border: 1px solid ${dark ? 'rgba(255,255,255,.08)' : 'rgba(15,23,42,.08)'};
    box-shadow: 0 1px 3px rgba(0,0,0,.12), 0 16px 48px rgba(0,0,0,${dark ? '.45' : '.18'});
    opacity: 0; transform: translateY(8px); pointer-events: none; visibility: hidden;
    transition: opacity .16s ease, transform .16s ease, visibility 0s linear .16s;
  }
  .panel.open { opacity: 1; transform: none; pointer-events: auto; visibility: visible; transition: opacity .16s ease, transform .16s ease; }
  .panel iframe { display: block; width: 100%; height: 100%; border: 0; background: transparent; color-scheme: ${dark ? 'dark' : 'light'}; }
  .loading { position: absolute; inset: 0; display: grid; place-items: center; }
  .loading span { width: 20px; height: 20px; border-radius: 50%; border: 2px solid ${dark ? 'rgba(255,255,255,.18)' : 'rgba(15,23,42,.14)'}; border-top-color: ${cfg.theme.accent}; animation: spin .8s linear infinite; }
  .panel.ready .loading { display: none; }
  @keyframes spin { to { transform: rotate(360deg); } }

  @media (max-width: 600px) {
    .launcher { ${side}: 16px; bottom: 16px; }
    .panel { inset: 0; width: 100%; max-width: 100%; height: 100%; height: 100dvh; border-radius: 0; border: 0; bottom: 0; ${side}: 0; }
    .panel.open ~ .launcher, .launcher.panel-open { display: none; }
  }
  @media (prefers-reduced-motion: reduce) {
    .launcher, .panel, .panel.open { transition: none; }
    .launcher:hover { transform: none; }
  }
</style>
<div class="panel" role="dialog" aria-modal="false" aria-label="${escapeAttr(cfg.title)}" id="sp-panel"><div class="loading" aria-hidden="true"><span></span></div></div>
<button class="launcher" type="button" aria-expanded="false" aria-controls="sp-panel" aria-label="${escapeAttr(cfg.title)}">
  <span class="i-help">${ICON_HELP}</span><span class="i-close">${ICON_CLOSE}</span><span class="label">${escapeHtml(cfg.launcher.label)}</span>
</button>`;

    const panel = root.querySelector('.panel') as HTMLDivElement;
    const launcher = root.querySelector('.launcher') as HTMLButtonElement;
    if (hideLauncher) launcher.hidden = true;
    let iframe: HTMLIFrameElement | null = null;
    let isOpen = false;
    let lastFocus: Element | null = null;

    function post(msg: Record<string, unknown>) {
      if (iframe?.contentWindow) iframe.contentWindow.postMessage(msg, base);
    }

    function ensureFrame() {
      if (iframe) return;
      iframe = document.createElement('iframe');
      iframe.title = cfg.title;
      const u = new URL(cfg.embedUrl);
      u.searchParams.set('host', location.origin);
      iframe.src = u.toString();
      iframe.setAttribute('allow', 'clipboard-write');
      iframe.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
      iframe.addEventListener('load', () => panel.classList.add('ready'));
      panel.appendChild(iframe);
    }

    function open() {
      if (isOpen) return;
      ensureFrame();
      isOpen = true;
      lastFocus = document.activeElement;
      panel.classList.add('open');
      launcher.classList.add('panel-open');
      launcher.setAttribute('aria-expanded', 'true');
      launcher.setAttribute('aria-label', 'Close ' + cfg.title);
      // Move focus into the panel once it is showing.
      setTimeout(() => { iframe?.focus(); post({ type: 'sp:open' }); }, 60);
    }

    function close() {
      if (!isOpen) return;
      isOpen = false;
      panel.classList.remove('open');
      launcher.classList.remove('panel-open');
      launcher.setAttribute('aria-expanded', 'false');
      launcher.setAttribute('aria-label', cfg.title);
      post({ type: 'sp:closed' });
      const target = !hideLauncher ? launcher : (lastFocus as HTMLElement | null);
      try { target?.focus({ preventScroll: true }); } catch { /* ignore */ }
    }

    launcher.addEventListener('click', () => (isOpen ? close() : open()));

    window.addEventListener('message', (e: MessageEvent) => {
      if (e.origin !== base || !iframe || e.source !== iframe.contentWindow) return;
      const d = e.data as { type?: string };
      if (d?.type === 'sp:close') close();
      if (d?.type === 'sp:ready') panel.classList.add('ready');
    });

    // Escape closes the panel when focus is on the host page (inside the iframe it handles Escape itself).
    document.addEventListener('keydown', (e) => {
      if (isOpen && e.key === 'Escape' && !e.defaultPrevented) close();
    });

    window.SupportWidget = { open, close, toggle: () => (isOpen ? close() : open()) };

    // Warm the iframe once the page is idle so the first open is instant.
    const idle = (window as any).requestIdleCallback || ((fn: () => void) => setTimeout(fn, 2500));
    idle(() => ensureFrame(), { timeout: 5000 });

    document.body.appendChild(host);
  }

  function escapeHtml(s: string) {
    return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
  }
  function escapeAttr(s: string) { return escapeHtml(s); }

  function boot() {
    fetch(`${base}/api/widget/config?key=${encodeURIComponent(key)}`, { credentials: 'omit', mode: 'cors' })
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          warn(body?.error?.message || `Configuration request failed (${res.status}).`);
          return;
        }
        start((await res.json()) as LauncherConfig);
      })
      .catch(() => warn('Could not reach the support service.'));
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();

export {};
