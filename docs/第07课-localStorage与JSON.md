# 第 07 课：localStorage 与 JSON

## 1. 本课目标

本课学习三个概念：

1. 用 `localStorage` 保存少量浏览器练习数据。
2. 用 JSON 在字符串和对象/数组之间转换。
3. 处理版本不符、损坏数据和写入失败。

启动：

```powershell
npm run learn:07
```

打开 <http://127.0.0.1:4183>。自动检查：

```powershell
npm run check:learn:07
```

本课存储仅用于学习。正式 Web 使用 IndexedDB，手机使用加密 SQLite，云端使用 PostgreSQL。

## 2. 为什么普通变量刷新后消失

```js
let entries = [];
```

变量位于当前页面的运行内存。刷新会结束旧页面并重新执行脚本，所以数组又变为空。

持久化是把数据写到页面进程之外，并在下次启动时重新读取。`localStorage` 是最简单的浏览器键值存储，适合本课的小型文本练习。

## 3. localStorage 是键值存储

```js
localStorage.setItem('theme', 'dark');
const theme = localStorage.getItem('theme');
localStorage.removeItem('theme');
```

- 键和值都以字符串保存。
- 找不到键时 `getItem()` 返回 `null`。
- 数据按网站来源隔离，协议、域名或端口不同会进入不同空间。
- 清除浏览器站点数据会删除它。

不要调用 `localStorage.clear()`，它会清除同来源的所有键，可能误伤其他功能。只删除自己拥有的明确键。

## 4. 使用稳定且带版本的键

```js
const STORAGE_KEY = 'diary-learning:lesson-07:v1';
```

键名包含产品、用途和版本，减少与其他练习冲突。修改数据格式时不要悄悄继续使用旧键或把旧数据错误解析成新结构。

`localStorage` 不是密码保险库。密码、令牌、恢复密钥和 TOTP 密钥不能因为“方便”写入普通本地存储。

## 5. JSON.stringify()

localStorage 只能保存字符串，而日记列表是数组：

```js
const payload = {
  version: 1,
  entries,
};

const text = JSON.stringify(payload);
localStorage.setItem(STORAGE_KEY, text);
```

`JSON.stringify()` 把可表示的 JavaScript 数据转换为 JSON 文本。函数、DOM 元素、`undefined` 等不能按普通字段可靠保留。

日期对象会转换为字符串。学习项目直接保存明确 ISO 或本地显示字符串；正式产品需固定时间格式和时区规则。

## 6. JSON.parse()

```js
const raw = localStorage.getItem(STORAGE_KEY);
const saved = JSON.parse(raw);
```

`JSON.parse()` 把 JSON 文本转换回值。外部存储不是可信输入：内容可能来自旧版本、开发工具手动修改、扩展程序或写入中断。

解析失败会抛出异常，因此必须使用 `try...catch`。

## 7. try、catch 和异常

```js
try {
  const saved = JSON.parse(raw);
  return saved.entries;
} catch (error) {
  console.error(error);
  return [];
}
```

- `try` 内执行可能失败的操作。
- 发生异常时跳到 `catch`。
- 捕获后要进入明确、安全状态。

不要空 catch 后假装成功。页面应告诉用户发生了什么，以及数据是否保留、隔离或删除。

## 8. 解析成功不代表结构正确

以下都是合法 JSON，但不是正确日记存储：

```json
null
```

```json
{"version":99,"entries":"不是数组"}
```

所以还要检查 schema：

```js
if (saved?.version !== 1 || !Array.isArray(saved.entries)) {
  throw new Error('存储结构不符合规则');
}
```

可选链 `?.` 在 `saved` 为 null 时不会继续读取属性。`Array.isArray()` 才是判断数组的可靠方式。

## 9. 逐条验证记录

```js
function validEntry(entry) {
  return entry && typeof entry === 'object'
    && typeof entry.id === 'string'
    && typeof entry.title === 'string'
    && entry.title.length <= 80;
}

const valid = saved.entries.every(validEntry);
```

`.every()` 只有在所有项目都满足函数时返回 true。不能因为外层是数组就相信其中每个字段。

正式项目使用共享 schema，并限制请求体和密文大小；本课手写最小验证是为了理解规则。

## 10. 加载流程

```text
读取明确 STORAGE_KEY
  → 没有值：返回空数组
  → 有值：JSON.parse
      → 解析失败：进入损坏数据路径
      → 解析成功：检查 version、entries、每条字段
          → 全部有效：恢复数组
          → 任一无效：进入损坏数据路径
  → 渲染当前安全数组
```

先完成验证，再把数据交给页面。

## 11. 写入也可能失败

```js
function persistEntries() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, entries }));
    return true;
  } catch {
    return false;
  }
}
```

可能原因包括隐私模式限制、存储空间不足、浏览器策略或序列化问题。

写入失败后不能显示“保存成功”。本课保留内存内容并提示不要刷新、先复制文字。正式应用使用事务、不可变上传队列和明确保存状态。

## 12. 保存顺序

本课流程：

```text
验证表单
  → 更新内存数组
  → 尝试写入 localStorage
  → 显示真实写入结果
  → 渲染数组
```

