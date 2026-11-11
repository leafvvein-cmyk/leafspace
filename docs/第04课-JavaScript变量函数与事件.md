# 第 04 课：JavaScript 变量、函数与事件

## 1. 本课完成后要会什么

这一课学习三个核心概念：

1. 用变量保存页面元素和会变化的数据。
2. 用函数把一组操作命名并重复调用。
3. 用事件监听器响应点击和表单提交。

可运行练习位于 `learning/lesson-04`。它与正式应用完全隔离，不会读取或修改你的正式日记、待办或密码本。

启动练习：

```powershell
npm run learn:04
```

浏览器打开：<http://127.0.0.1:4180>

自动检查：

```powershell
npm run check:learn:04
```

## 2. JavaScript 放在哪里

练习页面在 `body` 末尾连接模块：

```html
<script type="module" src="app.js"></script>
```

`type="module"` 让文件使用现代模块规则，并默认采用严格模式。脚本放在页面内容之后，浏览器执行查询时 HTML 元素已经存在。

不要在 HTML 中写大量 `onclick="..."`。结构放在 HTML，行为集中放在 JavaScript，后续更容易测试和维护。

## 3. 语句、表达式和注释

```js
const title = '今天的日记';
```

这是一条语句。右侧的字符串是表达式，它会产生一个值。分号表示语句结束；项目应保持统一风格。

注释不会执行：

```js
// 单行注释

/*
  多行注释
*/
```

注释解释“为什么”，不要逐字重复代码已经表达的内容。

## 4. `const` 和 `let`

```js
const pageTitle = '我的日记';
let savedCount = 0;
```

- `const` 声明不能重新赋值的变量。
- `let` 声明之后需要重新赋值的变量。
- 不再使用容易产生作用域问题的 `var` 作为初学默认写法。

```js
savedCount = savedCount + 1;
```

这里给 `savedCount` 重新赋值，所以必须使用 `let`。

变量名规则：

- 可以使用字母、数字、`_`、`$`，但不能以数字开头。
- 区分大小写，`title` 与 `Title` 是两个名字。
- 通常使用 `camelCase`，例如 `savedCount`。
- 使用能表达用途的名字，不要写 `a`、`x1`。

## 5. 基础数据类型

```js
const title = '散步';       // string 字符串
const count = 1;           // number 数字
const editing = true;      // boolean 布尔值
const missing = null;      // 明确表示没有值
let result;                // undefined，尚未赋值
```

查看类型：

```js
console.log(typeof title); // string
console.log(typeof count); // number
```

表单输入框的 `.value` 始终是字符串，即使用户输入看起来像数字。

## 6. 字符串和模板字符串

单引号和双引号都能创建字符串：

```js
const first = '日记';
const second = "随记";
```

反引号创建模板字符串，可以插入表达式：

```js
const savedCount = 2;
const message = `已经保存 ${savedCount} 篇日记。`;
```

`${...}` 内会计算 JavaScript 表达式。不要把用户输入拼成 HTML 字符串插入页面；本课使用 `textContent`，避免输入被当成标签执行。

## 7. 比较和条件判断

```js
if (title === '') {
  showError('请先填写标题。');
  return;
}
```

- `===` 严格比较值和类型。
- `!==` 表示严格不等于。
- `>`、`>=`、`<`、`<=` 比较大小。
- `return` 立即结束当前函数。

初学时优先使用 `===`，避免 `==` 自动转换类型带来的意外结果。

逻辑运算符：

```js
if (title !== '' && content !== '') {
  // 标题和正文都不为空
}
```

- `&&`：并且。
- `||`：或者。
- `!`：取反。

## 8. 用 DOM 查询页面元素

DOM 是浏览器根据 HTML 建立的页面对象模型。

```js
const button = document.querySelector('#new-entry-button');
```

`document.querySelector()` 接受 CSS 选择器，并返回第一个匹配元素。找不到时返回 `null`。

