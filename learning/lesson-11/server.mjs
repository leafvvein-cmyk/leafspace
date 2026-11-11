import express from 'express';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from './database.mjs';

const directory=dirname(fileURLToPath(import.meta.url)),publicDirectory=join(directory,'public');
class ApiError extends Error{constructor(status,code,message){super(message);Object.assign(this,{status,code})}}
function valid(value){if(!value||typeof value!=='object'||Array.isArray(value))throw new ApiError(400,'VALIDATION_FAILED','正文必须是对象');const title=typeof value.title==='string'?value.title.trim():'',content=typeof value.content==='string'?value.content.trim():'';if(title.length<2||title.length>80||content.length<5||content.length>5000)throw new ApiError(400,'VALIDATION_FAILED','标题需 2–80 字符，正文需 5–5000 字符');return{title,content}}
const view=row=>({id:row.id,title:row.title,content:row.content,entryDate:row.entry_date,revision:row.revision,createdAt:row.created_at,updatedAt:row.updated_at});

export function createLessonApp(database){
  const app=express();app.disable('x-powered-by');app.use(express.json({limit:'32kb'}));app.use(express.static(publicDirectory,{dotfiles:'deny'}));
  const list=database.prepare('SELECT * FROM entries ORDER BY entry_date DESC,created_at DESC');
  const find=database.prepare('SELECT * FROM entries WHERE id=?');
  const insert=database.prepare('INSERT INTO entries(id,title,content,entry_date,created_at,updated_at) VALUES(?,?,?,?,?,?)');
  const remove=database.prepare('DELETE FROM entries WHERE id=?');
  const router=express.Router();
  router.get('/entries',(request,response)=>response.json({data:{entries:list.all().map(view)}}));
  router.get('/entries/:id',(request,response)=>{const row=find.get(request.params.id);if(!row)throw new ApiError(404,'ENTRY_NOT_FOUND','找不到这篇练习日记');response.json({data:{entry:view(row)}})});
  router.post('/entries',(request,response)=>{const input=valid(request.body),id=randomUUID(),now=new Date().toISOString(),date=new Date().toLocaleDateString('en-CA');database.exec('BEGIN IMMEDIATE');try{insert.run(id,input.title,input.content,date,now,now);database.exec('COMMIT')}catch(error){database.exec('ROLLBACK');throw error}response.status(201).json({data:{entry:view(find.get(id))}})});
  router.delete('/entries/:id',(request,response)=>{database.exec('BEGIN IMMEDIATE');try{const result=remove.run(request.params.id);if(!result.changes)throw new ApiError(404,'ENTRY_NOT_FOUND','找不到这篇练习日记');database.exec('COMMIT')}catch(error){database.exec('ROLLBACK');throw error}response.status(204).end()});
  app.use('/api',router);app.use((request,response,next)=>next(new ApiError(404,'NOT_FOUND','找不到这个地址')));app.use((error,request,response,next)=>{if(response.headersSent)return next(error);const status=error.type==='entity.too.large'?413:error.status||500;response.status(status).json({error:{code:error.type==='entity.too.large'?'BODY_TOO_LARGE':error.code||'SERVER_ERROR',message:status>=500?'数据库暂时无法处理请求':error.message}})});return app
}

export async function createLessonServer({host='127.0.0.1',port=4187,databasePath}={}){
  const path=databasePath??join(directory,'data','lesson-11.sqlite');if(path!==':memory:')await mkdir(dirname(path),{recursive:true});const database=openDatabase(path),app=createLessonApp(database);const server=await new Promise((resolve,reject)=>{const instance=app.listen(port,host,()=>resolve(instance));instance.once('error',reject)});let closed=false;return{server,database,async close(){if(closed)return;closed=true;await new Promise(resolve=>server.close(resolve));database.close()}}
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1]){const lesson=await createLessonServer();console.log(`Lesson 11: http://127.0.0.1:${lesson.server.address().port}`);const stop=async()=>{await lesson.close();process.exit(0)};process.once('SIGINT',stop);process.once('SIGTERM',stop)}
