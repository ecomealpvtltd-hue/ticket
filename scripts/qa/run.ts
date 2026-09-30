// Visual + functional QA driver. Renders real pages in headless Chromium against the local
// dev server, interacts like a user, and writes screenshots to /var/tmp/qa.
//
//   npx tsx scripts/qa/run.ts [widget|admin|all]
//
// Offline sandbox note: Google Fonts and the tenant logo are served from local copies so the
// screenshots match production rendering.

import { readFile, mkdir } from 'node:fs/promises';
import type { Page, BrowserContext } from 'playwright-core';
import { launch } from './browser.ts';

const OUT = '/var/tmp/qa';
const DEMO = 'http://localhost:8899';
const PLATFORM = 'http://localhost:8888';
const issues: string[] = [];

const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96"><rect width="96" height="96" fill="#060B08"/><path d="M66 58a22 22 0 1 1 2-16H38" fill="none" stroke="#B7D96A" stroke-width="9" stroke-linecap="round"/></svg>`;

async function offlineAssets(ctx: BrowserContext) {
  await ctx.route('https://fonts.googleapis.com/**', async (route) => {
    const css = [400, 500, 600].map((w) => `@font-face{font-family:'Instrument Sans';font-style:normal;font-weight:${w};font-display:swap;src:url(https://fonts.gstatic.com/qa/instrument-sans-latin-${w}-normal.woff2) format('woff2')}`).join('\n');
    await route.fulfill({ status: 200, contentType: 'text/css', body: css });
  });
  await ctx.route('https://fonts.gstatic.com/qa/**', async (route) => {
    const name = route.request().url().split('/').pop()!;
    await route.fulfill({ status: 200, contentType: 'font/woff2', body: await readFile(`node_modules/@fontsource/instrument-sans/files/${name}`), headers: { 'access-control-allow-origin': '*' } });
  });
  await ctx.route('https://ecomeal.in/assets/favicon.png', async (route) => {
    await route.fulfill({ status: 200, contentType: 'image/svg+xml', body: LOGO_SVG });
  });
}

