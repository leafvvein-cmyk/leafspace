import express from 'express';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectMobileEnvironment, root } from '../../scripts/mobile-doctor.mjs';

const directory=dirname(fileURLToPath(import.meta.url));
function status(){const report=inspectMobileEnvironment();const config=JSON.parse(readFileSync(join(root,'apps/mobile/capacitor.config.json'),'utf8'));return{...report,config:{appId:config.appId,appName:config.appName,webDir:config.webDir,allowMixedContent:config.android?.allowMixedContent,hasRemoteServer:Boolean(config.server?.url)},assets:{web:existsSync(join(root,'apps/client/dist-native/index.html')),android:existsSync(join(root,'apps/mobile/android/app/src/main/assets/public/index.html')),ios:existsSync(join(root,'apps/mobile/ios/App/App/public/index.html'))}}}
export async function createLessonServer({host='127.0.0.1',port=4192}={}){const app=express();app.disable('x-powered-by');app.get('/api/status',(request,response)=>response.json({data:status()}));app.use(express.static(join(directory,'public'),{dotfiles:'deny'}));app.use((request,response)=>response.status(404).json({error:{code:'NOT_FOUND',message:'找不到这个资源'}}));const server=await new Promise((resolve,reject)=>{const instance=app.listen(port,host,()=>resolve(instance));instance.once('error',reject)});return{server,async close(){await new Promise(resolve=>server.close(resolve))}}}
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1]){const lesson=await createLessonServer();console.log(`Lesson 16: http://127.0.0.1:${lesson.server.address().port}`);const stop=async()=>{await lesson.close();process.exit(0)};process.once('SIGINT',stop);process.once('SIGTERM',stop)}
