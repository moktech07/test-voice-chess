import { expect, test } from '@playwright/test';

/**
 * End-to-end test of the whole voice loop in a real browser:
 *   speech recognition (faked) -> parse -> resolve -> engine -> speech synthesis (faked)
 *
 * The app is injected with fake speech APIs so the loop is fully deterministic.
 */
test.describe('voice chess end to end', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      const w = window as unknown as Record<string, unknown>;

      /* ---- fake speech synthesis ---- */
      const spoken: string[] = [];
      (w.__spoken as unknown) = spoken;
      w.speechSynthesis = {
        speaking: false,
        paused: false,
        pending: false,
        getVoices: () => [
          { name: 'Google US English', lang: 'en-US', default: true, localService: true },
        ],
        speak(
          utter: { text: string; onend?: () => void; onerror?: () => void },
        ): void {
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

      /* ---- fake speech recognition ---- */
      const handlers: {
        onresult?: (e: unknown) => void;
        onerror?: (e: unknown) => void;
        onend?: () => void;
        onstart?: () => void;
      } = {};

      class FakeRecognition {
        continuous = false;
        interimResults = false;
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

      /* helper the test calls to simulate the player speaking */
      w.__speak = (text: string) => {
        const rec = (w.__lastRecognition as FakeRecognition | undefined) ?? null;
        if (!rec || !rec.onresult) return false;
        rec.onresult({
          resultIndex: 0,
          results: Object.assign([[{ transcript: text, confidence: 0.95 }]], {
            length: 1,
            0: Object.assign([{ transcript: text, confidence: 0.95 }], { isFinal: true }),
          }),
        });
        return true;
      };
    });

    await page.goto('/');
  });

  test('loads, starts the engine, and plays a spoken move', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await expect(page.locator('#btn-start')).toBeVisible();
    await page.locator('#btn-start').click();

    // The engine must load (wasm over the worker) and greet us.
    await expect(page.locator('#status-text')).toHaveText('Listening', { timeout: 45_000 });

    const spoken = await page.evaluate(() => (window as never as { __spoken: string[] }).__spoken);
    expect(spoken.join(' ')).toMatch(/welcome/i);

    // Say a move.
    await page.evaluate(() => (window as never as { __speak: (t: string) => void }).__speak('e4'));

    await expect(page.locator('#heard-text')).toHaveText('e4', { timeout: 10_000 });
    await expect(page.locator('#turn')).toHaveText(/engine/i, { timeout: 10_000 });

    // The engine must answer and hand the turn back.
    await expect(page.locator('#turn')).toHaveText(/your move/i, { timeout: 30_000 });

    const spokenAfter = await page.evaluate(
      () => (window as never as { __spoken: string[] }).__spoken,
    );
    expect(spokenAfter.join(' ')).toMatch(/engine plays/i);

    expect(errors).toEqual([]);
  });

  test('renders the board', async ({ page }) => {
    await page.locator('#btn-start').click();
    await expect(page.locator('#status-text')).toHaveText('Listening', { timeout: 45_000 });
    await expect(page.locator('#board .square')).toHaveCount(64);
    // 32 pieces on the board at the start.
    await expect(page.locator('#board .piece')).toHaveCount(32);
  });

  test('the "read board" button produces spoken output', async ({ page }) => {
    await page.locator('#btn-start').click();
    await expect(page.locator('#status-text')).toHaveText('Listening', { timeout: 45_000 });
    await page.locator('#btn-read').click();
    await expect(page.locator('#said-text')).toContainText(/rank eight/i, { timeout: 10_000 });
  });
});
