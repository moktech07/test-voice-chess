import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, '../../..');

/**
 * A separate production build of the real engine module, used only by
 * tests/e2e/engine.browser.test.ts.
 *
 * It reuses the app's `public/` directory so the engine bundle and the wasm
 * land next to the harness exactly like they do in the real app — that is
 * what makes the harness a faithful test of the relative-URL loading.
 */
export default defineConfig({
  base: './',
  root: here,
  publicDir: path.resolve(appRoot, 'public'),
  build: {
    outDir: path.resolve(here, 'dist'),
    emptyOutDir: true,
    target: 'es2020',
    rollupOptions: {
      input: path.resolve(here, 'index.html'),
    },
  },
});