```js
const titleInput = document.querySelector('#entry-title');
const entryForm = document.querySelector('#entry-form');
```

选择器必须与 HTML 中的 `id` 或 class 完全一致。

## 9. 读取和修改元素

读取输入框：

```js
const title = titleInput.value.trim();
```

`.trim()` 删除字符串开头和结尾的空白。

安全地显示普通文字：

```js
savedTitle.textContent = title;
```

显示或隐藏：

```js
entryForm.hidden = false;
savedEntry.hidden = true;
```

移动键盘焦点：

```js
titleInput.focus();
```

除非内容来自可信固定模板，否则不要使用 `innerHTML` 显示用户输入。

## 10. 函数

```js
function openEditor() {
  entryForm.hidden = false;
  titleInput.focus();
}
```

- `function` 声明函数。
- `openEditor` 是函数名。
- `()` 是参数列表。
- `{}` 包含函数体。

声明函数不会立即执行。执行时写：

```js
openEditor();
```

带参数的函数：

```js
function showError(message) {
  formError.textContent = message;
  formError.hidden = false;
}

showError('请先填写标题。');
```

参数让同一个函数处理不同消息。

## 11. 事件监听器

```js
newEntryButton.addEventListener('click', openEditor);
```

含义是：“当按钮发生 click 事件时，调用 openEditor 函数。”

注意不要写成：

```js
newEntryButton.addEventListener('click', openEditor()); // 错误
```

带括号会在注册监听器时立即执行函数，并把返回值交给监听器。

常见事件：

| 事件 | 发生时机 |
| --- | --- |
| `click` | 点击按钮或链接 |
| `submit` | 提交表单 |
| `input` | 输入值改变 |
| `change` | 控件完成一次值变更 |
| `keydown` | 按下键盘按键 |
| `focus` | 元素获得焦点 |
| `blur` | 元素失去焦点 |

## 12. 表单提交和 `preventDefault()`

```js
function saveEntry(event) {
  event.preventDefault();
  // 检查并保存练习内容
}

entryForm.addEventListener('submit', saveEntry);
```

表单默认会导航或刷新页面。`event.preventDefault()` 阻止默认提交，让 JavaScript 在当前页处理数据。

监听 `submit` 比只监听保存按钮的 `click` 更正确，因为用户在输入框中按 Enter 也能提交表单。

## 13. 练习代码调用关系

```text
用户点击“写日记”
  → click 事件
  → openEditor()
  → 显示表单并聚焦标题

用户提交表单
  → submit 事件
  → saveEntry(event)
  → 阻止页面刷新
  → 读取并检查 title/content
  → 更新 savedTitle、savedContent、pageStatus
  → closeEditor()
```

遇到不理解的代码时，沿着“事件 → 函数 → 修改了什么变量或元素”逐步追踪。

## 14. 为什么刷新后会清空

本课变量只存在于当前页面的内存中：

```js
let savedCount = 0;
```

刷新页面会重新执行文件，变量再次从 0 开始。第 7 课会使用 `localStorage` 和 JSON 保存练习数据；正式产品使用 IndexedDB、SQLite 和云端 PostgreSQL，不会拿本课内存变量冒充持久存储。

## 15. 浏览器调试方法

### Console

按 F12 打开开发工具，在 Console 中查看错误。可以临时写：

```js
console.log(title);
console.log(savedCount);
```

不要在正式产品日志中输出密码、验证码、恢复密钥或日记正文。

### Sources 和断点

在 Sources 中打开 `app.js`，点击行号设置断点。再次点击按钮，浏览器会暂停，你可以逐行观察变量值。

### 常见错误信息

- `ReferenceError`：变量名不存在或超出作用域。
- `TypeError`：对不支持该操作的值调用属性或函数。
- `SyntaxError`：括号、引号、关键字等语法错误。

先读错误的文件名和行号，再检查该行附近代码。

