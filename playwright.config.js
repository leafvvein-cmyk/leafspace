import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  globalSetup: './tests/e2e/setup.js',
  fullyParallel: false,
  // Chromium can exhaust Windows' local socket buffers when both device
  // projects request Vite's module graph at the same time. Keep the complete
  // desktop/mobile matrix, but run it serially on Windows for repeatability.
  workers: process.platform === 'win32' ? 1 : 2,
  timeout: 30000,
  expect: { timeout: 8000 },
  use: { baseURL: 'http://127.0.0.1:4175', channel: process.env.DIARY_E2E_CHANNEL || 'chrome', serviceWorkers: 'block', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 1000 } } },
    { name: 'mobile', use: { ...devices['Pixel 7'], timezoneId: 'Asia/Shanghai', viewport: { width: 390, height: 844 } } },
  ],
});
