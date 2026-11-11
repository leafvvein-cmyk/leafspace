import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/auth-browser',
  globalSetup: './tests/auth-browser/setup.js',
  fullyParallel: false,
  // The auth suite performs many navigations against Vite and the API. Two
  // simultaneous Chromium device projects intermittently hit
  // ERR_NO_BUFFER_SPACE/ERR_ADDRESS_IN_USE on Windows, before app code runs.
  workers: process.platform === 'win32' ? 1 : 2,
  timeout: 45000,
  expect: { timeout: 8000 },
  outputDir: 'test-results-auth',
  use: { baseURL: 'http://127.0.0.2:4174', channel: process.env.DIARY_E2E_CHANNEL || 'chrome', serviceWorkers: 'block', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } } },
    { name: 'mobile', use: { ...devices['Pixel 7'], viewport: { width: 390, height: 844 } } },
  ],
});
