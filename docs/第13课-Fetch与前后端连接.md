# 第 13 课：Fetch 与前后端连接

这一课把前面已经学过的网页、Express、SQLite 和账号会话连接起来。完成后，页面显示的日记来自服务端数据库，不是写死的 HTML，也不是当前浏览器的 `localStorage`。

配套目录：`learning/lesson-13`  
启动命令：`npm run learn:13`  
检查命令：`npm run check:learn:13`  
地址：`http://127.0.0.1:4189`

> 这是隔离的教学数据库和公开练习账号，不能存放真实隐私内容。正式产品使用另一套 API、数据库和安全配置。

## 1. 本课只学三个核心概念

1. `fetch()`：浏览器发送 HTTP 请求。
2. `async` / `await`：等待异步请求完成。
3. 页面状态：加载中、成功、空数据和失败都必须有明确显示。

完整链路如下：

```text
点击“重新请求”
      ↓
client.js 调用 fetch('/api/entries')
      ↓
Express 检查 HttpOnly 会话 Cookie
      ↓
使用 user_id 参数化查询 SQLite
      ↓
返回 JSON 和 HTTP 200
      ↓
JavaScript 创建日记卡片
```

## 2. Fetch 基本规则

最小 GET 请求：

```js
const response = await fetch('/api/entries');
const body = await response.json();
```

`fetch()` 得到的是 `Response`，不是直接得到日记数组。必须再读取响应体。

### 重要属性和方法

| 写法 | 含义 |
| --- | --- |
| `response.ok` | 状态码是否在 200–299 |
| `response.status` | HTTP 状态码，例如 200、401、500 |
| `response.json()` | 把 JSON 响应体解析成对象 |
| `response.text()` | 把响应体读取成字符串 |
| `credentials` | Cookie 凭据策略 |
| `headers` | 请求头，例如 JSON 类型 |

`fetch()` 遇到 404 或 500 时通常不会自动抛错，所以必须检查 `response.ok`：

```js
if (!response.ok) {
  throw new Error(`请求失败：${response.status}`);
}
```

只有断网、DNS 失败或请求被浏览器阻止等网络级错误，`fetch()` 本身才会拒绝 Promise。

## 3. POST JSON 的规则

发送一篇新日记：

```js
const response = await fetch('/api/entries', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    entryDate: '2026-09-09',
    title: '今天的标题',
    content: '今天的正文'
  })
});
```

关键字说明：

- `method`：请求方法。读取通常用 GET，创建通常用 POST。
- `Content-Type`：告诉服务器正文是 JSON。
- `JSON.stringify()`：把 JavaScript 对象转换成 JSON 字符串。
- `body`：HTTP 请求正文；GET 不应携带业务正文。

少写 `JSON.stringify()` 会把对象变成错误内容；少写 `Content-Type`，Express 可能不会按 JSON 解析。

## 4. async 与 await

网络请求不会立刻完成。`async` 表示函数会进行异步工作，`await` 表示先等待右侧 Promise 完成，再继续执行后面的语句。

```js
async function loadEntries() {
  const response = await fetch('/api/entries');
  const body = await response.json();
  renderEntries(body.data.entries);
}
```

规则：

- 普通函数里不能直接使用 `await`。
- `async` 函数永远返回 Promise。
- 请求可能失败，应使用 `try / catch / finally`。
- `finally` 适合恢复按钮状态，无论成功还是失败都会执行。

```js
button.disabled = true;
try {
  await saveEntry();
} catch (error) {
  showError(error.message);
} finally {
  button.disabled = false;
}
```

## 5. 为什么要封装 request()

如果每个按钮都重复检查状态码、解析 JSON 和读取错误，代码容易不一致。本课统一放在 `request()` 中：

```js
async function request(path, options = {}) {
  const response = await fetch(path, options);
  const body = response.status === 204 ? null : await response.json();
  if (!response.ok) throw new Error(body?.error?.message || '请求失败');
  return body?.data;
}
```

可选链 `?.` 表示左侧不存在时返回 `undefined`，避免读取空对象属性时报错。`||` 在左侧为空值时使用后备文字。

## 6. 登录 Cookie 如何参与请求

登录成功后，服务端返回 `Set-Cookie`。本课 Cookie 设置了：

- `HttpOnly`：页面 JavaScript 不能读取令牌。
- `SameSite=Strict`：减少跨站请求携带 Cookie。
- `Path=/`：同一站点路径可使用。
- 有效期 1 天。