生产编辑器应先把草稿事务性落盘，再告诉用户已保存；云端同步是另一个状态，不能把“已写入本机”和“云端已确认”混为一谈。

## 13. 删除单篇

```js
entries = entries.filter((entry) => entry.id !== id);
persistEntries();
renderEntries();
```

`.filter()` 建立不包含目标 ID 的新数组。删除依赖稳定 ID，不依赖标题或列表位置。

本课直接删除练习项；正式日记使用回收站、同步版本和二次确认规则。

## 14. 删除全部

```js
localStorage.removeItem(STORAGE_KEY);
```

只删除第 07 课自己的键。执行不可恢复操作前，页面使用 `window.confirm()` 明确范围。

正式产品不能只依赖通用确认框；批量或账号删除还要显示数量、对象和重新验证步骤。

## 15. 多标签页限制

另一个标签页修改同一 localStorage 键时，可通过 `storage` 事件收到通知，但并发写入仍没有事务与版本冲突保护。

因此 localStorage 不适合正式日记同步仓储。IndexedDB 支持结构化数据和事务；原生 SQLite 提供数据库事务；服务器再使用 revision 和幂等请求处理跨设备并发。

## 16. 隐私和安全边界

- 同来源 JavaScript 可以读取 localStorage。
- 它不是加密存储。
- 浏览器站点数据可能被用户清除。
- XSS 会危及其中的内容。
- 不适合大图片或大量日记。
- 不应保存登录刷新令牌或密码本明文。

本课使用的是虚构练习内容，不要输入真实密码、恢复密钥或敏感日记。

## 17. 常见错误

### 直接保存数组

```js
localStorage.setItem('entries', entries);
```

这会得到类似 `[object Object]` 的无用字符串。先 `JSON.stringify()`。

### 忘记 JSON.parse

`getItem()` 返回字符串，不是原数组。

### 不处理 null

首次打开没有数据，必须返回安全空数组。

### 解析后不验证

合法 JSON 也可能结构错误或字段超长。

### 使用 localStorage.clear

它会删除不属于当前功能的键。使用 `removeItem(明确键)`。

### 保存失败仍提示成功

只有 setItem 没抛错才能说本机写入已确认。

### 在 localStorage 保存秘密

普通键值存储不是密码保险库，也没有端到端加密保证。

## 18. 本课关键字

| 关键字 | 含义 |
| --- | --- |
| persistence | 页面关闭后仍保留数据 |
| key-value | 通过键读取一个值的存储方式 |
| origin | 协议、域名和端口组成的网站来源 |
| serialization | 把结构化值转换为可保存文本 |
| deserialization | 把文本转换回结构化值 |
| JSON | 通用结构化文本格式 |
| schema | 数据结构和字段规则 |
| version | 用于识别存储格式的版本 |
| exception | 运行中抛出的异常 |
| `try...catch` | 捕获并处理异常 |
| quota | 浏览器允许的存储容量 |
| transaction | 一组操作全部成功或全部失败 |
| corruption | 数据损坏或不符合预期结构 |

## 19. 动手任务

1. 保存两篇练习日记并刷新，确认都恢复。
2. 在开发工具 Application → Local Storage 找到带版本的键。
3. 手动把值改为 `{broken`，刷新并观察损坏路径。
4. 给记录增加 `mood` 字段，并同时更新验证函数。
5. 故意把 `version` 改成 2，观察旧结构被拒绝。
6. 删除一篇，刷新确认不会重新出现。
7. 运行自动浏览器检查。

## 20. 完成检查表

- [ ] 使用明确、带命名空间和版本的键。
- [ ] 保存前调用 JSON.stringify。
- [ ] 读取后在 try/catch 中调用 JSON.parse。
- [ ] 正确处理首次打开的 null。
- [ ] 验证外层版本、数组和每条字段。
- [ ] 写入失败时不声称保存成功。
- [ ] 删除只使用 removeItem 的明确键。
- [ ] 明白 localStorage 不适合秘密和正式大数据。
- [ ] 刷新恢复和损坏数据路径都通过测试。
- [ ] 电脑与手机视口均无横向溢出。

## 21. 思考题与参考答案

1. 为什么 localStorage 不能直接保存对象？
   - 它只保存字符串，对象需先序列化为 JSON 文本。
2. JSON.parse 成功后为什么还要验证？
   - 合法 JSON 不代表符合当前版本的业务结构和长度规则。
3. 为什么存储键要带版本？
   - 数据格式会演进，版本能区分旧结构并触发明确迁移或拒绝流程。
4. 为什么不能用 localStorage.clear？
   - 它会清除同来源全部键，可能删除其他功能或用户数据。
5. setItem 为什么需要 try/catch？
   - 浏览器策略、隐私模式或配额都可能让写入失败。
6. 正式产品为什么使用 IndexedDB/SQLite？
   - 它们支持更大结构化数据和事务，能建立可靠的本机保存与同步队列。

下一课将学习搜索、标签和日期筛选，使用 `filter()`、字符串规范化和组合条件查找历史日记。
