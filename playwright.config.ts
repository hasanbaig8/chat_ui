import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright configuration for Claude Chat UI tests.
 *
 * Run `npm run test:e2e` for headless tests
 * Run `npm run test:e2e:headed` for visible browser
 * Run `npm run test:e2e:ui` for interactive UI mode
 */
export default defineConfig({
  testDir: './tests/e2e',

  // Ignore smoke tests in regular runs (they need real API)
  testIgnore: process.env.MOCK_LLM ? ['**/smoke.spec.ts'] : [],

  // Maximum time one test can run
  timeout: 30 * 1000,

  // Expect timeout
  expect: {
    timeout: 5000,
    // Visual comparison settings
    toHaveScreenshot: {
      maxDiffPixels: 100,
    },
  },

  // Run tests in parallel
  fullyParallel: true,

  // Fail the build on CI if you accidentally left test.only in the source code
  forbidOnly: !!process.env.CI,

  // Retry on CI only
  retries: process.env.CI ? 2 : 0,

  // Limit parallel workers on CI
  workers: process.env.CI ? 1 : undefined,

  // Reporter to use
  reporter: [
    ['html', { open: 'never' }],
    ['list'],
  ],

  // Shared settings for all tests
  use: {
    // Base URL for the app
    baseURL: 'http://localhost:8079',

    // Collect trace when retrying the failed test
    trace: 'on-first-retry',

    // Screenshot on failure
    screenshot: 'only-on-failure',

    // Video on failure
    video: 'on-first-retry',
  },

  // Configure projects for major browsers
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    // Uncomment for additional browser testing
    // {
    //   name: 'firefox',
    //   use: { ...devices['Desktop Firefox'] },
    // },
    // {
    //   name: 'webkit',
    //   use: { ...devices['Desktop Safari'] },
    // },
  ],

  // Run your local dev server before starting the tests
  webServer: {
    command: process.env.MOCK_LLM ? 'bash -c "source .venv/bin/activate && MOCK_LLM=1 python3 app.py"' : 'bash -c "source .venv/bin/activate && python3 app.py"',
    url: 'http://localhost:8079',
    reuseExistingServer: !process.env.CI,
    timeout: 120 * 1000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
