# 第 16 课：Capacitor 移动应用

Capacitor 把构建后的 Web 页面放进 Android/iOS 原生容器，并通过插件调用相机、通知、安全存储和 SQLite。这一课直接使用项目已有的 `apps/mobile/android` 和 `apps/mobile/ios`，不创建假安装包。

环境检查页：`npm run learn:16`  
检查页地址：`http://127.0.0.1:4192`  
课程检查：`npm run check:learn:16`

## 1. 本课三个核心概念

1. 原生容器：Android WebView / iOS WKWebView 显示内置 Web 资源。
2. `cap sync`：把最新 Web 构建和插件配置同步进原生工程。
3. 原生插件与权限：只在真实设备、用户触发且插件可用时调用。

```text
apps/client/src           共用页面和业务代码
        ↓ npm run build:mobile
apps/client/dist-native   移动 Web 构建产物
        ↓ cap sync
apps/mobile/android/.../assets/public
apps/mobile/ios/App/App/public
        ↓ Android Gradle / Xcode
APK / iOS App
        ↓ 真机安装
权限、离线、同步、安全存储验收
```

每个箭头都是不同的完成状态。`cap sync` 成功不能证明 APK 已生成；APK 生成也不能证明真机功能全部通过。

## 2. Capacitor 配置字段

项目配置位于 `apps/mobile/capacitor.config.json`：

```json
{
  "appId": "com.diary.learning",
  "appName": "日记",
  "webDir": "../client/dist-native"
}
```

| 字段 | 规则 |
| --- | --- |
| `appId` | 反向域名式稳定包名，发布后不能随意改变 |
| `appName` | 手机上的应用显示名称 |
| `webDir` | Web 构建产物目录，不是源代码目录 |
| `backgroundColor` | 原生页面加载时背景色 |
| `server.hostname` | 内置页面的逻辑主机名 |
| `androidScheme` | Android WebView 的安全逻辑协议 |
| `iosScheme` | iOS Capacitor 自定义协议 |

本项目没有配置 `server.url`。发布 App 应加载打包进安装包的固定资源，而不是悄悄指向可随时变化的远程网页。

`allowMixedContent: false` 禁止 HTTPS 页面混用不安全 HTTP 资源。正式 API 地址必须是没有用户名、密码、查询参数和片段的 HTTPS 基础地址。

## 3. 四条 Capacitor 命令的区别

| 命令 | 作用 | 是否生成安装包 |
| --- | --- | --- |
| `cap add android` | 第一次创建 Android 工程 | 否 |
| `cap add ios` | 第一次创建 iOS 工程 | 否 |
| `cap sync` | 复制 Web 资源并更新插件依赖 | 否 |
| `cap open android/ios` | 打开 Android Studio / Xcode | 否 |

不要反复执行 `cap add` 覆盖已有原生工程。日常修改 Web 代码后执行项目封装命令：

```powershell
npm run mobile:sync
```

它依次完成品牌资源生成、移动 Web 构建和两端同步。

## 4. 判断当前是否为原生运行时

项目使用：

```js
import { Capacitor } from '@capacitor/core';

const platform = Capacitor.getPlatform();
const isNative = Capacitor.isNativePlatform();
```

常见平台值为 `web`、`android` 和 `ios`。不能根据屏幕宽度判断是否为 App：手机浏览器也是窄屏，电脑也能调整成窄屏。

调用插件前还要检查：

```js
if (!Capacitor.isNativePlatform()) {
  throw new Error('此功能仅在安装的手机 App 中使用。');
}

if (!Capacitor.isPluginAvailable('Camera')) {
  throw new Error('相机插件未正确安装。');
}
```

正式数据层不能在原生 SQLite 插件丢失时偷偷降级为浏览器存储，否则用户会看到另一个数据空间并误以为日记丢失。

## 5. 当前已同步的原生插件

Android 插件清单当前包含 9 项：

- 生物识别。
- 安全存储。
- SQLite。
- App 生命周期。
- 相机/相册。
- 文件系统。
- 键盘。
- 本地通知。
- 系统分享。

插件安装进工程只代表桥接代码存在，不代表设备权限已授予或能力可用。例如没有生物识别硬件、系统通知被关闭、相机被企业策略禁用时都必须显示真实错误。

## 6. 权限规则

权限要在用户触发对应功能时请求，不在 App 启动时一次索要全部：

| 功能 | 合理触发时机 |
| --- | --- |
| 相机 | 用户点击“拍照”并确认来源后 |
| 相册 | 用户点击“从相册选择”后 |
| 通知 | 用户开启提醒或保存带提醒待办时 |
| 生物识别 | 用户主动开启日记锁时 |

权限有 `prompt`、`granted`、`denied` 等状态。被永久拒绝后不能反复弹窗，应引导用户到系统设置。

相机和通知的系统提示文字还必须在 Android Manifest、iOS `Info.plist` 中按平台要求登记，并在真机上检查实际文案。

## 7. Web 与原生存储分工

| 环境 | 本机数据库 | 会话密钥 |
| --- | --- | --- |
| Web/PWA | IndexedDB | HttpOnly Cookie / 浏览器会话策略 |
| Android/iOS | Capacitor SQLite | 原生 Secure Storage / Keychain |

本项目的原生 SQLite 配置开启 Android/iOS 加密选项，但配置文字本身不是安全验收证据。仍要在真机验证密钥生成、锁屏后的访问策略、卸载行为、备份排除和数据库恢复。

## 8. 从网页资源到原生工程

执行：

```powershell
npm run mobile:sync
```

