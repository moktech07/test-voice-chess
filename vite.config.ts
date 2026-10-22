import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    target: 'es2020',
    // The stockfish wasm is large; keep the warning but do not inline it.
    chunkSizeWarningLimit: 4096,
    rollupOptions: {
      output: {
        // Keep the engine in its own chunk. It changes far less often than
        // the app code, so users get a small app update instead of
        // re-downloading the engine, and the browser test can find the
        // engine chunk by name.
        manualChunks(id: string) {
          if (id.includes('src/core/engine')) return 'engine';
          return undefined;
        },
      },
    },
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
