// Admin dashboard QA: signs in with the local-development login (dev server only), then
// visits and exercises every page at desktop and mobile widths.
import type { Browser, Page } from 'playwright-core';
import type { QA } from './run.ts';
import { launch } from './browser.ts';

const PLATFORM = 'http://localhost:8888';

async function signIn(page: Page) {
  await page.goto(`${PLATFORM}/admin/login`);
  await page.fill('#dev-email', 'dev@ecomeal.in');
  await page.click('.dev-login button[type=submit]');
  await page.waitForURL(/\/admin$/);
  await page.waitForSelector('.metrics');
}

async function overflow(page: Page, label: string, issues: string[]) {
  const o = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (o > 1) issues.push(`[${label}] horizontal overflow of ${o}px`);
}

export async function adminFlow(_browser: Browser, qa: QA) {
  const { shot, watch, issues } = qa;
  for (const vp of [{ width: 1440, height: 900, name: 'desktop' }, { width: 1024, height: 768, name: 'laptop' }, { width: 390, height: 844, name: 'mobile' }]) {
    console.log(`admin @ ${vp.name}`);
    // Headless shell runs single-process: closing a context ends the browser, so use one per viewport.
    const browser = await launch();
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 1, ...(vp.width < 600 ? { isMobile: true, hasTouch: true } : {}) });
    await qa.offlineAssets(ctx);
    const page = await ctx.newPage();
    watch(page, `admin ${vp.name}`);
    const p = `a-${vp.name}`;

    if (vp.name === 'desktop') {
      await page.goto(`${PLATFORM}/admin/login`);
      await page.waitForSelector('.login-card');
      await shot(page, `${p}-00-login`);
      await page.goto(`${PLATFORM}/admin/login?error=no_access`);
      await page.waitForSelector('.notice');
      await shot(page, `${p}-00-login-error`);
    }

    await signIn(page);
    await page.waitForTimeout(300);
    await shot(page, `${p}-01-overview`, true);
    await overflow(page, `${vp.name} overview`, issues);

    await page.goto(`${PLATFORM}/admin/tickets`);
    await page.waitForSelector(vp.width < 800 ? '.card-item' : '.row-link');
    await shot(page, `${p}-02-tickets`, true);
    await overflow(page, `${vp.name} tickets`, issues);

    // Search
    await page.fill('#ticket-search', 'masala');
    await page.waitForTimeout(700);
    await shot(page, `${p}-03-tickets-search`);
    await page.fill('#ticket-search', 'zzzz-nothing');
    await page.waitForSelector('.empty');
    await shot(page, `${p}-04-tickets-empty`);
    await page.fill('#ticket-search', '');
    await page.waitForTimeout(600);

    // Open the first ticket
    // Prefer a ticket with attachments so previews are covered.
    const withClip = page.locator('.row-link:has(.clip) .num');
    const first = vp.width >= 800 && (await withClip.count()) > 0 ? withClip.first() : page.locator(vp.width < 800 ? '.card-item' : '.row-link .num').first();
    await first.click();
    await page.waitForSelector('.detail');
    await page.waitForTimeout(300);
    await shot(page, `${p}-05-ticket`, true);
    await overflow(page, `${vp.name} ticket`, issues);

    if (vp.name === 'desktop') {
      await page.selectOption('#priority', 'high');
      await page.waitForSelector('.toast');
      await page.selectOption('#status', 'in_progress');
      await page.waitForTimeout(500);
      await page.fill('#note', 'Called the restaurant. Restarting the POS sync service; will confirm in 15 minutes.');
      await page.click('.note-form button[type=submit]');
      await page.waitForSelector('.tl-note');
      await page.waitForTimeout(400);
      await shot(page, `${p}-06-ticket-after-actions`, true);
      const types = await page.$$eval('.tl', (els) => els.map((e) => e.className));
      if (!types.some((c) => c.includes('priority_changed')) || !types.some((c) => c.includes('status_changed')) || !types.some((c) => c.includes('note'))) {
        issues.push('[admin] timeline missing priority/status/note events');
      }
      // Persistence after reload
      await page.reload();
      await page.waitForSelector('.detail');
      const status = await page.inputValue('#status');
      if (status !== 'in_progress') issues.push(`[admin] status did not persist (got ${status})`);
    }

    await page.goto(`${PLATFORM}/admin/widget`);
    await page.waitForSelector('.code');
    await page.waitForTimeout(800);
    await shot(page, `${p}-07-widget`, true);
    await overflow(page, `${vp.name} widget`, issues);

    await page.goto(`${PLATFORM}/admin/integrations`);
    await page.waitForSelector('.section');
    await page.waitForTimeout(300);
    await shot(page, `${p}-08-integrations`, true);
    await overflow(page, `${vp.name} integrations`, issues);

    await page.goto(`${PLATFORM}/admin/settings`);
    await page.waitForSelector('.grid-2');
    await shot(page, `${p}-09-settings`, true);
    await overflow(page, `${vp.name} settings`, issues);
    if (vp.name === 'desktop') {
      await page.click('.tab:has-text("Widget text")');
      await shot(page, `${p}-10-settings-copy`, true);
      await page.click('.tab:has-text("Team")');
      await page.waitForSelector('.member');
      await shot(page, `${p}-11-settings-team`, true);
    }

    if (vp.width < 800) {
      await page.click('.topbar .icon-btn');
      await page.waitForTimeout(300);
      await shot(page, `${p}-12-menu`);
    }
    await browser.close();
  }
}
