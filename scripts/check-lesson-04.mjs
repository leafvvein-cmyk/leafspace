import { strict as assert } from 'node:assert';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';

const root = resolve(fileURLToPath(new URL('../learning/lesson-04/', import.meta.url)));
const server = await createServer({ root, logLevel: 'silent', server: { host: '127.0.0.1', port: 0 } });
let browser;

try {
  await server.listen();
  const origin = server.resolvedUrls.local[0];
  browser = await chromium.launch({ channel: process.env.DIARY_E2E_CHANNEL || 'chrome', headless: true });

  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    const page = await browser.newPage({ viewport });
    await page.goto(origin);
    await page.getByRole('button', { name: '写日记' }).click();
    await page.getByLabel('标题').fill('第一次 JavaScript 练习');
    await page.getByLabel('正文').fill('按钮、函数和事件已经连接起来。');
    await page.getByRole('button', { name: '保存练习' }).click();
    assert.equal(await page.getByRole('heading', { name: '第一次 JavaScript 练习' }).textContent(), '第一次 JavaScript 练习');
    assert.match(await page.getByRole('status').textContent(), /保存 1 篇日记/);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
    await page.close();
  }

  console.log('Lesson 04 browser check: desktop and 390px mobile passed.');
} finally {
  await browser?.close();
  await server.close();
}
