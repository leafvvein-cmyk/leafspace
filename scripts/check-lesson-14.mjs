import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from '@playwright/test';
import { createLessonServer } from '../learning/lesson-14/server.mjs';

const temporary=await mkdtemp(join(tmpdir(),'diary-lesson-14-'));let lesson,browser;
const mutation=(origin,body)=>fetch(`${origin}/api/mutations`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
try{
  lesson=await createLessonServer({port:0,databasePath:join(temporary,'lesson.sqlite')});const origin=`http://127.0.0.1:${lesson.server.address().port}`;
  let snapshot=await (await fetch(`${origin}/api/snapshot`)).json();assert.equal(snapshot.data.serverRevision,1);assert.equal(snapshot.data.entries.length,1);
  const id=randomUUID(),clientRequestId=randomUUID(),job={clientRequestId,operation:'upsert',entry:{id,entryDate:'2026-09-09',title:'幂等日记',content:'重复请求只能创建一次。',baseRevision:0}};
  let response=await mutation(origin,job);assert.equal(response.status,201);let first=await response.json();response=await mutation(origin,job);assert.equal(response.status,200);let replay=await response.json();assert.equal(replay.meta.replayed,true);assert.deepEqual(replay.data,first.data);
  snapshot=await (await fetch(`${origin}/api/snapshot`)).json();assert.equal(snapshot.data.entries.filter(entry=>entry.id===id).length,1);
  response=await mutation(origin,{clientRequestId:randomUUID(),operation:'upsert',entry:{...job.entry,title:'过期修改',baseRevision:0}});assert.equal(response.status,409);let conflict=await response.json();assert.equal(conflict.error.code,'REVISION_CONFLICT');assert.equal(conflict.error.details.current.title,'幂等日记');

  browser=await chromium.launch({channel:process.env.DIARY_E2E_CHANNEL||'chrome',headless:true});
  for(const viewport of[{width:1280,height:800},{width:390,height:844}]){const context=await browser.newContext({viewport});const page=await context.newPage();await page.goto(origin);await page.getByText('离线同步从这里开始').waitFor();await page.getByRole('button',{name:'暂停联网请求'}).click();const title=`离线日记 ${viewport.width}`;await page.getByLabel('标题').fill(title);await page.getByLabel('正文').fill('先写入 IndexedDB，稍后再同步。');await page.getByRole('button',{name:'先保存到本机'}).click();const card=page.locator('.entry').filter({hasText:title});await card.getByText('待同步').waitFor();assert.equal(await page.evaluate(()=>new Promise((resolve,reject)=>{const r=indexedDB.open('diary-lesson-14');r.onsuccess=()=>{const q=r.result.transaction('outbox').objectStore('outbox').count();q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error)};r.onerror=()=>reject(r.error)})),1);await page.getByRole('button',{name:'恢复联网并同步'}).click();await card.getByText('已同步').waitFor();await page.reload();await page.getByText(title).waitFor();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth),true);await context.close()}
  snapshot=await (await fetch(`${origin}/api/snapshot`)).json();assert.equal(snapshot.data.entries.some(entry=>entry.title==='离线日记 1280'),true);assert.equal(snapshot.data.entries.some(entry=>entry.title==='离线日记 390'),true);
  console.log('Lesson 14 check: local outbox, offline-first save, idempotent replay, conflict guard, reconnect sync, desktop and mobile passed.');
}finally{await browser?.close();await lesson?.close();await rm(temporary,{recursive:true,force:true})}
