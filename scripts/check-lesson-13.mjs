import { strict as assert } from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from '@playwright/test';
import { createLessonServer } from '../learning/lesson-13/server.mjs';

const temporary = await mkdtemp(join(tmpdir(), 'diary-lesson-13-'));
let lesson, browser;
const post = (origin, path, data, cookie) => fetch(`${origin}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(data) });
try {
  lesson = await createLessonServer({ port: 0, databasePath: join(temporary, 'lesson.sqlite') });
  const origin = `http://127.0.0.1:${lesson.server.address().port}`;
  assert.equal((await fetch(`${origin}/api/entries`)).status, 401);
  assert.equal((await post(origin, '/api/login', { username: 'diary_student', password: 'wrong-password' })).status, 401);
  let response = await post(origin, '/api/login', { username: 'diary_student', password: 'learn-fetch-2026!' });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('set-cookie'), /HttpOnly.*SameSite=Strict/i);
  const cookie = response.headers.get('set-cookie').split(';')[0];
  response = await fetch(`${origin}/api/entries`, { headers: { Cookie: cookie } });
  assert.equal(response.status, 200);
  let body = await response.json(); assert.equal(body.data.entries.length, 2);
  response = await post(origin, '/api/entries', { entryDate: '2026-09-09', title: '自动检查日记', content: '由测试通过 Fetch 写入。' }, cookie);
  assert.equal(response.status, 201);
  body = await (await fetch(`${origin}/api/entries`, { headers: { Cookie: cookie } })).json();
  assert.equal(body.data.entries.length, 3); assert.equal(body.data.entries[0].title, '自动检查日记');
  assert.equal((await post(origin, '/api/entries', { entryDate: 'bad', title: '', content: '' }, cookie)).status, 400);

  browser = await chromium.launch({ channel: process.env.DIARY_E2E_CHANNEL || 'chrome', headless: true });
  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    const page = await browser.newPage({ viewport }); const title = `浏览器 Fetch ${viewport.width}`;
    await page.goto(origin); await page.getByRole('button', { name: '登录并读取日记' }).click();
    await page.getByRole('heading', { name: /diary_student 的服务端日记/ }).waitFor();
    await page.getByText('第一次连接 API').waitFor();
    await page.getByLabel('标题').fill(title); await page.getByLabel('正文').fill('电脑和手机宽度都应能读取服务端响应。');
    await page.getByRole('button', { name: '发送到 API' }).click(); await page.getByText(title).waitFor();
    await page.reload(); await page.getByText(title).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
    await page.close();
  }
  console.log('Lesson 13 check: auth, Fetch GET/POST, SQLite persistence, validation, desktop and mobile passed.');
} finally { await browser?.close(); await lesson?.close(); await rm(temporary, { recursive: true, force: true }); }
