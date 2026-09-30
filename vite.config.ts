import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import { resolve } from 'node:path';

// Builds the widget panel (embed) and the admin dashboard. The widget loader (widget.js)
// is built separately by scripts/build.ts with esbuild so it stays tiny and dependency-free.
export default defineConfig({
  root: resolve(import.meta.dirname, 'src/client'),
  base: '/',
  plugins: [preact()],
  build: {
    outDir: resolve(import.meta.dirname, 'dist'),
    emptyOutDir: true,
    manifest: true,
    sourcemap: false,
    target: 'es2020',
    rollupOptions: {
      input: {
        embed: resolve(import.meta.dirname, 'src/client/embed/main.tsx'),
        admin: resolve(import.meta.dirname, 'src/client/admin/index.html'),
      },
    },
  },
});