完成后至少检查：

- `apps/client/dist-native/index.html` 存在。
- Android `assets/public/index.html` 存在。
- iOS `App/public/index.html` 存在。
- HTML 引用的带哈希 JS/CSS 在三处都存在。
- Android 插件清单包含代码实际调用的插件。

第 16 课自动检查会比较这些当前构建资源，防止只看到旧目录存在就误判为同步完成。

## 9. Android 构建前置条件

项目的只读检查命令：

```powershell
npm run mobile:doctor
```

它检查：

- Java 与 `javac` 21+。
- Android SDK 目录。
- Platform 36。
- Build-Tools 35.0.0 的关键文件。
- Platform Tools / ADB。
- SDK 许可证记录。
- 原生 HTTPS API 地址。
- Android 工程完整性。
- 调试 APK 是否真实存在。

当前电脑已具备项目内 Java 21，但尚未检测到 Android SDK、Platform、Build-Tools、ADB、许可证记录和正式 HTTPS API 地址。因此 `readyForAndroidBuildAttempt` 为 `false`，目前没有 APK。

SDK 许可证必须由使用者阅读并接受，脚本不会替你自动同意。安装 SDK 也不应绕过电脑已配置的软件源或安全策略。

## 10. Android 调试包

环境完整后执行：

```powershell
npm run mobile:android
```

脚本先同步资源，再固定调用 Gradle Wrapper：

```text
gradlew.bat --no-daemon assembleDebug
```

只有命令退出码为 0，且下面文件真实存在且大小大于 0，才能说取得调试 APK：

```text
apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk
```

调试包不是应用商店发行包。发布还需要签名密钥保护、版本号、隐私声明、目标 API 合规、商店资料和发行测试。

## 11. iOS 构建

iOS 工程已经存在，但 Windows 不能构建 iOS App。需要 Mac、兼容版本的 Xcode、签名身份和 Provisioning Profile。

在 Mac 上同步后执行：

```powershell
npm run open:ios --workspace @diary/mobile
```

随后在 Xcode 选择 Team、Bundle Identifier、设备和签名。模拟器通过不等于真机通过，更不等于可提交 App Store。

## 12. 企业微信和其他 App 唤起

待办中的原生 App 动作必须使用产品白名单，不能让用户任意输入 URL Scheme 或 Android 包名。每个动作至少需要确认：

- 显示名称。
- Android 包名或受控 Intent。
- iOS URL Scheme / Universal Link。
- 参数允许列表。
- 目标 App 未安装时的行为。
- 用户点击前的提示。

目前产品尚未收到这些具体业务参数，因此动作目录为空；`@capacitor/app-launcher` 也尚未安装。网页仍支持站内页面和 HTTPS 链接，不会伪装成已能唤起企业微信。

## 13. 真机验收清单

安装包构建成功后，至少逐项检查：

- 首次启动、升级启动和完全离线启动。
- 账号密码登录、退出、恢复码重置。
- 新建、编辑、搜索、删除、回收站和同步冲突。
- 图片拍摄/选择、权限拒绝和大图失败恢复。
- 待办提醒的允许、拒绝、延迟和省电模式。
- 密码本加解密、锁定、恢复、备份和换钥。
- 生物识别不可用、失败和取消。
- 安全存储、锁屏、后台切换和截图策略。
- 无网、有网切换、请求超时和重复提交。
- 企业动作目标未安装和参数不合法。

没有真机证据时，结论应写“代码已接入/待真机验收”，不能写“功能已经完全可用”。

## 14. 环境检查页面

```powershell
npm run learn:16
```

打开 `http://127.0.0.1:4192`。页面实时读取当前电脑状态并分别显示：

- Java。
- Web 移动资源。
- Android/iOS 工程。
- Android SDK 构建门槛。
- APK 是否实际存在。
- Capacitor 安全配置。

它是教学和诊断页面，不是手机 App 预览器。

## 15. 自动检查

先同步，再检查：

```powershell
npm run mobile:sync
npm run check:learn:16
```

检查内容：

- `appId`、应用名、`webDir`。
- 禁止 mixed content 且没有远程 `server.url`。
- Android/iOS 工程存在。
- 9 个当前插件写入 Android 清单。
- 三处移动资源的 JS/CSS 引用实际存在。
- 环境诊断没有把缺少 SDK 说成可构建。
- 状态页面在电脑和 390px 手机宽度没有溢出。

该检查不会跳过许可证、伪造 SDK、制造空 APK，也不能替代 Mac/iOS 和 Android 真机验收。

## 16. 完成检查表

- [ ] 能解释 `build:mobile`、`cap sync` 和原生编译的区别。
- [ ] 知道 `appId`、`appName`、`webDir` 的作用。
- [ ] 不用屏幕宽度判断是否原生 App。
- [ ] 调插件前检查原生运行时和插件可用性。
- [ ] 只在用户触发功能时申请权限。
- [ ] 不把账号 API 和密钥存入普通缓存。
- [ ] 能阅读 `mobile:doctor` 的每个构建门槛。
- [ ] 不把工程存在或同步成功称为 APK/IPA 已完成。
- [ ] 知道 Android 调试包、发行包和真机验收的区别。
- [ ] 知道 iOS 构建必须使用 Mac/Xcode。

至此基础课程 01–16 形成完整路线：网页结构、样式、JavaScript、浏览器存储、HTTP、Express、SQLite、账号安全、Fetch、离线同步、PWA 和 Capacitor。课程完成不等于正式产品已经发布；产品仍应按开发验收台账完成外部环境、部署和真机门槛。
