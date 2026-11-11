import { strict as assert } from 'node:assert';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';

const root = resolve(fileURLToPath(new URL('../learning/lesson-05/', import.meta.url)));
const server = await createServer({ root, logLevel: 'silent', server: { host: '127.0.0.1', port: 0 } });
let browser;

try {
  await server.listen();
  browser = await chromium.launch({ channel: process.env.DIARY_E2E_CHANNEL || 'chrome', headless: true });
  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    const page = await browser.newPage({ viewport });
    await page.goto(server.resolvedUrls.local[0]);
    await page.getByRole('button', { name: '加入日记列表' }).click();
    assert.match(await page.getByRole('alert').textContent(), /标题和正文/);
    for (const [title, content] of [['第一篇', '学习对象。'], ['第二篇', '学习数组和循环。']]) {
      await page.getByLabel('标题').fill(title);
      await page.getByLabel('正文').fill(content);
      await page.getByRole('button', { name: '加入日记列表' }).click();
    }
    assert.equal(await page.locator('.entry-card').count(), 2);
    assert.equal(await page.locator('#entry-count').textContent(), '2 篇');
    assert.equal(await page.getByRole('heading', { name: '第二篇' }).isVisible(), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
    await page.getByRole('button', { name: '清空列表' }).click();
    assert.equal(await page.locator('.entry-card').count(), 0);
    assert.equal(await page.locator('#empty-state').isVisible(), true);
    await page.close();
  }
  console.log('Lesson 05 browser check: validation, two-entry rendering, clearing, desktop and mobile passed.');
} finally {
  await browser?.close();
  await server.close();
}
