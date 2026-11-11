# 第 09 课：Node.js 与 HTTP

## 1. 本课目标

本课学习三个概念：

1. Node.js 如何在浏览器外运行 JavaScript。
2. HTTP 请求与响应由方法、地址、状态码、头和正文组成。
3. 浏览器如何通过 `fetch()` 调用 JSON API。

启动：

```powershell
npm run learn:09
```

打开 <http://127.0.0.1:4185>。自动检查：

```powershell
npm run check:learn:09
```

服务器只监听 `127.0.0.1`，数据只在内存中，重启即清空。

## 2. Node.js 是什么

浏览器里的 JavaScript 可以操作网页；Node.js 让 JavaScript 在操作系统进程中运行，可以监听网络端口、读取文件和连接数据库。

```powershell
node --version
node server.mjs
```

`.mjs` 明确表示 ES module。当前项目根目录也使用 `"type": "module"`，普通 `.js` 同样按模块处理。

## 3. 客户端和服务器

```text
浏览器（客户端）
  → 发送 HTTP 请求
Node.js（服务器）
  → 读取方法、路径、头和正文
  → 执行业务规则
  → 返回 HTTP 状态码、响应头和正文
浏览器
  → 读取响应并更新页面
```

页面看见“保存成功”必须来自真实响应，不能在请求发出前假定服务器成功。

## 4. 建立 HTTP 服务器

```js
import { createServer } from 'node:http';

const server = createServer((request, response) => {
  response.end('Hello');
});

server.listen(4185, '127.0.0.1');
```

- `request` 表示这次请求。
- `response` 用于构造响应。
- 端口让同一台电脑区分不同网络服务。
- `127.0.0.1` 是回环地址，只能从本机访问。

## 5. URL 和路由

```js
const url = new URL(request.url, `http://${request.headers.host}`);

if (url.pathname === '/api/entries') {
  // 处理日记接口
}
```

路由是“方法 + 路径”到处理逻辑的映射。查询参数在 `url.searchParams`，不要用字符串切割手写解析 URL。

## 6. HTTP 方法

| 方法 | 常见含义 |
| --- | --- |
| GET | 读取资源，不应修改数据 |
| POST | 创建资源或执行操作 |
| PUT | 用完整表示创建/替换指定资源 |
| PATCH | 修改部分字段 |
| DELETE | 删除指定资源 |

本课 `/api/entries` 支持 GET 和 POST。其他方法返回 405，并提供 `Allow: GET, POST`。

## 7. 状态码

| 状态码 | 含义 |
| --- | --- |
| 200 | 请求成功并返回数据 |
| 201 | 创建成功 |
| 400 | 请求正文或业务字段无效 |
| 404 | 路径不存在 |
| 405 | 路径存在，但方法不允许 |
| 413 | 请求体过大 |
| 415 | Content-Type 不支持 |
| 500 | 未预期服务器错误 |

不能所有响应都返回 200 再把错误藏在文字里。状态码让浏览器、监控和调用方可靠判断结果类别。

## 8. JSON 响应

```js
function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  response.end(body);
}
```

`Buffer.byteLength()` 计算 UTF-8 字节数；中文字符不能用 JavaScript 字符数冒充网络字节数。

私人 API 使用 `Cache-Control: no-store`，避免共享缓存错误保留响应。

## 9. 统一响应结构

成功：

```json
{"data":{"entries":[]}}
```

失败：

```json
{"error":{"code":"VALIDATION_FAILED","message":"标题不符合规则"}}
```

稳定错误码用于程序判断，中文消息用于当前用户理解。不要把数据库错误、堆栈、密码或令牌直接返回客户端。

## 10. 读取请求体

Node HTTP 请求是异步字节流：

```js
const chunks = [];
for await (const chunk of request) {
  chunks.push(chunk);
}
const text = Buffer.concat(chunks).toString('utf8');
```

必须在读取过程中累计字节并限制大小，否则攻击者可以发送无限正文消耗内存。本课限制为 32 KiB。

## 11. Content-Type

```js
if (request.headers['content-type'] !== 'application/json') {
  // 返回 415
}
```

Content-Type 说明请求正文格式。真实服务通常允许 `application/json; charset=utf-8` 等规范参数，使用可靠解析器处理；本课固定精确值以便观察。

## 12. 服务器再次验证

```js
function validInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const title = typeof value.title === 'string' ? value.title.trim() : '';
  const content = typeof value.content === 'string' ? value.content.trim() : '';
  if (title.length < 2 || content.length < 5) return null;
  return { title, content };
}
```

即使浏览器已验证，服务器仍不信任请求。正式项目使用共享 schema，避免网页和 API 规则漂移。

## 13. fetch()

读取：

```js
const response = await fetch('/api/entries');
const body = await response.json();
```

创建：

```js
const response = await fetch('/api/entries', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ title, content }),
});
```

`fetch()` 只有网络层失败时才自动抛错；HTTP 400、404、500 仍会返回 Response，所以必须检查 `response.ok` 或 `response.status`。

## 14. async 和 await

```js
async function loadEntries() {
  const response = await fetch('/api/entries');
  const body = await response.json();
  return body.data.entries;
}
```

- `async` 函数总是返回 Promise。
- `await` 等待 Promise 完成，但不会阻塞整个服务器或浏览器线程。
- 错误使用 `try...catch` 处理。

不要忘记 await：否则拿到的是 Promise，不是最终 JSON 数据。

## 15. 同源与 CORS

本课 HTML 和 API 都来自同一个 `http://127.0.0.1:4185`，属于同源，不需要 CORS。

