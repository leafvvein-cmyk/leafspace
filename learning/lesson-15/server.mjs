import express from 'express';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory=dirname(fileURLToPath(import.meta.url)),publicDirectory=join(directory,'public');
export async function createLessonServer({host='127.0.0.1',port=4191}={}){const app=express();app.disable('x-powered-by');app.get('/api/ping',(request,response)=>response.json({data:{online:true,checkedAt:new Date().toISOString()}}));app.use(express.static(publicDirectory,{dotfiles:'deny',setHeaders(response,path){if(path.endsWith('sw.js'))response.setHeader('Cache-Control','no-cache');if(path.endsWith('manifest.webmanifest'))response.setHeader('Content-Type','application/manifest+json')}}));app.use((request,response)=>response.status(404).json({error:{code:'NOT_FOUND',message:'找不到这个资源'}}));const server=await new Promise((resolve,reject)=>{const instance=app.listen(port,host,()=>resolve(instance));instance.once('error',reject)});return{server,async close(){await new Promise(resolve=>server.close(resolve))}}}
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1]){const lesson=await createLessonServer();console.log(`Lesson 15: http://127.0.0.1:${lesson.server.address().port}`);const stop=async()=>{await lesson.close();process.exit(0)};process.once('SIGINT',stop);process.once('SIGTERM',stop)}
