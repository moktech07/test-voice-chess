import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    target: 'es2020',
    // The stockfish wasm is large; keep the warning but do not inline it.
    chunkSizeWarningLimit: 4096,
  },
  worker: {
    format: 'es',
  },
  server: {
    host: true,
    port: 5173,
  },
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
  },
});
