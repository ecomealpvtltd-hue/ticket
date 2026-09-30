// Headless Chromium for visual QA (works offline; uses @sparticuz/chromium's bundled binary).
import chromium from '@sparticuz/chromium';
import { chromium as pw, type Browser } from 'playwright-core';

export async function launch(): Promise<Browser> {
  return pw.launch({ executablePath: await chromium.executablePath(), args: chromium.args, headless: true });
}
