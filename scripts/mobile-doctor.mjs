import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { NATIVE_APP_ACTIONS } from '../packages/contracts/src/app-actions.js';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function inspectMobileEnvironment(env = process.env, dependencies = {}) {
  const { exists = existsSync, read = readFileSync, list = readdirSync, run = spawnSync } = dependencies;
  const safeList = (path) => { try { return list(path); } catch { return []; } };
  const windows = process.platform === 'win32';
  const javaHome = env.DIARY_JAVA_HOME || (exists(join(root, '.tools/jdk-21/bin', windows ? 'java.exe' : 'java')) ? join(root, '.tools/jdk-21') : env.JAVA_HOME);
  const java = javaHome ? join(javaHome, 'bin', windows ? 'java.exe' : 'java') : 'java';
  const javaResult = run(java, ['-version'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  const javaOutput = `${javaResult.stdout ?? ''}${javaResult.stderr ?? ''}`;
  const javaVersion = Number(javaOutput.match(/version "(\d+)/)?.[1] ?? 0);
  const javac = javaHome ? join(javaHome, 'bin', windows ? 'javac.exe' : 'javac') : 'javac';
  const compilerResult = run(javac, ['-version'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  const compilerVersion = Number(`${compilerResult.stdout ?? ''}${compilerResult.stderr ?? ''}`.match(/javac (\d+)/)?.[1] ?? 0);
  const javaAvailable = javaResult.status === 0;
  const compilerAvailable = compilerResult.status === 0 && compilerVersion >= 21;
  const sdkHome = env.DIARY_ANDROID_SDK || env.ANDROID_HOME || env.ANDROID_SDK_ROOT || join(root, '.tools/android-sdk');
  const sdkExists = exists(sdkHome);
  const licenseDirectory = join(sdkHome, 'licenses');
  let licensesPresent = false;
  try { licensesPresent = read(join(licenseDirectory, 'android-sdk-license'), 'utf8').split(/\r?\n/).some((line) => /^[a-f0-9]{40}$/i.test(line.trim())); } catch { /* Missing/unreadable is not acceptance. */ }
  const platform36 = exists(join(sdkHome, 'platforms/android-36/android.jar'));
  const buildToolsRoot = join(sdkHome, 'build-tools');
  const buildTools = safeList(buildToolsRoot).filter((name) => exists(join(buildToolsRoot, name, windows ? 'aapt2.exe' : 'aapt2')));
  // AGP 8.13.0 in android/build.gradle selects 35.0.0 by default.
  const requiredBuildTools = '35.0.0';
  const missingBuildToolFiles = [windows ? 'aapt2.exe' : 'aapt2', windows ? 'zipalign.exe' : 'zipalign', 'lib/apksigner.jar', 'lib/d8.jar']
    .filter((name) => !exists(join(buildToolsRoot, requiredBuildTools, name)));
  const adb = join(sdkHome, 'platform-tools', windows ? 'adb.exe' : 'adb');
  const apk = join(root, 'apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk');
  const issues = [];
  const releaseGaps = [];
  const nativeAppActionCount = Object.keys(NATIVE_APP_ACTIONS).length;
  const appLauncherInstalled = exists(join(root, 'node_modules/@capacitor/app-launcher/package.json'))
    || exists(join(root, 'apps/mobile/node_modules/@capacitor/app-launcher/package.json'));
  const nativeAppActionsReady = nativeAppActionCount === 0 || appLauncherInstalled;
  const nativeApiBaseUrl = env.VITE_API_BASE_URL?.trim() || null;
  let nativeApiReady = false;
  if (nativeApiBaseUrl) {
    try {
      const url = new URL(nativeApiBaseUrl);
      nativeApiReady = url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash;
    } catch { /* Report the same bounded public URL rule below. */ }
  }
  if (!javaAvailable) issues.push('Java 启动失败或超时，不能仅凭版本输出判定可用。');
  if (javaVersion < 21) issues.push('需要 Java 21 或更高版本；可通过 DIARY_JAVA_HOME 指向独立安装目录。');
  if (!compilerAvailable) issues.push('需要可运行的 JDK 21+ javac 编译器，仅有 Java 运行时不够。');
  if (!sdkExists) issues.push('未发现 Android SDK；可通过 DIARY_ANDROID_SDK 指向已安装的 SDK。');
  if (!platform36) issues.push('缺少 Android SDK Platform 36。');
  if (missingBuildToolFiles.length) issues.push(`Build-Tools ${requiredBuildTools} 不完整，缺少：${missingBuildToolFiles.join('、')}。`);
  if (!exists(adb)) issues.push('缺少 platform-tools / adb，无法进行设备安装检查。');
  if (!licensesPresent) issues.push('未发现 SDK 许可证记录；须由使用者阅读并接受相关许可，不会自动代为接受。');
  if (!nativeApiReady) issues.push('原生 App 需要通过 VITE_API_BASE_URL 配置无凭据、无查询参数的 HTTPS API 地址。');
  if (!nativeAppActionCount) releaseGaps.push('尚未登记任何经产品确认的原生 App 快捷动作；不会显示任意 scheme 或包名输入入口。');
  if (!appLauncherInstalled) releaseGaps.push('尚未安装 @capacitor/app-launcher；登记原生 App 动作后必须先安装并同步该插件。');
  if (!nativeAppActionsReady) issues.push('已登记原生 App 动作，但 @capacitor/app-launcher 尚未安装，不能构建可用的 App 唤起功能。');
  const androidProject = [windows ? 'gradlew.bat' : 'gradlew', 'gradle/wrapper/gradle-wrapper.jar', 'gradle/wrapper/gradle-wrapper.properties', 'app/build.gradle']
    .every((name) => exists(join(root, 'apps/mobile/android', name)));
  if (!androidProject) issues.push('Android 工程或 Gradle Wrapper 文件不完整。');
  return {
    node: process.version, javaHome, javaVersion, javaAvailable, compilerVersion, compilerAvailable,
    sdkHome, sdkExists, platform36, buildTools, requiredBuildTools, missingBuildToolFiles, licensesPresent,
    nativeApiBaseUrl, nativeApiReady, nativeAppActionCount, appLauncherInstalled, nativeAppActionsReady, releaseGaps,
    androidProject,
    iosProject: exists(join(root, 'apps/mobile/ios/App/App.xcodeproj/project.pbxproj')),
    iosBuildHost: process.platform === 'darwin',
    adb: exists(adb) ? adb : null, apk: exists(apk) ? apk : null,
    issues, readyForAndroidBuildAttempt: issues.length === 0,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = inspectMobileEnvironment();
  console.log(JSON.stringify(report, null, 2));
  if (process.argv.includes('--check') && !report.readyForAndroidBuildAttempt) process.exitCode = 1;
}
