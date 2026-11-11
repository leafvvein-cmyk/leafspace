import { strict as assert } from 'node:assert';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';

const root = resolve(fileURLToPath(new URL('../learning/lesson-06/', import.meta.url)));
const server = await createServer({ root, logLevel: 'silent', server: { host: '127.0.0.1', port: 0 } });
let browser;

try {
  await server.listen();
  browser = await chromium.launch({ channel: process.env.DIARY_E2E_CHANNEL || 'chrome', headless: true });
  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    const page = await browser.newPage({ viewport });
    await page.goto(server.resolvedUrls.local[0]);
    await page.getByRole('button', { name: '验证并保存' }).click();
    assert.match(await page.locator('#title-error').textContent(), /至少需要 2/);
    assert.equal(await page.locator('#entry-title').getAttribute('aria-invalid'), 'true');
    await page.getByLabel(/标题/).fill('验证练习');
    await page.getByLabel(/正文/).fill('这些字段已经通过明确规则检查。');
    await page.getByLabel('平静').check();
    assert.equal(await page.locator('#content-count').textContent(), '15 / 5000');
    await page.getByRole('button', { name: '验证并保存' }).click();
    assert.equal(await page.getByRole('heading', { name: '验证练习' }).isVisible(), true);
    assert.equal(await page.locator('#result-mood').textContent(), '平静');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
    await page.close();
  }
  console.log('Lesson 06 browser check: accessible errors, valid save, desktop and mobile passed.');
} finally {
  await browser?.close();
  await server.close();
}
