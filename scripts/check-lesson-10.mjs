import { strict as assert } from 'node:assert';
import { chromium } from '@playwright/test';
import { createLessonServer } from '../learning/lesson-10/server.mjs';

const server = await createLessonServer({ port: 0 });
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;

try {
  let response = await fetch(`${origin}/api/entries`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('x-request-id'), /^[0-9a-f-]{36}$/);
  let body = await response.json();
  const seedId = body.data.entries[0].id;
  response = await fetch(`${origin}/api/entries`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'API 创建', content: '由 Express Router 创建。' }) });
  assert.equal(response.status, 201);
  body = await response.json();
  const createdId = body.data.entry.id;
  response = await fetch(`${origin}/api/entries/${createdId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'API 已修改' }) });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.entry.revision, 2);
  response = await fetch(`${origin}/api/entries/${createdId}`, { method: 'DELETE' });
  assert.equal(response.status, 204);
  response = await fetch(`${origin}/api/entries/${createdId}`);
  assert.equal(response.status, 404);
  response = await fetch(`${origin}/server.mjs`);
  assert.equal(response.status, 404);

  browser = await chromium.launch({ channel: process.env.DIARY_E2E_CHANNEL || 'chrome', headless: true });
  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    const page = await browser.newPage({ viewport });
    await page.goto(origin);
    const title = `Express 页面 ${viewport.width}`;
    await page.getByLabel('标题').fill(title);
    await page.getByLabel('正文').fill('中间件、路由和错误处理已经连接。');
    await page.getByRole('button', { name: '创建日记' }).click();
    await page.getByRole('heading', { name: title }).waitFor();
    assert.match(await page.locator('#request-status').textContent(), /HTTP 201.*requestId/);
    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: `删除“${title}”` }).click();
    await page.getByRole('heading', { name: title }).waitFor({ state: 'detached' });
    assert.match(await page.locator('#request-status').textContent(), /HTTP 204/);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
    await page.close();
  }
  assert.equal((await fetch(`${origin}/api/entries/${seedId}`)).status, 200);
  console.log('Lesson 10 check: CRUD, request IDs, centralized errors, source isolation, desktop and mobile passed.');
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