function watch(page: Page, label: string) {
  page.on('pageerror', (e) => issues.push(`[${label}] page error: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/favicon|ERR_TUNNEL|status of 415|ERR_INTERNET_DISCONNECTED/.test(m.text())) issues.push(`[${label}] console error: ${m.text()}`);
  });
}

async function shot(page: Page, name: string, fullPage = false) {
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage });
  console.log(`  shot ${name}`);
}

async function frameOf(page: Page) {
  const handle = await page.waitForSelector('support-widget-root', { state: 'attached' });
  // closed shadow root: reach the iframe through the frame tree instead
  void handle;
  for (let i = 0; i < 40; i++) {
    const f = page.frames().find((fr) => fr.url().includes('/embed/'));
    if (f) { await f.waitForSelector('.screen'); return f; }
    await page.waitForTimeout(100);
  }
  throw new Error('embed frame not found');
}

async function checkOverflow(page: Page, label: string) {
  const f = page.frames().find((fr) => fr.url().includes('/embed/'));
  if (!f) return;
  const over = await f.evaluate(() => {
    const out: string[] = [];
    document.querySelectorAll<HTMLElement>('.screen *').forEach((el) => {
      if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX === 'visible' && el.clientWidth > 0 && !['SELECT', 'svg'].includes(el.tagName)) {
        out.push(`${el.tagName}.${el.className} ${el.scrollWidth}>${el.clientWidth}`);
      }
    });
    return { items: out.slice(0, 5), doc: document.documentElement.scrollWidth > document.documentElement.clientWidth };
  });
  if (over.doc) issues.push(`[${label}] horizontal page overflow inside panel`);
  for (const o of over.items) issues.push(`[${label}] element overflow: ${o}`);
}

async function widgetFlow(ctx: BrowserContext, vp: { width: number; height: number; name: string; mobile?: boolean }) {
  const page = await ctx.newPage();
  await page.setViewportSize({ width: vp.width, height: vp.height });
  watch(page, `widget ${vp.name}`);
  const p = `w-${vp.name}`;
  await page.goto(`${DEMO}/clean.html`);
  await page.waitForFunction(() => !!(window as any).SupportWidget);
  await shot(page, `${p}-01-closed`);

  // Open via the real launcher button (click inside the shadow root by coordinates).
  const box = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
  await page.mouse.click(box.w - 60, box.h - 44);
  const f = await frameOf(page);
  await page.waitForTimeout(400);
  await shot(page, `${p}-02-home`);
  await checkOverflow(page, `${vp.name} home`);

  await f.click('.cta');
  await f.waitForSelector('form');
  await shot(page, `${p}-03-form-empty`);

  // Validation
  await f.click('.btn-primary');
  await page.waitForTimeout(150);
  const errs = await f.$$eval('.error', (els) => els.map((e) => e.textContent));
  if (errs.length < 4) issues.push(`[${vp.name}] expected 4 validation errors, got ${errs.length}`);
  const focused = await f.evaluate(() => document.activeElement?.getAttribute('name'));
  if (focused !== 'name') issues.push(`[${vp.name}] focus did not move to first invalid field (got ${focused})`);
  await shot(page, `${p}-04-validation`);

  await f.fill('#name', 'Rahul Sharma');
  await f.fill('#phone', '98765 43210');
  await f.fill('#orgName', 'Green Bowl, Indiranagar');
  await f.fill('#description', 'Our POS stopped receiving Swiggy and Zomato orders at around 7 PM. The tablet shows "sync failed" and orders are piling up on the aggregator side.');

  // Attachments: one good image, one refused type
  const png = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: 400, height: 300 } });
  await f.setInputFiles('input[type=file]', [{ name: 'pos-error.png', mimeType: 'image/png', buffer: png }]);
  await f.waitForSelector('.file.done', { timeout: 10000 }).catch(() => issues.push(`[${vp.name}] upload did not complete`));
  await f.setInputFiles('input[type=file]', [{ name: 'setup.exe', mimeType: 'application/octet-stream', buffer: Buffer.from('MZ\x90\x00binary') }]);
  await f.waitForSelector('.file.error', { timeout: 10000 }).catch(() => issues.push(`[${vp.name}] bad file not rejected`));
  await shot(page, `${p}-05-form-filled`);
  await f.click('.file.error button[aria-label^="Remove"]');

  // Scroll the form body to the bottom to see the attachment area on small screens
  await f.evaluate(() => document.querySelector('.body')!.scrollTo(0, 99999));
  await shot(page, `${p}-06-form-bottom`);

  // Submit (the widget refuses submissions faster than 3s, which a human never hits)
  await page.waitForTimeout(3100);
  await f.click('.btn-primary');
  await f.waitForSelector('.success', { timeout: 10000 });
  const number = await f.textContent('#ticket-number');
  if (!/^ECM-\d{6}$/.test(number ?? '')) issues.push(`[${vp.name}] bad ticket number ${number}`);
  await shot(page, `${p}-07-success`);
  console.log(`  ticket ${number}`);

  // Escape closes, focus returns
  await f.press('body', 'Escape');
  await page.waitForTimeout(300);
  await shot(page, `${p}-08-closed-again`);
  await page.close();
  return number;
}

async function widgetErrorStates(ctx: BrowserContext) {
  const page = await ctx.newPage();
  await page.setViewportSize({ width: 1280, height: 800 });
  watch(page, 'widget errors');
  await page.goto(`${DEMO}/clean.html`);
  await page.waitForFunction(() => !!(window as any).SupportWidget);
  await page.evaluate(() => (window as any).SupportWidget.open());
  const f = await frameOf(page);
  await f.click('.cta');
  await f.fill('#name', 'Asha');
  await f.fill('#phone', '98450 12345');
  await f.fill('#orgName', 'Masala Box');
  await f.fill('#description', 'Printer is not printing KOTs since the morning shift started.');
  // Simulate the network failing on submit
  await ctx.route('**/api/widget/tickets', (route) => route.abort('internetdisconnected'));
  await page.waitForTimeout(3100);
  await f.click('.btn-primary');
  await f.waitForSelector('.banner');
  await shot(page, 'w-err-01-network');
  const kept = await f.inputValue('#description');
  if (!kept) issues.push('[errors] form lost data after network failure');
  // Loading state: hold the request
  await ctx.unroute('**/api/widget/tickets');
  await ctx.route('**/api/widget/tickets', async (route) => { await new Promise((r) => setTimeout(r, 1500)); await route.continue(); });
  await f.click('.btn-primary');
  await page.waitForTimeout(300);
  await shot(page, 'w-err-02-submitting');
  await f.waitForSelector('.success', { timeout: 10000 });
  await ctx.unroute('**/api/widget/tickets');
  await page.close();
}

async function hostileHost(ctx: BrowserContext) {
  const page = await ctx.newPage();
  await page.setViewportSize({ width: 1280, height: 800 });
  watch(page, 'hostile host');
  await page.goto(`${DEMO}/index.html`);
  await page.waitForFunction(() => !!(window as any).SupportWidget);
  await shot(page, 'w-hostile-01-closed');
  await page.evaluate(() => (window as any).SupportWidget.open());
  await frameOf(page);
  await page.waitForTimeout(500);
  await shot(page, 'w-hostile-02-open');
  const scrollable = await page.evaluate(() => { scrollTo(0, 600); return scrollY > 0; });
  if (!scrollable) issues.push('[hostile] host page not scrollable with widget open');
  await page.close();
}

async function disallowedDomain(ctx: BrowserContext) {
  // A page on a domain that is not in the allowed list must not be able to frame the panel.
  const page = await ctx.newPage();
  const key = await (await fetch(`${DEMO}/`)).text().then((h) => /data-key="([^"]+)"/.exec(h)?.[1]);
  let blocked = false;
  page.on('console', (m) => { if (/frame-ancestors|Refused to frame/i.test(m.text())) blocked = true; });
  await page.setContent(`<iframe src="${PLATFORM}/embed/${key}" width="400" height="600"></iframe>`);
  await page.waitForTimeout(1500);
  const loaded = page.frames().some((f) => f.url().includes('/embed/') && f.url() !== 'about:blank' && f.name() !== 'x');
  const text = await page.frames().find((f) => f.url().includes('/embed/'))?.evaluate(() => document.body?.innerText ?? '').catch(() => '');
  if (!blocked && text && text.length > 0) issues.push('[domain lock] embed rendered inside a disallowed origin');
  console.log(`  frame-ancestors blocked: ${blocked || !text} (loaded=${loaded})`);
  await page.close();
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const which = process.argv[2] ?? 'widget';
  const browser = await launch();
  const ctx = await browser.newContext({ deviceScaleFactor: 1 });
  await offlineAssets(ctx);
  try {
    if (which === 'widget' || which === 'all') {
      for (const vp of [
        { width: 1440, height: 900, name: 'desktop' },
        { width: 375, height: 740, name: 'iphone' },
        { width: 320, height: 640, name: 'small' },
        { width: 768, height: 1024, name: 'tablet' },
      ]) {
        console.log(`widget @ ${vp.name}`);
        // A fresh browser per viewport keeps runs independent (and avoids a headless-shell
        // quirk where a second mobile context silently stalls).
        const b2 = await launch();
        const mctx = await b2.newContext(vp.width < 600 ? { isMobile: true, hasTouch: true, deviceScaleFactor: 1 } : { deviceScaleFactor: 1 });
        await offlineAssets(mctx);
        try { await widgetFlow(mctx, vp); } finally { await b2.close(); }
      }
      console.log('widget error states'); await widgetErrorStates(ctx);
      console.log('hostile host'); await hostileHost(ctx);
      console.log('domain lock'); await disallowedDomain(ctx);
    }
    if (which === 'admin' || which === 'all') {
      const { adminFlow } = await import('./admin-flow.ts');
      await adminFlow(browser, { shot, watch, issues, offlineAssets });
    }
  } finally {
    await browser.close();
  }
  console.log(issues.length ? `\nISSUES (${issues.length}):\n- ${issues.join('\n- ')}` : '\nNo issues detected.');
}

main().catch((e) => { console.error(e); process.exit(1); });

export type QA = { shot: typeof shot; watch: typeof watch; issues: string[]; offlineAssets: typeof offlineAssets };
