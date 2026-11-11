# 第 15 课：PWA 安装与离线外壳

PWA（Progressive Web App）仍然是网站，但支持安装入口、独立窗口、离线应用外壳和受控更新。这一课让断网刷新后页面仍能打开，同时把私人文字留在 IndexedDB，不放进公共资源缓存。

配套目录：`learning/lesson-15`  
启动命令：`npm run learn:15`  
检查命令：`npm run check:learn:15`  
地址：`http://127.0.0.1:4191`

## 1. 本课三个核心概念

1. Web App Manifest：告诉浏览器安装后的名称、图标和窗口模式。
2. Service Worker：站点背后的网络代理，可拦截请求并返回缓存。
3. Cache Storage：只保存应用外壳，不保存账号响应或日记正文。

```text
浏览器请求页面
      ↓
Service Worker 是否已接管？
  ├─ 否：直接访问服务器
  └─ 是：根据请求类型选择策略
       ├─ 页面导航：网络优先，失败用缓存首页
       ├─ CSS/JS/图标：缓存优先
       └─ /api：只走网络，离线返回明确 503
```

## 2. PWA 不等于原生 App

PWA 可以安装到电脑或手机桌面，但它仍受浏览器能力和系统政策限制。它不是 Android APK，也不是 iOS IPA。

| 能力 | PWA | Capacitor 原生包 |
| --- | --- | --- |
| 桌面/主屏幕图标 | 支持 | 支持 |
| 独立窗口 | 支持 | 支持 |
| 应用商店安装 | 通常不直接提供 | 可提交商店 |
| 原生插件 | 浏览器允许的范围 | Capacitor 插件桥接 |
| iOS 构建环境 | 不需要 Xcode | 必须 Mac + Xcode |

第 16 课才学习 Capacitor。

## 3. Manifest 字段规则

页面通过下面的标签关联 Manifest：

```html
<link rel="manifest" href="/manifest.webmanifest">
<meta name="theme-color" content="#744f3b">
```

主要字段：

| 字段 | 含义 |
| --- | --- |
| `id` | 应用的稳定身份 |
| `name` | 完整应用名 |
| `short_name` | 图标空间不足时的短名称 |
| `start_url` | 从图标打开时进入的地址 |
| `scope` | PWA 能控制的路径范围 |
| `display` | `standalone` 表示独立窗口 |
| `theme_color` | 浏览器界面主题色 |
| `background_color` | 启动时的背景色 |
| `icons` | 安装图标列表 |

JSON 不能写注释，最后一个属性后面不能多写逗号。Manifest 地址和图标必须能正常访问。

正式产品通常同时准备 192×192 和 512×512 PNG，以及 maskable 图标。本课使用可缩放 SVG 便于读懂文件；不同平台的商店资产仍需单独制作和真机检查。

## 4. Service Worker 生命周期

注册：

```js
const registration = await navigator.serviceWorker.register('/sw.js');
await navigator.serviceWorker.ready;
```

生命周期：

1. `installing`：下载脚本并执行 `install`。
2. `installed` / `waiting`：新版本已准备，等待旧页面退出。
3. `activating`：切换版本并清理旧缓存。
4. `activated`：可以控制新的页面请求。

第一次注册成功并不表示当前页面立刻被控制。通常刷新一次后，`navigator.serviceWorker.controller` 才存在。

Service Worker 只能在 HTTPS 或本机 `localhost` / `127.0.0.1` 等安全上下文运行。普通局域网 HTTP 地址不满足正式要求。

## 5. install：预缓存应用外壳

```js
const SHELL = [
  '/',
  '/styles.css',
  '/app.js',
  '/manifest.webmanifest',
  '/icon.svg'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL))
  );
});
```

`event.waitUntil()` 告诉浏览器：这些异步工作完成前，不要把安装判断为成功。

如果任意必需文件下载失败，`cache.addAll()` 会让安装失败，不会留下一个缺文件却假装可离线的版本。

## 6. activate：清理旧缓存

缓存名必须带版本：

```js
const CACHE_NAME = 'diary-lesson-15-shell-v1';
```

新 Worker 激活时删除本应用的旧缓存，但不能粗暴删除这个域名下所有缓存，因为同源可能还有其他模块。

```js
names
  .filter(name => name.startsWith('diary-lesson-15-'))
  .filter(name => name !== CACHE_NAME)
```

`clients.claim()` 让新 Worker 尽快控制当前作用域中的页面。

## 7. fetch：不同资源使用不同策略

### 页面导航：网络优先

优先取得新页面，断网才退回缓存首页：

```js
fetch(event.request).catch(() => caches.match('/'))
```

### 静态外壳：缓存优先

CSS、JavaScript 和图标版本固定时先读缓存，速度快且可离线。

### API：网络专用

本课明确不缓存 `/api/`：

```js
if (url.pathname.startsWith('/api/')) {
  return fetch(event.request).catch(() => offline503);
}
```