协议、主机或端口任一不同就是不同来源。正式 App 使用 HTTPS API，并只允许批准来源；不能为了方便设置任意 `Access-Control-Allow-Origin: *` 再携带私人凭据。

## 16. 内存数据的限制

本课数组存在服务器进程内：

- 重启即丢失。
- 多个进程不共享。
- 没有账号隔离。
- 没有事务、版本或并发保护。
- 不能用于生产日记。

第 11 课会进入 SQL；正式项目使用 PostgreSQL 和迁移。

## 17. 安全关闭

```js
const stop = () => server.close(() => process.exit(0));
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
```

Ctrl+C 会触发 SIGINT。先停止接收请求并关闭服务器，再退出进程。正式服务还要等待数据库连接、worker 和正在执行的任务。

## 18. 常见错误

### 只判断路径，不判断方法

GET 和 POST 语义不同，应明确分支并对其他方法返回 405。

### 所有错误返回 500

无效输入是 400，不存在是 404，正文过大是 413。500 只用于未预期服务器失败。

### 不限制请求体

读取流时累计字节并在超限时停止处理。

### fetch 不检查 response.ok

HTTP 错误不会自动被当成网络异常抛出。

### 返回内部错误堆栈

客户端只需要稳定错误码和安全消息；详细堆栈留在受控服务器日志。

### 把内存数组称为数据库

它没有持久化和事务，重启后数据必然丢失。

## 19. 本课关键字

| 关键字 | 含义 |
| --- | --- |
| runtime | 执行程序的运行环境 |
| client | 发起请求的客户端 |
| server | 接收请求并返回响应的服务器 |
| HTTP | Web 请求与响应协议 |
| method | GET、POST 等操作语义 |
| route | 方法和路径对应的处理逻辑 |
| status code | 表示响应结果类别的数字 |
| header | 请求或响应元数据 |
| body | 请求或响应正文 |
| Content-Type | 正文数据格式 |
| JSON API | 使用 JSON 交换结构化数据的接口 |
| Promise | 表示未来完成或失败的异步结果 |
| async/await | 编写异步流程的语法 |
| same-origin | 协议、主机、端口均相同 |
| CORS | 浏览器跨来源请求许可机制 |

## 20. 动手任务

1. 启动服务器，在浏览器 Network 面板查看 GET 请求和 200 响应。
2. 创建一篇记录，查看 POST 请求体和 201 响应。
3. 在地址栏访问 `/missing`，观察 404 JSON。
4. 用开发工具修改请求字段，确认服务器仍会验证。
5. 增加 `GET /api/health`，返回 `{data:{status:'ok'}}`。
6. 增加按 ID 读取的路由，并正确处理不存在的 ID。
7. 运行自动检查。

## 21. 完成检查表

- [ ] 能解释客户端与服务器的区别。
- [ ] 路由同时检查方法和路径。
- [ ] 成功创建返回 201。
- [ ] 不存在返回 404，方法错误返回 405。
- [ ] 请求体有字节大小限制。
- [ ] Content-Type 不正确会被拒绝。
- [ ] 服务器再次验证所有业务字段。
- [ ] fetch 后检查 response.ok。
- [ ] 私人响应使用 no-store。
- [ ] 明白内存数组不是持久数据库。
- [ ] API 与双视口浏览器检查通过。

## 22. 思考题与参考答案

1. Node.js 与浏览器中的 JavaScript 有什么不同？
   - 都执行 JavaScript，但 Node 可监听端口、读文件和连接数据库；浏览器提供 DOM 并受页面安全边界限制。
2. 为什么创建成功使用 201？
   - 它明确表示请求成功创建了新资源，比通用 200 更准确。
3. fetch 遇到 HTTP 400 会自动抛错吗？
   - 通常不会，仍需检查 response.ok 或 status。
4. 为什么读取请求体要限制字节数？
   - 防止过大请求耗尽服务器内存，也建立明确接口边界。
5. 为什么浏览器验证后服务器还要验证？
   - 页面能被绕过或修改，服务器不能信任客户端输入。
6. 本课数据为什么重启后消失？
   - 它只保存在服务器进程内存数组中，没有写入数据库。

下一课将使用 Express 拆分路由、中间件和错误处理，让接口结构更适合继续扩展。
