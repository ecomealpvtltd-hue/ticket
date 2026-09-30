// Builds the offline prototype into dist-prototype/ (publishable as a static multi-file page).
import { execSync } from 'node:child_process';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { build as esbuild } from 'esbuild';

execSync('npx vite build --config vite.prototype.config.ts', { stdio: 'inherit' });
await esbuild({ entryPoints: ['src/client/widget/loader.ts'], outfile: 'dist-prototype/widget.js', bundle: true, minify: true, format: 'iife', target: ['es2019'] });
// The artifact host wraps the main page in its own document skeleton: keep only head/body content.
let html = await readFile('dist-prototype/index.html', 'utf8');
if (/<head[\s>]/i.test(html)) {
  const head = /<head[^>]*>([\s\S]*?)<\/head>/i.exec(html)?.[1] ?? '';
  const body = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(html)?.[1] ?? '';
  html = head.replace(/<meta charset[^>]*>/i, '') + '\n' + body;
}
html = html.replace(/<!doctype[^>]*>/i, '').trim() + '\n';
await writeFile('dist-prototype/index.html', html);
console.log('prototype built');