缓存账号 API 响应容易造成严重问题：退出后仍显示旧私人内容、其他账号读到前一个账号数据、过期权限看起来仍有效。日记正文应存入按账号隔离的 IndexedDB/SQLite，并通过可靠同步协议更新，不应混入应用外壳缓存。

## 8. IndexedDB 与 Cache Storage 的分工

| 数据 | 存储位置 |
| --- | --- |
| HTML、CSS、JS、图标 | Cache Storage |
| 本机日记、草稿、待上传队列 | IndexedDB |
| 服务端日记 | 服务端数据库 |
| 会话令牌 | HttpOnly Cookie / 原生安全存储 |

清除浏览器站点数据通常会同时删除 Cache Storage、IndexedDB 和 Service Worker。因此重要日记仍要提供导出备份和已确认的云端同步。

## 9. 安装事件与平台差异

部分 Chromium 浏览器会触发 `beforeinstallprompt`。页面可以暂存事件，并在用户点击安装按钮时调用：

```js
await installPrompt.prompt();
const choice = await installPrompt.userChoice;
```

规则：

- 不能在用户没有操作时反复弹安装窗口。
- 不能保证每个浏览器都会触发该事件。
- iPhone Safari 使用“分享 → 添加到主屏幕”，不依赖这个事件。
- 已安装、浏览器策略限制或条件不满足时，应显示手动方式。

`display-mode: standalone` 媒体查询可判断当前是否在独立 PWA 窗口中运行。

## 10. 安全更新流程

新 Service Worker 下载完成后，不应在用户正在写日记时强制刷新。本课显示“新版本已经下载”，让用户点击“保存后更新”。

```js
registration.waiting.postMessage({ type: 'SKIP_WAITING' });
```

Worker 收到消息后调用 `skipWaiting()`，页面监听 `controllerchange` 再刷新。点击前先保存编辑内容到 IndexedDB。

生产产品还应防止多个标签同时编辑时直接更新，并清楚说明哪个版本正在运行。

## 11. 亲手实验

```powershell
npm run learn:15
```

打开 `http://127.0.0.1:4191`：

1. 等待页面显示离线外壳已缓存。
2. 刷新一次，让 Service Worker 接管。
3. 在便笺写内容并保存。
4. 打开开发者工具 → Network → Offline。
5. 刷新页面，确认页面和便笺仍出现。
6. 点击“检查 API 网络”，确认返回明确离线状态，而不是旧缓存响应。
7. 恢复 Online。
8. 从浏览器地址栏或菜单选择安装。

本机 `127.0.0.1` 只指向当前设备。手机访问自己的 `127.0.0.1` 不会连接到电脑。真机测试需要可访问的 HTTPS 地址和正确网络配置。

## 12. 常见错误

### 改了 sw.js 但页面一直是旧版

检查 Cache 名称、Worker 的 waiting 状态和更新按钮。开发时也可在 Application → Service Workers 查看当前版本。

### 把所有 GET 都缓存

这可能缓存 `/api/me`、账号日记或敏感查询。缓存策略必须按资源类型明确分流。

### install 中直接调用普通异步函数

如果没有放进 `event.waitUntil()`，浏览器可能在任务完成前终止 Worker。

### 每次打开都强制 skipWaiting

用户可能正在编辑旧页面，代码和数据结构突然切换。应先保存并让用户确认更新。

### 认为安装成功等于可离线写作

安装只改变启动方式。离线数据还需要 IndexedDB、Outbox 和同步协议，也就是第 14 课内容。

## 13. 自动检查

```powershell
npm run check:learn:15
```

检查：

- Manifest 的身份、作用域、独立窗口和图标字段。
- `sw.js` 使用 `no-cache` 更新响应头。
- Service Worker 成功接管页面。
- Cache Storage 包含应用外壳。
- Cache Storage 不包含任何 `/api/` 请求。
- 浏览器真正断网后仍能刷新打开。
- IndexedDB 便笺在断网刷新后仍存在。
- API 离线时返回明确状态。
- 电脑和 390px 手机布局无横向溢出。

自动测试不能替代不同品牌手机的安装菜单、图标裁切、系统窗口和更新行为检查，这些仍属于真机验收。

## 14. 完成检查表

- [ ] 能说明 Manifest、Service Worker 和 Cache Storage 各自作用。
- [ ] 能解释 Worker 第一次注册后为什么通常要刷新。
- [ ] 会区分导航、静态资源和 API 缓存策略。
- [ ] 不会缓存账号接口和日记正文。
- [ ] 知道 IndexedDB 与应用外壳缓存的分工。
- [ ] 会在开发者工具模拟断网并刷新。
- [ ] 知道 Chromium 与 iPhone 的安装方式不同。
- [ ] 知道更新前为什么必须先保存编辑内容。

下一课学习 Capacitor：把同一套 Web 资源放入 Android/iOS 原生容器，理解原生工程、插件权限、同步资源和真实安装包之间的边界。
