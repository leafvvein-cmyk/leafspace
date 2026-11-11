# 第 10 课：Express 路由、中间件与错误处理

## 1. 本课目标

本课学习三个概念：

1. 使用 Router 按资源组织 CRUD 路由。
2. 使用中间件处理所有请求共有的工作。
3. 使用统一错误中间件输出稳定 JSON 错误。

```powershell
npm run learn:10
```

打开 <http://127.0.0.1:4186>。自动检查：

```powershell
npm run check:learn:10
```

数据仍在内存，重启清空；课程 11 才进入数据库。

## 2. Express 解决什么问题

Node 原生 HTTP 能完成所有工作，但随着接口增加，方法/路径判断、JSON 解析和错误响应会重复。Express 提供路由和中间件组合机制：

```js
import express from 'express';
const app = express();
app.use(express.json({ limit: '32kb' }));
app.get('/api/entries', handler);
```

Express 不会自动解决业务验证、账号隔离、事务、幂等或权限；这些仍需明确实现。

## 3. 中间件

```js
app.use((request, response, next) => {
  response.set('X-Request-ID', crypto.randomUUID());
  next();
});
```

中间件按注册顺序执行。调用 `next()` 才把控制交给下一个中间件或路由；已经发送响应时不再调用 next。

典型中间件负责请求编号、日志上下文、JSON 解析、认证、安全响应头和错误处理。

## 4. 请求编号

```js
response.locals.requestId = randomUUID();
response.set('X-Request-ID', response.locals.requestId);
```

`response.locals` 保存本次请求内部共享的数据。请求编号进入响应头和 JSON meta，用户报告错误时可以提供它；编号不能包含密码或用户内容。

## 5. Router

```js
const router = express.Router();
router.get('/entries', listEntries);
router.post('/entries', createEntry);
app.use('/api', router);
```

挂载后完整路径是 `/api/entries`。Router 让认证、日记、待办等资源按模块拆分，而不是把全部处理器放在一个文件。

## 6. CRUD 路由

| 操作 | 方法与路径 | 成功状态 |
| --- | --- | --- |
| Create | POST `/api/entries` | 201 |
| Read list | GET `/api/entries` | 200 |
| Read one | GET `/api/entries/:id` | 200 |
| Update | PATCH `/api/entries/:id` | 200 |
| Delete | DELETE `/api/entries/:id` | 204 |

`:id` 是路径参数，通过 `request.params.id` 读取。

## 7. 读取请求数据

```js
request.params.id;       // 路径参数
request.query.tag;       // ?tag=work 查询参数
request.body.title;      // JSON 正文
request.get('X-Token');  // 请求头
```

所有值都来自客户端，必须验证。路径参数也不能直接拼进 SQL。

## 8. JSON 解析和大小限制

```js
app.use(express.json({
  limit: '32kb',
  type: 'application/json',
}));
```

解析器应在需要 `request.body` 的路由之前注册。限制正文大小能防止意外或恶意大请求占用内存。

正式应用对普通 JSON、批量 mutation 和图片二进制使用不同上限，不能用一个无限制解析器覆盖所有内容。

## 9. 自定义 ApiError

```js
class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
```

业务处理器只描述错误：

```js
if (!entry) {
  throw new ApiError(404, 'ENTRY_NOT_FOUND', '找不到这篇练习日记');
}
```

最终 JSON 格式由统一错误中间件负责。

## 10. 错误中间件为什么有四个参数

```js
app.use((error, request, response, next) => {
  response.status(error.status || 500).json({
    error: { code: error.code || 'SERVER_ERROR' },
  });
});
```

Express 通过四个参数识别错误中间件。它必须放在路由之后。若响应头已发送，应调用 `next(error)` 交给 Express 关闭连接，不能再次发送 JSON。

## 11. 404 处理器

```js
app.use((request, response, next) => {
  next(new ApiError(404, 'NOT_FOUND', '找不到这个地址'));
});
```

它放在所有有效路由之后、错误中间件之前。404 不是服务器崩溃，而是没有任何路由处理该请求。

## 12. 不泄露内部错误

```js
const message = status >= 500
  ? '服务器暂时无法处理请求'
  : error.message;
```

500 响应不返回数据库语句、文件路径、堆栈或秘密。受控日志可以记录错误类型和请求编号，但同样不应记录密码本明文和令牌。

## 13. 静态文件隔离

本课结构：

```text
lesson-10/
├─ server.mjs
└─ public/
   ├─ index.html
   ├─ client.js
   └─ styles.css
```

