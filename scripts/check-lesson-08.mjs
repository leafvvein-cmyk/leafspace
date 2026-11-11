import { strict as assert } from 'node:assert';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';

const root = resolve(fileURLToPath(new URL('../learning/lesson-08/', import.meta.url)));
const server = await createServer({ root, logLevel: 'silent', server: { host: '127.0.0.1', port: 0 } });
let browser;

try {
  await server.listen();
  browser = await chromium.launch({ channel: process.env.DIARY_E2E_CHANNEL || 'chrome', headless: true });
  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    const page = await browser.newPage({ viewport });
    await page.goto(server.resolvedUrls.local[0]);
    assert.equal(await page.locator('.entry-card').count(), 6);
    await page.getByLabel('搜索标题、正文或标签').fill('雨');
    await page.waitForTimeout(350);
    assert.equal(await page.locator('.entry-card').count(), 1);
    await page.getByLabel('搜索标题、正文或标签').fill('C++');
    await page.waitForTimeout(350);
    assert.equal(await page.getByRole('heading', { name: '学习 C++' }).isVisible(), true);
    await page.getByRole('button', { name: '清除筛选' }).click();
    await page.getByLabel('标签', { exact: true }).selectOption('学习');
    assert.equal(await page.locator('.entry-card').count(), 2);
    await page.getByLabel('开始日期').fill('2026-09-09');
    assert.equal(await page.locator('.entry-card').count(), 0);
    assert.equal(await page.locator('#empty-state').isVisible(), true);
    await page.getByLabel('结束日期').fill('2026-09-01');
    assert.match(await page.getByRole('alert').textContent(), /开始日期不能晚于/);
    await page.getByRole('button', { name: '清除筛选' }).click();
    assert.equal(await page.locator('.entry-card').count(), 6);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
    await page.close();
  }
  console.log('Lesson 08 browser check: Chinese/literal search, tags, dates, empty/error states, desktop and mobile passed.');
} finally {
  await browser?.close();
  await server.close();
}
