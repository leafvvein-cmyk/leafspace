import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/pwa',
  globalSetup: './tests/pwa/setup.js',
  fullyParallel: false,
  workers: 1,
  timeout: 45000,
  expect: { timeout: 10000 },
  use: { ...devices['Desktop Chrome'], baseURL: 'http://127.0.0.1:4180', channel: process.env.DIARY_E2E_CHANNEL || 'chrome', serviceWorkers: 'allow', trace: 'retain-on-failure' },
});
