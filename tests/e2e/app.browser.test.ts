import { expect, test } from '@playwright/test';

/**
 * End-to-end test of the whole voice loop in a real browser:
 *   speech recognition (faked) -> parse -> resolve -> engine -> speech synthesis (faked)
 *
 * The app is injected with fake speech APIs so the loop is fully deterministic.
 */

/** Installed into the page before any app code runs. */
function installFakeSpeech(): void {
  const w = window as unknown as Record<string, unknown>;

  /* ---- fake speech synthesis ---- */
  const spoken: string[] = [];
  w.__spoken = spoken;

  class FakeUtterance {
    text: string;
    onend: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onstart: (() => void) | null = null;
    voice: unknown = null;
    lang = '';
    rate = 1;
    pitch = 1;
    volume = 1;
    constructor(text = '') {
      this.text = text;
    }
  }
  w.SpeechSynthesisUtterance = FakeUtterance;

  /*
   * `window.speechSynthesis` is a getter-only property on the Window
   * interface, so a plain assignment is silently ignored and the real
   * (voiceless, headless) API would be used instead. defineProperty
   * replaces it properly.
   */
  const fakeSynthesis = {
    speaking: false,
    paused: false,
    pending: false,
    getVoices: () => [
      { name: 'Google US English', lang: 'en-US', default: true, localService: true },
    ],
    speak(utter: { text: string; onend?: () => void; onerror?: () => void }): void {
      spoken.push(utter.text);
      setTimeout(() => utter.onend?.(), 0);
    },
    cancel(): void {},
    pause(): void {},
    resume(): void {},
    addEventListener(): void {},
    removeEventListener(): void {},
    onvoiceschanged: null,
  };
  Object.defineProperty(w, 'speechSynthesis', {
    value: fakeSynthesis,
    configurable: true,
    writable: true,
  });

  /* ---- fake speech recognition ---- */
  class FakeRecognition {
    continuous = false;
    interimResults = false;
    maxAlternatives = 1;
    lang = '';
    started = false;
    onresult: ((e: unknown) => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;
    onend: (() => void) | null = null;
    onstart: (() => void) | null = null;

    start(): void {
      this.started = true;
      this.onstart?.();
    }
    stop(): void {
      this.started = false;
      this.onend?.();
    }
    abort(): void {
      this.started = false;
    }
    addEventListener(): void {}
    removeEventListener(): void {}
  }

  w.SpeechRecognition = FakeRecognition;
  w.webkitSpeechRecognition = FakeRecognition;

  /**
   * The app creates its recognition instance itself, so we cannot reach it
   * directly. Instead we keep the most recently created instance here and
   * let the test push a final result through it.
   */
  let latest: FakeRecognition | null = null;
  const originalStart = FakeRecognition.prototype.start;
  FakeRecognition.prototype.start = function patched(this: FakeRecognition): void {
    latest = this;
    originalStart.call(this);
  };
  w.__latestRecognition = () => latest;

  /* Simulate the player speaking a final phrase. */
  w.__speak = (text: string): boolean => {
    const rec = latest;
    if (!rec || !rec.onresult) return false;
    rec.onresult({
      resultIndex: 0,
      results: Object.assign(
        [
          Object.assign([{ transcript: text, confidence: 0.95 }], {
            isFinal: true,
            length: 1,
          }),
        ],
        { length: 1 },
      ),
    });
    return true;
  };
}

test.describe('voice chess end to end', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(installFakeSpeech);
    await page.goto('/');
  });

  test('loads, starts the engine, and plays a spoken move', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await expect(page.locator('#btn-start')).toBeVisible();
    await page.locator('#btn-start').click();

    // The engine must load (wasm over the worker) and greet us.
    await expect(page.locator('#status-text')).toHaveText('Listening', { timeout: 60_000 });

    const spoken = await page.evaluate(
      () => (window as never as { __spoken: string[] }).__spoken,
    );
    expect(spoken.join(' ')).toMatch(/welcome/i);

    // Say a move.
    await page.evaluate(() => (window as never as { __speak: (t: string) => boolean }).__speak('e4'));

    await expect(page.locator('#heard-text')).toHaveText('e4', { timeout: 10_000 });

    // The engine must answer and hand the turn back.
    await expect(page.locator('#turn')).toHaveText(/your move/i, { timeout: 60_000 });

    const spokenAfter = await page.evaluate(
      () => (window as never as { __spoken: string[] }).__spoken,
    );
    expect(spokenAfter.join(' ')).toMatch(/engine plays/i);

    expect(errors).toEqual([]);
  });

  test('renders the board', async ({ page }) => {
    await page.locator('#btn-start').click();
    await expect(page.locator('#status-text')).toHaveText('Listening', { timeout: 60_000 });
    await expect(page.locator('#board .square')).toHaveCount(64);
    // 32 pieces on the board at the start.
    await expect(page.locator('#board .piece')).toHaveCount(32);
  });

  test('the "read board" button produces spoken output', async ({ page }) => {
    await page.locator('#btn-start').click();
    await expect(page.locator('#status-text')).toHaveText('Listening', { timeout: 60_000 });
    await page.locator('#btn-read').click();
    await expect(page.locator('#said-text')).toContainText(/rank eight/i, { timeout: 10_000 });
  });

  test('speaking a move updates the board and the transcript', async ({ page }) => {
    await page.locator('#btn-start').click();
    await expect(page.locator('#status-text')).toHaveText('Listening', { timeout: 60_000 });

    await page.evaluate(() => (window as never as { __speak: (t: string) => boolean }).__speak('e4'));
    await expect(page.locator('#heard-text')).toHaveText('e4', { timeout: 10_000 });
    await expect(page.locator('#turn')).toHaveText(/your move/i, { timeout: 60_000 });

    // The board must now show a white pawn on e4.
    await expect(page.locator('#board [data-square="e4"] .piece')).toHaveText('♙');
  });
});
