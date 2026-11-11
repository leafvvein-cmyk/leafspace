import { strict as assert } from 'node:assert';
import { chromium } from '@playwright/test';
import { createLessonServer } from '../learning/lesson-09/server.mjs';

const server = await createLessonServer({ port: 0 });
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;

try {
  let response = await fetch(`${origin}/api/entries`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.entries.length, 1);
  response = await fetch(`${origin}/api/entries`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
  assert.equal(response.status, 415);
  response = await fetch(`${origin}/api/entries`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: '', content: '' }) });
  assert.equal(response.status, 400);
  response = await fetch(`${origin}/missing`);
  assert.equal(response.status, 404);

  browser = await chromium.launch({ channel: process.env.DIARY_E2E_CHANNEL || 'chrome', headless: true });
  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    const page = await browser.newPage({ viewport });
    await page.goto(origin);
    await page.getByLabel('标题').fill(`HTTP 练习 ${viewport.width}`);
    await page.getByLabel('正文').fill('浏览器已经向 Node.js 服务器提交 JSON。');
    await page.getByRole('button', { name: 'POST 新日记' }).click();
    await page.getByRole('heading', { name: `HTTP 练习 ${viewport.width}` }).waitFor();
    assert.match(await page.locator('#request-status').textContent(), /HTTP 201/);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
    await page.close();
  }
  console.log('Lesson 09 check: HTTP 200/201/400/404/415, desktop and mobile browser flow passed.');
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
