import { defineConfig } from '@playwright/test';

/**
 * The browser is already downloaded on this machine, so we point Playwright at
 * it directly rather than downloading a new one.
 */
const CHROME = '/home/swiphy/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    headless: true,
    launchOptions: {
      executablePath: CHROME,
      args: [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        // The mic is faked, but getUserMedia still needs a permissive origin.
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
      ],
    },
  },
  webServer: {
    command: 'npm run build && npm run preview',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
