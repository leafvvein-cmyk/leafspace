# 手机 App 开发与运行

## 1. 现在有什么，缺什么

2026-09-08 已生成真正的 Android Gradle 工程和 iOS Xcode/SPM 工程，并把本地前端构建资源同步进两套工程。它们不是手机网页截图，也不依赖电脑的 Vite 开发服务器来载入界面。

当前还没有 APK、AAB 或 IPA。2026-09-08 已在项目 `.tools/jdk-21` 独立安装 Temurin 21.0.12.1+1，通过官方 SHA-256 核对，并运行 `java -version` 和 `npm run mobile:doctor` 确认 Java 21 可用；未修改系统 Java 17、全局 PATH 或 JAVA_HOME。仍没有 Android SDK，已请求使用者阅读并确认 Android SDK 许可，在确认前不下载或接受 SDK。Gradle 编译尚未执行。iOS 还没有在 Mac/Xcode 上解析依赖、编译或签名。所有真机测试保持未完成。

2026-09-09 已只读检查 `C:\Users\PC\Desktop\工作目录\9月份\app打包`：其中是旧版 uni-app/HBuilder 说明、JDK 8 和多套归属不明的 keystore，没有 `adb`、`sdkmanager`、Android Platform 或 Build-Tools。JDK 8 不能替代本项目的 Java 21，未知证书也不得用于日记 App 签名。说明文件含明文账号凭据，应修改仍有效的密码并迁入安全密码本；本文不记录这些凭据。

Web 已接入账号密码登录和按账号隔离的本机空间，手机共用登录页面也已写入原生工程；没有短信验证码或 Apple 登录。App 仍需配置实际 HTTPS 后台并进行真机验证。账号日记的上传、下载、文字先行图片补传、冲突处理和显式学习数据迁移已接入代码并通过本地接口/浏览器测试，但不代表原生真机同步已验收。不要把当前版本用作唯一的正式日记备份。

## 2. 代码在哪里

| 路径 | 职责 |
| --- | --- |
| `apps/client/src/main.js` | 共用页面、导航和保存时机 |
| `apps/client/src/styles.css` | 电脑侧栏、手机底栏、全屏编辑、浅深色 |
| `apps/client/src/services/platform.js` | 识别 Web / Android / iOS，选择仓储，绑定原生返回键和后台事件 |
| `apps/client/src/services/local-store.js` | Web 的 IndexedDB 本机数据库 |
| `apps/client/src/services/sqlite-store.js` | 手机 SQLite 的日记、草稿、队列、冲突事务 |
| `apps/client/src/services/native-store.js` | 打开原生 SQLite 插件、复用连接、处理失败和关闭 |
| `apps/client/src/services/native-encryption.js` | 首次安装生成随机数据库密钥，交由插件保护；密钥缺失时不重建已有库 |
| `apps/client/src/services/secure-session-store.js` | 已接入手机登录的安全会话适配器；实际 HTTPS 登录仍待真机验证，禁止 Web 明文回退 |
| `apps/client/src/services/native-export.js` | 将用户主动导出的明文文件放入 App 私有缓存并打开系统分享 |
| `apps/client/src/services/native-image-picker.js` | 明确选择拍照或系统相册后读取一张图片，交给共用去元数据处理链 |
| `apps/client/src/services/device-reminders.js` | 每设备本地通知、权限、星期与时区调度 |
| `apps/client/src/services/task-reminders.js` | 待办的前台/原生本地通知、通用隐私文案、重排与去重 |
| `apps/client/src/services/device-lock.js` | 本机 PIN、空闲/后台锁定与防猜测延迟 |
| `apps/client/src/services/native-biometric.js` | 可选生物识别或设备锁屏凭据解锁，不保存生物特征 |
| `apps/mobile/capacitor.config.json` | App 标识、名称、内置网页目录和插件配置 |
| `apps/mobile/android` | Android 原生工程 |
| `apps/mobile/ios` | iOS 原生工程 |
| `scripts/mobile-doctor.mjs` | 只读检查构建环境 |
| `scripts/build-android.mjs` | 环境检查通过后调用工程自带 Gradle Wrapper |

