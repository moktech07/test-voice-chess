/**
 * Test harness entry point.
 *
 * It exposes the real engine module on `window` so the Playwright test can
 * drive it. Nothing here is part of the shipped app.
 */
import { ENGINE_FILES, StockfishEngine, createEngine } from '../../../src/core/engine.ts';

declare global {
  interface Window {
    __engineHarness?: {
      ENGINE_FILES: typeof ENGINE_FILES;
      StockfishEngine: typeof StockfishEngine;
      createEngine: typeof createEngine;
    };
  }
}

window.__engineHarness = {
  ENGINE_FILES,
  StockfishEngine,
  createEngine,
};

document.getElementById('status')!.textContent = 'harness ready';
