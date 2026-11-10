import { defineConfig } from '@playwright/test';

/**
 * Visual + behavioural suite for the web showcase (VS-082).
 *
 * The showcase provider is development-web only (`src/lib/demo/showcase-mode.ts`
 * answers false unless `__DEV__`), so this drives Expo's web dev server rather
 * than the static export: a `--dev` export is server-rendered without showcase
 * data and hydrates against it, which throws the mismatch overlay over every
 * pixel we came to check.
 *
 * One phone-sized viewport, one browser, one worker: these are screenshots and
 * shared modal state, not a parallel load test.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 180_000,
  expect: {
    timeout: 20_000,
    toHaveScreenshot: {
      // Animation is disabled per assertion; anything still moving is masked.
      animations: 'disabled',
      caret: 'hide',
      maxDiffPixelRatio: 0.002,
    },
  },
  snapshotPathTemplate: '{testDir}/__screenshots__/{testFilePath}/{arg}-{platform}{ext}',
  reporter: [['list']],
  use: {
    baseURL: process.env.SHOWCASE_URL ?? 'http://localhost:8093',
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 1,
    colorScheme: 'dark',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    // SHOWCASE_URL lets a developer point the suite at a server already running
    // (`npm run web`), instead of paying for a second Metro boot.
    command: `npx expo start --web --port ${new URL(process.env.SHOWCASE_URL ?? 'http://localhost:8093').port}`,
    url: process.env.SHOWCASE_URL ?? 'http://localhost:8093',
    reuseExistingServer: true,
    timeout: 300_000,
    env: { CI: '1' },
  },
});