`dist` 是 Web 构建结果，`dist-native` 是 App 内置页面结果，均由 Vite 生成，不手工编辑。`cap sync` 复制资源并更新原生插件配置，不代表原生编译成功。[Capacitor 开发流程](https://capacitorjs.com/docs/basics/workflow)

## 3. 关键规则与关键字

### `import` / `export`：让文件各管一件事

```js
// 文件 A：公开函数
export function describePlatform(name) {
  return name === 'web' ? '浏览器' : '手机 App';
}

// 文件 B：使用另一个文件公开的函数
import { describePlatform } from './platform-label.js';
```

`export` 表示这个函数可以被其他模块使用；`import` 引入它。`./` 从当前文件目录开始寻找。浏览器 ES Modules 的本地文件导入要写 `.js` 后缀；依赖包则用包名。教学片段用于理解语法，不是已经存在的 `platform-label.js`。

### `async` / `await` / `try...catch`：等保存完成，再说成功

```js
async function leaveEditor() {
  try {
    await editor.prepareLeave(); // 冻结输入，等待本机事务完成
    // 这里才切换页面
  } catch (error) {
    editor.resume();             // 失败后恢复输入
    showMessage(error.message); // 不显示“保存成功”
  }
}
```

`async` 函数返回 Promise；`await` 等待 Promise 成功或失败，不等于锁住整个界面。`try` 放可能失败的步骤，`catch` 处理异常。数据库、系统权限、磁盘空间都可能失败，所以不能只写成功路径。

### 平台判断：手机尺寸不等于原生 App

```js
import { Capacitor } from '@capacitor/core';

if (Capacitor.isNativePlatform()) {
  // 真正安装的 Android/iOS App：打开原生 SQLite。
} else {
  // 浏览器：打开 IndexedDB。
}
```

窗口宽度只决定布局，不决定数据是否在原生 SQLite 中。原生插件缺失时必须显示错误，不能悄悄改用浏览器数据库来“通过”检查。

### 事务：几张表一起成功，或一起失败

一次保存会影响日记、草稿、待同步标记。SQLite 事务把它们作为一个整体：`beginTransaction()` 开始，`commitTransaction()` 确认，`rollbackTransaction()` 回滚。事务内插件 `run(sql, values, false)` 的最后一个 `false` 表示不再另外开启嵌套事务。

SQL 数据值使用 `?` 占位符和参数数组，不把标题、中文正文或用户输入直接拼进 SQL。`PRAGMA busy_timeout` 会返回结果行，Android SQLCipher 需要用 `query()`，不能用只执行无结果语句的 `execute()`。

### 版本比较：不要让旧草稿覆盖新内容

`localRevision` 是设备本地修改次数；它不是云端确认的 `revision`。保存时比较原来读到的版本。发生冲突先提交双方副本，再报告冲突；如果在提交前抛错，事务会连恢复副本一起回滚。

页面只显示“已保存在此设备”，并不意味着“已同步到云端”。

## 4. 运行命令

在项目根目录执行：

```powershell
npm install
npm run dev
npm run mobile:doctor
npm run mobile:sync
```

`mobile:sync` 会先运行 `mobile:assets`，从统一的暖棕书本标志重新生成 PWA、Android 与 iOS 所需图标和启动图；再构建 `apps/client/dist-native`，最后更新 Android / iOS 内置资源和插件列表。网页仍可通过 `http://127.0.0.1:4173/today` 查看。

Android：安装并配置 Java 21 与 Android SDK Platform 36、Build-Tools、platform-tools。Android SDK 许可须由使用者阅读并接受；项目脚本不会自动执行“全部同意”。如使用自定义路径，可以给本次终端设置 `DIARY_JAVA_HOME` 和 `DIARY_ANDROID_SDK`，无需改动其他项目的全局配置。构建前还必须设置 `VITE_API_BASE_URL=https://你的域名/api/v1`；检查器拒绝 HTTP、用户名密码、查询参数或片段，避免生成一个无法登录或把凭据写进网址的安装包。[环境要求](https://capacitorjs.com/docs/getting-started/environment-setup)、[SDK 管理与许可](https://developer.android.com/tools/sdkmanager)

```powershell
npm run mobile:doctor
npm run mobile:android
```

只有 Gradle 成功后，才应检查 `apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk`。这是调试包，不能当作商店发行包。用 `adb devices -l` 核对已授权手机，实际安装后再验证；不能根据预期文件路径声称包已生成。

iOS：将完整源码与锁文件放到可用的 Mac，执行 `npm ci` 和 `npm run mobile:sync`，使用 Xcode 打开 `apps/mobile/ios/App/App.xcodeproj`。需要解析 SPM 依赖、配置自己的签名团队并编译；TestFlight / App Store 提交另行确认，不在 Windows 上假装完成。

`com.diary.learning` 目前仅为本地开发标识，公开发行前需确定正式 Bundle ID、签名和版本规则。

## 5. 当前验证边界

- 两套原生工程已生成；九个插件（SQLite、安全存储、App、相机、文件、键盘、本地通知、分享、生物识别）的配置和资源同步成功，不代表插件已在设备运行。
- SQLite 事务通过 Node 原生 SQLite 的真实 SQL 测试；原生连接和密钥部分还有明确标注的模拟插件契约测试，两者都不能替代 SQLCipher 真机检查。
- 加密代码已接入且没有源码固定密钥；数据库、Keychain/Keystore、卸载重装、恢复备份和图片文件的完整保护仍待两端真机验收。
- Android 关闭系统自动备份与明文 HTTP；FileProvider 只允许导出缓存子目录。相机/相册仅在明确点击后调用，权限拒绝、厂商照片格式和共享范围仍需真机检查。
- 导出文件是用户主动生成的明文；App 会在启动、回到前台和再次导出时尽力清理超过 24 小时的受控临时目录，但取消分享的精确反馈和分享后真正落盘仍需真机实测。
- 手机返回键按应用内来源返回，后台尽力补刷草稿；中文输入法、系统强杀和键盘遮挡仍需在安装包中检查。
- 登录、同步、相册入口、通知调度和日记锁代码已接入；PWA 真实安装更新、原生插件运行、安装包、正式部署与跨设备业务验收仍未完成。

2026-09-09 最新同步：`npm run mobile:sync` 已生成并检查 32 个品牌图标/启动图；iOS 应用图标和启动图明确输出为无 Alpha 的 RGB PNG，Android 仅在自适应前景与圆形旧图标中保留所需透明通道。随后把包含学习空间显式迁移、图片失败重试、文字先行补图、存储清理、时间线/搜索分批、搜索状态、外观设置、跨午夜原日期保护、版本审计、设备撤销未知结果保护、内容安全策略、键盘跳转正文和 44px 手机关键触控目标的页面重新写入 Android/iOS 工程；两端各识别 9 个插件且均关闭桥接调试日志。Web/手机布局自动化分别为写作与可访问性 56 项、账号 24 项，并覆盖 10,000 篇本地日记的时间线与搜索首屏各 50 项、单字/标点搜索、360px 窄屏、200% 等效重排、控件名称、减少动画、浅深色核心文字对比度、设备撤销未知响应，以及 3 秒慢同步时先本机保存、恢复后继续上传；PWA 另有 4 项离线、缓存边界、Chromium 安装性和 CSP 测试。但没有 Android SDK/adb/emulator，所以尚未生成或启动 APK，Windows 也不能生成 iOS IPA。

同日后续同步已把原生 SQLite schema 升级到 v3，并将待办表、独立待上传标记、本机完整备份 v3 和待办页面写入 Android/iOS 工程。桌面/手机视口写作、可访问性与待办套件现为 **58/58**，单元测试为 **302/302**；其中 Node 实际 SQLite 已验证迁移后的待办事务，但仍不等于 Android/iOS 插件在真机上完成迁移。Android SDK/adb/emulator 和 APK、iOS Mac/Xcode/签名与 IPA 仍未完成。

密码本后续同步已把原生 SQLite schema 升级到 v4，并将 Argon2id + AES-GCM 客户端加密、独立保险库密码、App/网站账号页面、端到端加密标签、本机强密码生成及风险筛选、密码查看 30 秒自动遮挡、单条损坏隔离、后台/闲置锁定、密文云同步、跨设备冲突选择、密码包装轮换及独立加密导出/空库恢复写入 Android/iOS 工程；通用日记同步现在会在远端数据提交后刷新非编辑页面，待办云同步、冲突选择、时区重复规则及本地通知排程也已同步。桌面/手机生产页面套件为 **60/60**，账号浏览器为 **40/40**，单元测试为 **327/327**，接口为 **71/71**，PWA 为 **4/4**；Node 实际 SQLite 和浏览器已验证密文不含测试服务名、账号或密码，普通日记备份也不包含密码本，独立备份可在隔离设备数据库验证恢复；桌面与手机流程还验证自动遮挡及一条密文被篡改时其余账号仍可读取，账号浏览器验证标签随密文跨设备同步及另一设备页面自动显示新随记。但尚未在 Android/iOS 真机验证 WebAssembly、SQLCipher、后台遮挡、剪贴板、系统分享/文件选择及待办通知的权限、省电、重启和点击行为，仍不得把当前版本当作唯一凭据副本。没有 Android SDK/adb/emulator，未生成 APK；Windows 不能生成 iOS IPA。

最新离线账号补充：用户必须在联网时提前设置本机 PIN。之后网络或响应异常时，才可用该 PIN 打开账号在本机的副本继续记录；明确收到 401 或会话撤销时不会放行。离线模式不上传、下载或执行账号安全操作，恢复联网后需重新登录。当前累计验证更新为桌面/手机生产页面 **60/60**、账号浏览器 **42/42**、单元测试 **329/329**、接口 **71/71**、PWA **4/4**；这些仍不是 Android/iOS 真机验收。

密码本恢复密钥已同步进入 Android/iOS 工程：新建时一次性显示 256 位密钥，旧密码本解锁后可生成；恢复或主动换发后旧密钥失效。恢复包装只以密文进入本机库、加密备份和云端配置，账号登录恢复码不能替代它。当前累计验证更新为桌面/手机页面 **60/60**、账号浏览器 **42/42**、单元测试 **330/330**、接口 **71/71**、PWA **4/4**；两端仍识别 9 个插件。此结果只证明共享页面和资源同步，尚未证明 Android/iOS 真机上的 WebAssembly、SQLCipher、安全存储、文件下载和后台清密钥行为。

密码本也已加入本机 TOTP：可选保存 Base32 密钥并生成 6/8 位、30/60 秒动态验证码，密钥随条目端到端加密，验证码在当前周期结束或密码本锁定时清除。RFC 6238 标准向量和桌面/手机页面流程已通过；当前单元测试为 **331/331**。共享代码已经同步到两端原生工程，但真机时钟偏差、后台遮挡和验证码复制仍需设备验收。

待办的原生 App 动作已经加入共享白名单和启动适配层，但产品白名单仍为空，因此页面不会出现不可执行的 App 动作入口。官方 `@capacitor/app-launcher` 安装被当前 npm 内网仓库连接超时阻断，原生工程仍只有 9 个插件。取得企业微信等动作的固定 Android/iOS 参数并恢复依赖仓库后，还需安装插件、同步工程、写入 Android `queries`/iOS scheme 查询声明并做真机验证；不得把当前基础设施描述为已经能唤起企业微信。

2026-09-10 已将密码本完整数据密钥轮换同步进 Android/iOS 内置资源：准备阶段先认证全部旧密文，持久任务使用固定请求编号分批上传，只有用户保存并确认新恢复密钥后才激活；服务端完成单事务提交后，本机 SQLite 才原子切换配置与全部记录。当前回归为单元测试 **341/341（34 文件）**、接口 **73/73（5 文件）**、桌面/手机页面 **60/60**、账号浏览器 **44/44**、PWA **4/4**；隔离备份恢复演练校验 **16** 项迁移。共享资源与九个插件已经同步，但 Android SDK/adb/emulator 仍缺失，未生成 APK；Windows 不能生成 iOS IPA。以上不代表真实 Keychain/Keystore、SQLCipher、WebAssembly 性能、后台清密钥、剪贴板或跨网络恢复已经在设备验收。
