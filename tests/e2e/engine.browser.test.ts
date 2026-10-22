import { expect, test } from '@playwright/test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The real proof that the Web Worker + wasm loading works in a browser.
 *
 * The harness (tests/e2e/engine-harness) is a tiny production Vite build of
 * the REAL `src/core/engine.ts` module. It is served from a SUBDIRECTORY
 * (`/voice-chess/`) by a plain static server, which is exactly how a GitHub
 * Pages project site works. If any asset URL were absolute, this test would
 * fail.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.join(here, '../..');
const HARNESS_DIR = path.join(here, 'engine-harness');
const HARNESS_DIST = path.join(HARNESS_DIR, 'dist');

const MOUNT = '/voice-chess/';
const PORT = 4174;
const BASE = `http://127.0.0.1:${PORT}${MOUNT}`;
const REQUEST_LOG = path.join(HARNESS_DIR, 'requests.log');

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/** Build the harness and start the static server. Returns a stop function. */
async function startHarness(): Promise<() => Promise<void>> {
  await new Promise<void>((resolve, reject) => {
    const build = spawn(
      process.execPath,
      [
        path.join(APP_ROOT, 'node_modules/vite/bin/vite.js'),
        'build',
        '--config',
        path.join(HARNESS_DIR, 'vite.config.ts'),
      ],
      { cwd: APP_ROOT, stdio: 'inherit' },
    );
    build.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`harness build failed with code ${code}`)),
    );
  });

  fs.writeFileSync(REQUEST_LOG, '');

  const server = spawn(
    process.execPath,
    [path.join(HARNESS_DIR, 'serve.mjs'), HARNESS_DIST, String(PORT), MOUNT, REQUEST_LOG],
    { stdio: 'inherit' },
  );

  /* Wait for the server to answer. */
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      const res = await fetch(BASE);
      if (res.ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) {
      server.kill();
      throw new Error('harness server did not start');
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  return async () => {
    server.kill();
  };
}

test.describe.configure({ mode: 'serial' });

let stopHarness: (() => Promise<void>) | null = null;

test.beforeAll(async () => {
  stopHarness = await startHarness();
});

test.afterAll(async () => {
  await stopHarness?.();
});

