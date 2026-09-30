import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import { resolve } from 'node:path';

// Offline prototype: the real widget panel and dashboard, backed by an in-browser stand-in API.
export default defineConfig({
  root: resolve(import.meta.dirname, 'src/prototype'),
  base: './',
  plugins: [preact()],
  build: {
    outDir: resolve(import.meta.dirname, 'dist-prototype'),
    emptyOutDir: true,
    target: 'es2022',
    assetsInlineLimit: 0,
    rollupOptions: {
      input: {
        index: resolve(import.meta.dirname, 'src/prototype/index.html'),
        embed: resolve(import.meta.dirname, 'src/prototype/embed.html'),
        admin: resolve(import.meta.dirname, 'src/prototype/admin.html'),
      },
    },
  },
});
