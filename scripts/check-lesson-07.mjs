import { strict as assert } from 'node:assert';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';

const root = resolve(fileURLToPath(new URL('../learning/lesson-07/', import.meta.url)));
const server = await createServer({ root, logLevel: 'silent', server: { host: '127.0.0.1', port: 0 } });
let browser;

try {
  await server.listen();
  browser = await chromium.launch({ channel: process.env.DIARY_E2E_CHANNEL || 'chrome', headless: true });
  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    await page.goto(server.resolvedUrls.local[0]);
    await page.getByLabel('标题').fill('刷新后仍然存在');
    await page.getByLabel('正文').fill('这篇练习已经写入 localStorage。');
    await page.getByRole('button', { name: '保存到浏览器' }).click();
    assert.equal(await page.locator('.entry-card').count(), 1);
    await page.reload();
    assert.equal(await page.getByRole('heading', { name: '刷新后仍然存在' }).isVisible(), true);
    assert.match(await page.getByRole('status').textContent(), /恢复 1 篇/);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
    await page.evaluate(() => localStorage.setItem('diary-learning:lesson-07:v1', '{broken json'));
    await page.reload();
    assert.match(await page.getByRole('status').textContent(), /无法读取/);
    assert.equal(await page.locator('.entry-card').count(), 0);
    assert.equal(await page.evaluate(() => localStorage.getItem('diary-learning:lesson-07:v1')), null);
    await context.close();
  }
  console.log('Lesson 07 browser check: save, reload restore, corrupt-data recovery, desktop and mobile passed.');
} finally {
  await browser?.close();
  await server.close();
}
