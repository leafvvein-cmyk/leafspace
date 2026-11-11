import { strict as assert } from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from '@playwright/test';
import { createLessonServer } from '../learning/lesson-11/server.mjs';

const temporary=await mkdtemp(join(tmpdir(),'diary-lesson-11-')),databasePath=join(temporary,'lesson.sqlite');let lesson,browser;
try{
  lesson=await createLessonServer({port:0,databasePath});let origin=`http://127.0.0.1:${lesson.server.address().port}`;
  const injection=`'); DROP TABLE entries; --`;let response=await fetch(`${origin}/api/entries`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:injection,content:'参数化语句把它当作普通标题。'})});assert.equal(response.status,201);const created=(await response.json()).data.entry;await lesson.close();lesson=await createLessonServer({port:0,databasePath});origin=`http://127.0.0.1:${lesson.server.address().port}`;response=await fetch(`${origin}/api/entries`);const restored=(await response.json()).data.entries;assert.equal(restored.length,1);assert.equal(restored[0].title,injection);assert.equal((await fetch(`${origin}/api/entries/${created.id}`)).status,200);
  browser=await chromium.launch({channel:process.env.DIARY_E2E_CHANNEL||'chrome',headless:true});for(const viewport of[{width:1280,height:800},{width:390,height:844}]){const page=await browser.newPage({viewport});await page.goto(origin);const title=`SQLite 页面 ${viewport.width}`;await page.getByLabel('标题').fill(title);await page.getByLabel('正文').fill('这篇记录会真正写入临时 SQLite。');await page.getByRole('button',{name:'写入 SQLite'}).click();await page.getByRole('heading',{name:title}).waitFor();assert.match(await page.locator('#request-status').textContent(),/INSERT 事务已提交/);page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:`删除“${title}”`}).click();await page.getByRole('heading',{name:title}).waitFor({state:'detached'});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth),true);await page.close()}
  console.log('Lesson 11 check: migration, parameterized SQL, restart persistence, transactions, desktop and mobile passed.');
}finally{await browser?.close();await lesson?.close();await rm(temporary,{recursive:true,force:true})}