## 16. 常见错误

### 把 `=` 当成比较

```js
if (title = '') { }   // 赋值，不是比较
if (title === '') { } // 严格比较
```

### 修改 `const`

```js
const count = 0;
count = 1; // 报错
```

需要重新赋值时使用 `let`。

### 查询器拼写不一致

HTML 是 `id="entry-title"`，JavaScript 就应查询 `#entry-title`。

### 忘记处理空白

用户只输入空格时，`value` 并不是空字符串；使用 `.trim()` 后再验证。

### 用 `innerHTML` 显示用户内容

这可能把输入解释为 HTML。普通文字使用 `textContent`。

### 只监听按钮点击

表单应监听 `submit`，否则键盘提交行为可能不一致。

### 忘记阻止默认提交

页面刷新后看似“什么都没发生”。在提交处理函数开头调用 `event.preventDefault()`。

## 17. 本课关键字

| 关键字 | 含义 |
| --- | --- |
| statement | 一条可执行语句 |
| expression | 会产生值的代码 |
| variable | 保存值的命名位置 |
| `const` | 不重新赋值的变量声明 |
| `let` | 可以重新赋值的变量声明 |
| string | 字符串 |
| number | 数字 |
| boolean | `true` 或 `false` |
| function | 命名的一组操作 |
| parameter | 函数声明接收的名字 |
| argument | 调用函数时传入的实际值 |
| DOM | HTML 在浏览器中的对象模型 |
| selector | 查询 DOM 元素使用的选择器 |
| event | 点击、输入、提交等发生的事情 |
| listener | 等待并处理事件的函数 |
| scope | 变量可以被访问的范围 |
| validation | 检查输入是否满足规则 |

## 18. 动手任务

1. 运行 `npm run learn:04`，完成一次日记保存。
2. 把初始状态文字改成你喜欢的提示。
3. 新增一个 `let editorOpen = false`，打开和关闭编辑器时同步更新它，并在控制台观察。
4. 当标题超过 30 个字符时显示明确错误。
5. 给“取消”按钮增加确认逻辑：只有正文非空时才调用 `window.confirm()`。
6. 运行 `npm run check:learn:04`，确认原功能仍通过桌面和手机检查。

## 19. 完成检查表

- [ ] 能解释 `const` 与 `let` 的区别。
- [ ] 变量名使用清楚的 camelCase。
- [ ] 输入值使用 `.trim()` 后验证。
- [ ] 比较使用 `===` 或 `!==`。
- [ ] 能用 `querySelector()` 找到元素。
- [ ] 使用 `textContent` 显示用户文字。
- [ ] 点击行为通过 `addEventListener()` 注册。
- [ ] 表单逻辑监听 `submit`。
- [ ] 提交时调用 `preventDefault()`。
- [ ] 错误消息对用户可见，不只写入控制台。
- [ ] 自动浏览器检查通过。

## 20. 思考题与参考答案

1. 为什么 `savedCount` 使用 `let`？
   - 每保存一次都需要重新赋值；`const` 不允许重新赋值。
2. `openEditor` 和 `openEditor()` 有什么区别？
   - 前者表示函数本身，可以交给事件监听器；后者表示立即调用函数。
3. 为什么保存使用 `submit` 而不只是按钮 `click`？
   - 表单还可能通过键盘等方式提交，监听 submit 能统一覆盖标准提交行为。
4. `textContent` 为什么比 `innerHTML` 更适合显示用户标题？
   - 它把内容当普通文字，不会把用户输入解释为可执行标签。
5. 为什么刷新后练习日记消失？
   - 数据只保存在当前页面内存变量中，刷新会重新初始化脚本。
6. `event.preventDefault()` 在本课做什么？
   - 阻止表单默认导航/刷新，让 JavaScript 在当前页面验证并显示结果。

下一课将学习对象、数组和循环，用统一的数据结构保存多篇日记并渲染列表。