test.describe('stockfish engine in the browser', () => {
  test('the engine reaches ready and returns a legal move from the start position', async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    page.on('pageerror', (err) => errors.push(String(err)));

    /* The worker requests are recorded server-side (see REQUEST_LOG). */
    await page.goto(BASE);

    await page.waitForFunction(
      () => Boolean((window as never as { __engineHarness?: unknown }).__engineHarness),
    );

    const result = await page.evaluate(async (fen: string) => {
      const harness = (
        window as never as {
          __engineHarness: {
            StockfishEngine: new (o?: unknown) => {
              init(): Promise<void>;
              search(
                f: string,
                o?: { depth?: number; movetimeMs?: number },
              ): Promise<{ from: string; to: string; promotion?: string }>;
              setDifficulty(l: number): void;
              readonly ready: boolean;
              dispose(): void;
            };
            ENGINE_FILES: { js: string; wasm: string; worker: string };
          };
        }
      ).__engineHarness;

      const engine = new harness.StockfishEngine();
      await engine.init();
      const ready = engine.ready;

      engine.setDifficulty(2);
      const move = await engine.search(fen);

      /* A second search proves the worker is reusable after a bestmove. */
      const move2 = await engine.search(fen);

      const files = harness.ENGINE_FILES;

      engine.dispose();

      return { ready, move, move2, files };
    }, START_FEN);

    expect(result.ready).toBe(true);
    expect(result.move).toBeTruthy();
    expect(result.move.from).toMatch(/^[a-h][1-8]$/);
    expect(result.move.to).toMatch(/^[a-h][1-8]$/);
    expect(result.move2).toBeTruthy();

    /* Stockfish's answer to 1.e4 from the start position. */
    expect(`${result.move.from}${result.move.to}`).toBe('e2e4');

    /* The shipped asset paths must be relative. */
    expect(result.files.js).toBe('./engine/stockfish-19-lite-single.js');
    expect(result.files.wasm).toBe('./engine/stockfish-19-lite-single.wasm');

    /* The worker must really have loaded the engine bundle AND the wasm
       binary, both from the subdirectory. Requests made from inside a
       dedicated worker do not show up in Playwright's page-level request
       events, so we read them from the static server's log. */
    const served = fs
      .readFileSync(REQUEST_LOG, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);

    expect(served).toContain('/voice-chess/engine/stockfish-worker.js');
    expect(served).toContain('/voice-chess/engine/stockfish-19-lite-single.js');
    expect(served).toContain('/voice-chess/engine/stockfish-19-lite-single.wasm');

    /* Nothing may be requested from outside the subdirectory mount (the
       browser's own /favicon.ico probe is not one of our assets). */
    for (const p of served) {
      if (p === '/favicon.ico') continue;
      expect(p.startsWith(MOUNT)).toBe(true);
    }

    /* No engine errors in the console. */
    const realErrors = errors.filter((e) => !/favicon|Failed to load resource/i.test(e));
    expect(realErrors).toEqual([]);
  });

  test('the engine assets exist under the subdirectory and are reachable relatively', async ({
    page,
  }) => {
    await page.goto(BASE);

    /* The harness page must reference its script relatively. */
    const scripts = await page.evaluate(() =>
      [...document.querySelectorAll('script[src]')].map((s) => s.getAttribute('src') ?? ''),
    );
    for (const src of scripts) {
      expect(src).not.toMatch(/^\//);
      expect(src).not.toMatch(/^https?:\/\//);
    }

    /* And the engine files must actually be served from the subdirectory. */
    for (const rel of [
      './engine/stockfish-19-lite-single.js',
      './engine/stockfish-19-lite-single.wasm',
      './engine/stockfish-worker.js',
    ]) {
      const status = await page.evaluate(async (r) => {
        const res = await fetch(new URL(r, document.baseURI).toString());
        return { status: res.status, type: res.headers.get('content-type') };
      }, rel);
      expect(status.status, `${rel} should be served`).toBe(200);
    }

    /* The wasm must have the right MIME type for instantiateStreaming. */
    const wasmType = await page.evaluate(async () => {
      const res = await fetch(
        new URL('./engine/stockfish-19-lite-single.wasm', document.baseURI).toString(),
      );
      return res.headers.get('content-type');
    });
    expect(wasmType).toMatch(/application\/wasm/);
  });

  test('searching before init rejects with a clear error', async ({ page }) => {
    await page.goto(BASE);
    await page.waitForFunction(
      () => Boolean((window as never as { __engineHarness?: unknown }).__engineHarness),
    );

    const message = await page.evaluate(async (fen: string) => {
      const harness = (
        window as never as {
          __engineHarness: {
            StockfishEngine: new (o?: unknown) => { search(f: string): Promise<unknown> };
          };
        }
      ).__engineHarness;

      const engine = new harness.StockfishEngine();
      try {
        await engine.search(fen);
        return null;
      } catch (err) {
        return (err as Error).message;
      }
    }, START_FEN);

    expect(message).toMatch(/not ready/i);
  });

  test('a failing engine load rejects init with a clear message', async ({ page }) => {
    await page.goto(BASE);
    await page.waitForFunction(
      () => Boolean((window as never as { __engineHarness?: unknown }).__engineHarness),
    );

    const message = await page.evaluate(async () => {
      const harness = (
        window as never as {
          __engineHarness: {
            StockfishEngine: new (o?: unknown) => {
              init(): Promise<void>;
              dispose(): void;
            };
          };
        }
      ).__engineHarness;

      /* Point the engine at a URL that does not exist. */
      const engine = new harness.StockfishEngine({
        wasmUrl: './engine/definitely-not-here.wasm',
        initTimeoutMs: 5000,
      });
      try {
        await engine.init();
        return null;
      } catch (err) {
        return (err as Error).message;
      } finally {
        engine.dispose();
      }
    });

    expect(message).toBeTruthy();
    expect(message).toMatch(/engine/i);
  });
});
