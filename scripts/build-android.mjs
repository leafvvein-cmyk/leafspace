import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { inspectMobileEnvironment, root } from './mobile-doctor.mjs';

const report = inspectMobileEnvironment();
if (!report.readyForAndroidBuildAttempt) {
  console.error('Android 安装包尚未生成，构建前需要完成：\n' + report.issues.map((issue) => `- ${issue}`).join('\n'));
  process.exitCode = 1;
} else {
  const cwd = join(root, 'apps/mobile/android');
  const env = { ...process.env, JAVA_HOME: report.javaHome, ANDROID_HOME: report.sdkHome, ANDROID_SDK_ROOT: report.sdkHome };
  // Fixed build command only; credentials are never command-line arguments.
  const child = process.platform === 'win32'
    ? spawn('cmd.exe', ['/d', '/c', 'gradlew.bat --no-daemon assembleDebug'], { cwd, env, stdio: 'inherit', windowsHide: true })
    : spawn('./gradlew', ['--no-daemon', 'assembleDebug'], { cwd, env, stdio: 'inherit' });
  child.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
  child.on('exit', (code) => {
    const path = join(cwd, 'app/build/outputs/apk/debug/app-debug.apk');
    if (code === 0 && existsSync(path) && statSync(path).size > 0) console.log(`Android 调试安装包：${path}\n还需真机安装与功能验收；不是已签名发行包。`);
    else { console.error('未取得成功构建的 Android 安装包。'); process.exitCode = code || 1; }
  });
}
