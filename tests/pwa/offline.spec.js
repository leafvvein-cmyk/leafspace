import { test, expect } from '@playwright/test';

test('production PWA keeps saved local writing available after an offline reload', async ({ page, context }) => {
  await page.goto('/today?date=2026-09-18');
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise((resolve) => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
  });
  await page.getByRole('textbox', { name: '日记标题' }).fill('断网也能打开');
  await page.getByRole('textbox', { name: '日记正文' }).fill('这段文字先保存在 IndexedDB。');
  await expect(page.getByRole('status').filter({ hasText: '已保存在此设备' })).toBeVisible();
  const shell = await page.evaluate(async () => {
    const path = new URL(document.querySelector('script[type="module"]').src).pathname;
    return { path, controlled: Boolean(navigator.serviceWorker.controller), cached: Boolean(await caches.match(path)) };
  });
  expect(shell).toMatchObject({ controlled: true, cached: true });
  await context.setOffline(true);
  expect(await page.evaluate(async (path) => (await fetch(path)).status, shell.path)).toBe(200);
  await page.reload();
  await expect(page.getByRole('textbox', { name: '日记标题' })).toHaveValue('断网也能打开');
  await expect(page.getByRole('textbox', { name: '日记正文' })).toContainText('这段文字先保存在 IndexedDB。');
  await page.goto('/timeline');
  await expect(page.getByRole('heading', { name: '断网也能打开' })).toBeVisible();
});

test('production PWA precaches only its static shell and never an API response', async ({ page }) => {
  await page.goto('/settings/about');
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  const apiStatus = await page.evaluate(async () => (await fetch('/api/v1/meta')).status);
  expect(apiStatus).toBe(401);
  const audit = await page.evaluate(async () => {
    const rows = [];
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      rows.push(...(await cache.keys()).map((request) => new URL(request.url).pathname));
    }
    return rows;
  });
  expect(audit).toContain('/index.html');
  expect(audit).toContain('/diary-icon-192.png');
  expect(audit).toContain('/diary-icon-512.png');
  expect(audit.some((path) => path.startsWith('/api/'))).toBe(false);
  expect(await page.locator('link[rel="manifest"]').getAttribute('href')).toBe('/manifest.webmanifest');
  expect(await page.locator('link[rel="apple-touch-icon"]').getAttribute('href')).toBe('/diary-icon-192.png');
});

test('production PWA has no Chromium installability errors outside the isolated test context', async ({ page, context }) => {
  await page.goto('/settings/about');
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  const session = await context.newCDPSession(page);
  const manifest = await session.send('Page.getAppManifest');
  expect(manifest.errors).toEqual([]);
  const result = await session.send('Page.getInstallabilityErrors');
  // Playwright's ordinary browser contexts are incognito-style temporary
  // profiles. Chromium cannot install an app there, so audit every other
  // installability condition and keep that harness-only limitation explicit.
  expect(result.installabilityErrors.filter(({ errorId }) => errorId !== 'in-incognito')).toEqual([]);
  expect(result.installabilityErrors.map(({ errorId }) => errorId)).toEqual(['in-incognito']);
});

test('production document applies the private-content security policy', async ({ page }) => {
  await page.goto('/today');
  const policy = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
  expect(policy).toContain("default-src 'self'");
  expect(policy).toContain("object-src 'none'");
  expect(policy).toContain("frame-src 'none'");
  expect(policy).toContain("form-action 'self'");
  expect(policy).not.toContain("script-src 'self' 'unsafe-inline'");
});