```js
app.use(express.static(publicDirectory));
```

只把 `public` 目录公开，避免用户通过 `/server.mjs` 下载服务器源码或配置。本课自动检查明确要求该路径返回 404。

## 14. 路由注册顺序

```js
router.get('/entries/search', searchHandler);
router.get('/entries/:id', detailHandler);
```

固定路径通常放在参数路径之前，否则 `search` 可能被当成 id。错误处理永远放在正常路由之后。

## 15. 修改和 revision

本课 PATCH 每次修改后增加 revision：

```js
Object.assign(entry, changes, {
  revision: entry.revision + 1,
});
```

这里只展示版本概念，还没有要求客户端提交 baseRevision。正式同步必须比较基础版本，旧设备不能静默覆盖新修改。

## 16. 204 响应

```js
response.status(204).end();
```

204 表示成功但没有正文。客户端不能对 204 调用 `response.json()`，本课 request 函数先判断状态。

正式日记删除使用软删除、回收站和版本信息，通常需要返回更新结果；本课直接删除只是学习 CRUD 方法。

## 17. async 错误边界

Express 5 能把 async 路由中抛出的错误交给错误中间件。旧版本常需要包装器。使用依赖前先确认版本和官方文档，不要混用不同大版本的行为假设。

数据库事务中的错误必须回滚并继续抛出，不能只在路由 catch 后返回成功。

## 18. 常见错误

### 错误中间件放在路由之前

它捕获不到后面路由产生的错误。

### 忘记 next()

既不发送响应也不调用 next，请求会一直挂起。

### 静态目录指向项目根目录

可能公开服务器源码、环境文件或备份。只公开明确 public/dist 目录。

### DELETE 204 仍发送 JSON

204 不应包含正文。需要返回内容时使用 200。

### PATCH 接受任意字段

只从验证结果选择允许字段，不能 `Object.assign(entry, request.body)`。

### 向客户端返回 error.stack

堆栈和内部路径可能泄露实现细节。

## 19. 本课关键字

| 关键字 | 含义 |
| --- | --- |
| framework | 提供组织应用方式的框架 |
| middleware | 请求处理链中的中间函数 |
| router | 按路径和方法组织处理器 |
| handler | 处理一次请求的函数 |
| CRUD | 创建、读取、修改、删除 |
| path parameter | `/entries/:id` 中的动态参数 |
| query parameter | URL 问号后的参数 |
| error middleware | 四参数统一错误处理器 |
| request ID | 关联一次请求和日志的编号 |
| `response.locals` | 本次响应周期共享数据 |
| static files | 直接返回的 HTML/CSS/JS 等文件 |
| revision | 记录的递增版本号 |

## 20. 动手任务

1. 查看 Network 面板中的 X-Request-ID。
2. 新建日记并观察 POST 201。
3. 删除日记并观察 DELETE 204 没有正文。
4. 新增一个“编辑标题”按钮，调用 PATCH。
5. 增加固定 `/api/health` 路由，并放在参数路由之前。
6. 访问 `/server.mjs`，确认源码没有被静态公开。
7. 运行自动检查。

## 21. 完成检查表

- [ ] 理解中间件按注册顺序执行。
- [ ] 普通中间件调用 next。
- [ ] API 使用独立 Router。
- [ ] CRUD 方法与状态码匹配。
- [ ] 所有客户端输入都经过白名单验证。
- [ ] 404 位于有效路由之后。
- [ ] 错误中间件有四个参数并位于最后。
- [ ] 500 不泄露内部堆栈。
- [ ] 静态目录不包含服务器源码。
- [ ] 客户端正确处理 204。
- [ ] API 和双视口检查通过。

## 22. 思考题与参考答案

1. 中间件忘记 next 会怎样？
   - 如果也没有发送响应，请求会停在该中间件并一直等待。
2. 为什么错误中间件有四个参数？
   - Express 通过 `(error, request, response, next)` 形式识别它。
3. 为什么静态目录不能指向项目根目录？
   - 可能公开服务器源码、配置、环境文件或其他私人文件。
4. DELETE 204 后客户端为什么不能 response.json？
   - 204 没有响应正文，解析 JSON 会失败。
5. 为什么 PATCH 不能直接合并 request.body？
   - 攻击者可提交不允许修改的 id、revision 或权限字段。
6. revision 在正式同步中有什么用？
   - 客户端提交基础版本，服务器可检测并发修改，防止旧副本静默覆盖新内容。

下一课将学习 SQLite 与 SQL，把内存数组替换为真正的表、查询和事务。