页面请求同源地址时，浏览器自动带上 Cookie。本课仍明确写出：

```js
credentials: 'same-origin'
```

“同源”要求协议、主机名和端口都一致。`http://127.0.0.1:4189` 与 `http://127.0.0.1:4173` 不是同源，因为端口不同。

生产 HTTPS 环境还必须为会话 Cookie 增加 `Secure`，并结合 CSRF 防护、限速、日志和会话清理。本课服务仅监听本机回环地址。

## 7. 服务端如何隔离账号数据

API 不接受客户端传来的 `userId` 作为数据归属依据，而是从会话查出当前用户：

```js
const user = requireUser(request);
const entries = statement.all(user.id);
```

SQL 使用参数占位符：

```sql
SELECT id, title, content
FROM entries
WHERE user_id = ?
ORDER BY entry_date DESC;
```

客户端即使伪造 `userId` 字段，也不能改变查询里的账号编号。这是多账号数据隔离的基础。

## 8. 四种页面状态

只处理“成功”会让用户在慢网或错误时不知发生了什么。

| 状态 | 页面应该显示 |
| --- | --- |
| loading | 正在从 API 读取 |
| success | 返回数量和日记列表 |
| empty | 服务端还没有日记 |
| error | 失败原因和可重试入口 |

使用 `textContent` 写入标题和正文，不能把服务端文字直接拼进 `innerHTML`，否则恶意 HTML 可能执行脚本。

## 9. HTTP 状态码速查

| 状态码 | 本课含义 |
| --- | --- |
| 200 | 登录、读取成功 |
| 201 | 日记创建成功 |
| 204 | 退出成功且没有响应正文 |
| 400 | 输入不符合规则 |
| 401 | 未登录或账号密码错误 |
| 404 | API 路径不存在 |
| 500 | 服务端意外错误；不向页面泄露内部细节 |

## 10. 亲手运行

在项目目录执行：

```powershell
npm run learn:13
```

打开 `http://127.0.0.1:4189`，使用页面显示的练习账号登录。然后：

1. 按 F12 打开开发者工具。
2. 打开 Network。
3. 点击“重新请求”。
4. 找到 `GET /api/entries`。
5. 查看 Request Headers、状态码和 Response JSON。
6. 新增一篇日记，观察 `POST /api/entries` 返回 201。
7. 刷新页面，确认日记仍由服务端返回。

## 11. 常见错误

### 页面报 `Unexpected token`

通常是把 HTML 错误页当作 JSON 解析。先看 Network 中的响应内容和 `Content-Type`。

### 返回 401

登录 Cookie 不存在、已过期，或请求发往不同源。重新登录并确认端口。

### POST 后服务器读不到正文

检查 `Content-Type: application/json`、`JSON.stringify()` 和 `express.json()` 是否同时存在。

### 数据重复显示

每次重新渲染前应调用 `replaceChildren()` 清空旧节点，而不是持续追加同一批结果。

### 在页面直接显示服务器错误堆栈

不要这样做。服务端应返回稳定的错误码和安全文字，详细堆栈只写入受保护的服务端日志。

## 12. 自动检查覆盖范围

执行：

```powershell
npm run check:learn:13
```

检查包括：

- 未登录读取返回 401。
- 错误和正确密码的响应不同。
- 会话 Cookie 包含 HttpOnly 和 SameSite。
- GET 返回 SQLite 中两篇种子日记。
- POST 返回 201，并能再次 GET 到新日记。
- 无效输入返回 400。
- 电脑与 390px 手机宽度可以登录、读取、新增并刷新恢复。
- 页面没有横向溢出。

## 13. 本课完成检查表

- [ ] 能解释 `fetch()` 返回的是 `Response`。
- [ ] 知道为什么要检查 `response.ok`。
- [ ] 会发送包含 JSON 的 POST 请求。
- [ ] 能说出 `async`、`await`、`try/catch/finally` 的作用。
- [ ] 能在 Network 面板找到 GET 和 POST。
- [ ] 能区分 200、201、400、401 和 500。
- [ ] 知道账号归属必须来自服务端会话。
- [ ] 知道加载、空数据和错误状态不能省略。

下一课将学习离线缓存和同步：先把操作可靠地保存在当前设备，再联网上传，并识别冲突，而不是把“请求已发送”误认为“云端已经保存”。
