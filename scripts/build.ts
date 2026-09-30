// Production build: admin + embed (Vite), widget.js loader (esbuild), asset manifest for the
// server-rendered embed page.
import { build as esbuild } from 'esbuild';
import { execSync } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';

execSync('npx tsx scripts/generate.ts', { stdio: 'inherit' });
execSync('npx vite build', { stdio: 'inherit' });

const manifest = JSON.parse(await readFile('dist/.vite/manifest.json', 'utf8')) as Record<string, { file: string; css?: string[]; isEntry?: boolean }>;
const embedEntry = Object.entries(manifest).find(([k]) => k.endsWith('embed/main.tsx'))?.[1];
if (!embedEntry) throw new Error('embed entry missing from manifest');
const assets = { embed: { js: '/' + embedEntry.file, css: (embedEntry.css ?? []).map((c) => '/' + c) } };
await mkdir('src/server/generated', { recursive: true });
await writeFile('src/server/generated/assets.json', JSON.stringify(assets, null, 2) + '\n');

await esbuild({
  entryPoints: ['src/client/widget/loader.ts'],
  outfile: 'dist/widget.js',
  bundle: true,
  minify: true,
  format: 'iife',
  target: ['es2019'],
  legalComments: 'none',
});
const size = (await readFile('dist/widget.js')).length;
console.log(`build: widget.js ${(size / 1024).toFixed(1)} KB, embed ${assets.embed.js}`);
