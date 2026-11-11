# 第 02 课：CSS 基础规则与纸张风格

## 1. 本课完成后要会什么

这一课只集中学习三个核心概念：

1. 用选择器找到要修改的 HTML 元素。
2. 用声明设置颜色、字体、尺寸和间距。
3. 用盒模型理解元素实际占用的空间。

完成后，你应该能自己写出一个清晰、温暖、在手机上也能阅读的日记页面。先亲手输入小例子，再把它们组合起来；不要一开始复制正式产品的大型样式文件。

## 2. CSS 负责什么

HTML 描述“页面上有什么”，CSS 描述“这些内容长什么样”。例如：

```html
<h1 class="page-title">今天的日记</h1>
```

```css
.page-title {
  color: #4a3528;
  font-size: 2rem;
}
```

浏览器先读取 HTML，找到 `class="page-title"` 的标题，再应用 `.page-title` 规则。

## 3. CSS 规则的完整结构

```css
选择器 {
  属性: 值;
  属性: 值;
}
```

真实例子：

```css
.diary-card {
  background-color: #fffdf8;
  border-radius: 16px;
}
```

- `.diary-card` 是选择器。
- `background-color` 和 `border-radius` 是属性。
- `#fffdf8` 和 `16px` 是值。
- 属性和值之间使用冒号 `:`。
- 每条声明以分号 `;` 结束。
- 多条声明放在花括号 `{}` 中。

属性名通常使用小写字母和连字符，不要写成 JavaScript 风格的 `backgroundColor`。

## 4. 把 CSS 连接到 HTML

推荐把样式放在单独的 `styles.css` 文件中，然后在 HTML 的 `head` 内连接：

```html
<link rel="stylesheet" href="styles.css">
```

目录如下时，`href="styles.css"` 才能直接找到文件：

```text
日记本设计/
├─ index.html
└─ styles.css
```

如果文件放在 `css/styles.css`，地址就应写成：

```html
<link rel="stylesheet" href="css/styles.css">
```

不要在正式练习里给每个元素重复写 `style="..."`，否则很难统一修改和复用。

## 5. 五种常用选择器

### 元素选择器

匹配页面上所有同名标签：

```css
p {
  line-height: 1.8;
}
```

### class 选择器

以点 `.` 开头，可以重复使用，是组件样式的主要方式：

```css
.diary-card {
  padding: 24px;
}
```

### id 选择器

以井号 `#` 开头。`id` 在一个页面中应唯一：

```css
#diary-title {
  font-weight: 700;
}
```

日常样式优先使用 class；`id` 更适合表单关联、页面锚点或 JavaScript 精确查找。

### 后代选择器

中间使用空格，表示“某元素里面的某元素”：

```css
.diary-card p {
  color: #65554b;
}
```

它不会匹配卡片外面的段落。

### 状态选择器

冒号开头的伪类表示特定状态：

```css
.primary-button:hover {
  background-color: #6b4937;
}

.primary-button:focus-visible {
  outline: 3px solid #c58b64;
  outline-offset: 3px;
}
```

不要只写 `:hover`。键盘用户看不到鼠标悬停，所以还应保留清楚的 `:focus-visible` 焦点样式。

## 6. 层叠、继承和优先级

CSS 的 C 代表 Cascading，即“层叠”。多个规则同时匹配时，浏览器需要决定使用哪一个。

### 后写的同级规则覆盖先写的规则

```css
.note {
  color: brown;
}

.note {
  color: darkgreen;
}
```

最终颜色是 `darkgreen`。

### 更具体的选择器通常优先

```css
p {
  color: #555;
}

.warning {
  color: #a33;
}
```

`<p class="warning">` 会使用 `.warning` 的颜色。

### 一部分属性会继承

`color`、`font-family`、`line-height` 通常会从父元素传给子元素；`margin`、`padding`、`border` 通常不会。

初学阶段不要使用 `!important`。它会破坏正常优先级，使后续修改越来越困难。

## 7. 颜色的三种常见写法

```css
.example {
  color: #4a3528;
  background-color: rgb(255 253 248);
  border-color: hsl(25 28% 78%);
}
```

- 十六进制：`#RRGGBB`，设计稿中最常见。
- RGB：按红、绿、蓝描述颜色。
- HSL：按色相、饱和度、亮度描述，做主题变化时更直观。

文字与背景必须有足够对比度。浅灰文字不要放在白色背景上承担重要内容。

可以先把重复颜色声明成变量：

```css
:root {
  --paper: #fffdf8;
  --ink: #3f3128;
  --muted: #75675e;
  --accent: #8a5d43;
}

body {
  background: var(--paper);
  color: var(--ink);
}
```

变量名以 `--` 开头，读取时使用 `var(--变量名)`。

## 8. 长度单位

### `px`

适合边框、圆角和需要稳定控制的小尺寸：

```css
border: 1px solid #e5d8cc;
border-radius: 16px;
```

### `rem`

相对根元素字体大小。浏览器默认通常是 `16px`，因此 `1.5rem` 通常约为 `24px`。字体和主要间距优先使用 `rem`，能更好响应用户字号设置。

### `%`

通常相对包含元素：

```css
width: 100%;
```

### `vw` 和 `vh`

相对视口宽高。不要把正文固定为很大的 `vw` 字号，否则宽屏上会失控。

### `ch`

近似一个数字字符的宽度，适合限制正文行长：

```css
.writing-sheet {
  max-width: 68ch;
}
```

## 9. 盒模型

每个元素都可以理解成四层盒子：

```text
margin  外边距：元素和其他元素之间的距离
border  边框
padding 内边距：内容和边框之间的距离
content 内容区域
```

```css
.diary-card {
  width: 320px;
  padding: 24px;
  border: 1px solid #e5d8cc;
  margin: 16px;
}
```

默认情况下，`width` 只表示内容宽度，padding 和 border 会继续增加总宽度。通常在文件开头统一设置：

```css
*,
*::before,
*::after {
  box-sizing: border-box;
}
```

这样 `width` 会包含 padding 和 border，更容易计算，也能减少手机横向溢出。

## 10. margin、padding 和 gap

- `padding`：组件内部留白。
- `margin`：组件外部距离。
- `gap`：Flex/Grid 子元素之间的统一距离。

四值顺序是上、右、下、左：

```css
.card {
  padding: 16px 24px 20px 24px;
}
```

双值写法是上下、左右：

```css
.card {
  padding: 16px 24px;
}
```

列表布局优先使用父容器 `gap`，不要给每个子元素手工添加不同的右边距。

## 11. 字体与可读性

```css
body {
  font-family: system-ui, "Microsoft YaHei", sans-serif;
  font-size: 1rem;
  line-height: 1.7;
}

.page-title {
  font-size: clamp(1.75rem, 4vw, 2.5rem);
  font-weight: 700;
  letter-spacing: -0.02em;
}
```

`clamp(最小值, 建议值, 最大值)` 让字号随屏幕变化，但不突破上下限。正文通常不要小于 `16px`；行高约 `1.6` 到 `1.8` 更适合长文阅读。

## 12. 背景、边框、圆角和阴影

```css
.diary-card {
  background: #fffdf8;
  border: 1px solid #eadfd5;
  border-radius: 18px;
  box-shadow: 0 12px 36px rgb(74 53 40 / 10%);
}
```

阴影四个主要值依次是：水平偏移、垂直偏移、模糊半径、颜色。阴影只用于表达层级，不要让每个元素都浮起来。

## 13. 按钮的完整状态

```css
.primary-button {
  min-height: 44px;
  padding: 0.75rem 1.25rem;
  border: 0;
  border-radius: 999px;
  background: var(--accent);
  color: white;
  font: inherit;
  cursor: pointer;
}

.primary-button:hover {
  filter: brightness(0.94);
}

.primary-button:focus-visible {
  outline: 3px solid #c58b64;
  outline-offset: 3px;
}

.primary-button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}
```

手机常用点击目标建议至少约 `44 × 44px`。不要删除焦点轮廓后什么也不补。

## 14. 输入框的基础规则

```css
.field {
  display: grid;
  gap: 0.5rem;
}

.field input,
.field textarea {
  width: 100%;
  padding: 0.75rem 0.875rem;
  border: 1px solid #ccbbae;
  border-radius: 10px;
  background: white;
  color: var(--ink);
  font: inherit;
}

.field input:focus,
.field textarea:focus {
  border-color: var(--accent);
  outline: 3px solid rgb(138 93 67 / 20%);
}
```

`font: inherit` 可以避免某些浏览器给按钮和输入框使用不同字体。错误提示不能只靠红色，还应使用文字明确说明问题。

## 15. 第一个响应式规则

媒体查询会在条件成立时应用内部规则：

```css
.page-shell {
  width: min(100% - 2rem, 72rem);
  margin-inline: auto;
}

@media (max-width: 48rem) {
  .page-shell {
    width: min(100% - 1rem, 72rem);
  }

  .diary-card {
    padding: 1rem;
  }
}
```

`margin-inline: auto` 在左右方向自动分配空间，使有最大宽度的容器居中。断点应根据内容开始拥挤的位置决定，不是根据某个手机品牌命名。

本课只学习媒体查询概念；第 3 课再用 Flex 和 Grid 完成真正的电脑双栏与手机单栏布局。

## 16. 可亲手输入的暖色纸张样式

先确保你的 `index.html` 使用了这些 class：

```html
<body>
  <header class="site-header">
    <p class="eyebrow">MY PRIVATE SPACE</p>
    <h1>我的日记</h1>
  </header>

  <main class="page-shell">
    <article class="diary-card">
      <p class="diary-date">2026 年 9 月 10 日</p>
      <h2>今天发生了什么？</h2>
      <p>从一小段文字开始，不必一次写得很长。</p>
      <button class="primary-button" type="button">开始写</button>
    </article>
  </main>
</body>
```

新建 `styles.css`，亲手输入：

```css
:root {
  --canvas: #f3ece4;
  --paper: #fffdf8;
  --ink: #3f3128;
  --muted: #75675e;
  --accent: #8a5d43;
  --line: #e6d9ce;
}

*,
*::before,
*::after {
  box-sizing: border-box;
}

body {
  min-height: 100vh;
  margin: 0;
  background: var(--canvas);
  color: var(--ink);
  font-family: system-ui, "Microsoft YaHei", sans-serif;
  font-size: 1rem;
  line-height: 1.7;
}

.site-header,
.page-shell {
  width: min(100% - 2rem, 68rem);
  margin-inline: auto;
}

.site-header {
  padding-block: 3rem 1.5rem;
}

.site-header h1 {
  margin: 0;
  font-size: clamp(2rem, 6vw, 3.75rem);
  line-height: 1.1;
}

.eyebrow,
.diary-date {
  color: var(--muted);
  font-size: 0.875rem;
  letter-spacing: 0.08em;
}

.diary-card {
  max-width: 68ch;
  padding: 2rem;
  border: 1px solid var(--line);
  border-radius: 18px;
  background: var(--paper);
  box-shadow: 0 16px 45px rgb(74 53 40 / 10%);
}

.diary-card h2 {
  margin-block: 0.25rem 0.75rem;
}

.primary-button {
  min-height: 44px;
  margin-top: 1rem;
  padding: 0.75rem 1.25rem;
  border: 0;
  border-radius: 999px;
  background: var(--accent);
  color: white;
  font: inherit;
  cursor: pointer;
}

.primary-button:hover {
  filter: brightness(0.94);
}

.primary-button:focus-visible {
  outline: 3px solid #c58b64;
  outline-offset: 3px;
}

@media (max-width: 48rem) {
  .site-header,
  .page-shell {
    width: min(100% - 1rem, 68rem);
  }

  .site-header {
    padding-block: 2rem 1rem;
  }

  .diary-card {
    padding: 1.25rem;
    border-radius: 14px;
  }
}
```

保存后刷新浏览器。每次只修改一个值，例如先把 `--accent` 改成另一种颜色，观察哪些组件同时改变。

## 17. 浏览器里怎样检查 CSS

1. 在页面元素上点击右键，选择“检查”。
2. 在 Elements/元素面板中选中 HTML 标签。
3. 在 Styles/样式面板查看哪些规则生效、被覆盖或拼写错误。
4. 临时取消某条声明前的复选框，观察差异。
5. 在 Computed/计算样式中查看浏览器最终使用的尺寸和颜色。

开发工具里的临时修改不会自动写回文件。找到正确值后，还要回到 `styles.css` 保存。

## 18. 常见错误

### CSS 没有生效

先检查 `link` 路径、文件名大小写、选择器是否真的匹配 HTML class，再检查上一条规则是否缺少 `}`。

### 忘记单位

```css
padding: 16; /* 错误 */
padding: 16px; /* 正确 */
```

数值 `0` 可以不写单位。

### class 忘记写点

```css
diary-card { }  /* 查找 diary-card 标签 */
.diary-card { } /* 查找对应 class */
```

### 手机出现横向滚动条

检查固定宽度、过大的左右 margin、没有换行的长字符串，以及是否设置了 `box-sizing: border-box`。不要用 `overflow-x: hidden` 掩盖真正超宽的内容。

### 只靠颜色表达状态

错误输入除了红色边框，还应显示“密码至少 12 位”等文字。颜色不是唯一信息通道。

### 滥用固定高度

正文容器通常使用 `min-height`，不要用固定 `height` 把长文字裁掉。

## 19. 本课关键字

| 关键字 | 含义 |
| --- | --- |
| selector | 选择器，用来找到元素 |
| declaration | 一条“属性: 值”声明 |
| property | 属性，例如 `color` |
| value | 属性值，例如 `#fffdf8` |
| cascade | 多条规则冲突时的层叠顺序 |
| inheritance | 部分样式从父元素传给子元素 |
| specificity | 选择器的具体程度与优先级 |
| pseudo-class | `:hover` 等状态选择器 |
| custom property | `--paper` 等 CSS 变量 |
| box model | content、padding、border、margin 四层盒模型 |
| responsive | 根据可用空间调整页面 |
| media query | `@media` 条件规则 |
| viewport | 浏览器可见区域 |
| focus | 键盘或程序当前操作的元素 |
| contrast | 文字和背景之间的明暗差异 |

## 20. 动手任务

1. 新建 `styles.css`，并从 `index.html` 的 `head` 正确连接它。
2. 把页面背景改为暖灰色，把内容卡片改为纸张白。
3. 为主要按钮补齐普通、悬停、键盘焦点和禁用状态。
4. 把正文卡片最大宽度限制为 `68ch`，并使它在页面中居中。
5. 添加一个 `48rem` 媒体查询，让手机上的卡片内边距变小。
6. 使用浏览器开发工具确认按钮最终高度不小于 `44px`。

## 21. 完成检查表

- [ ] HTML 已通过 `link` 引入 `styles.css`。
- [ ] CSS 属性和值之间使用冒号，每条声明以分号结束。
- [ ] 重复组件主要使用 class，而不是重复 id。
- [ ] 全局设置了 `box-sizing: border-box`。
- [ ] 正文默认字号不小于 `1rem`。
- [ ] 重要文字和背景容易分辨。
- [ ] 按钮有清楚的 `:focus-visible` 样式。
- [ ] 点击目标高度不小于约 `44px`。
- [ ] 360px 宽度下没有横向滚动。
- [ ] 放大文字后内容不会被固定高度裁掉。
- [ ] 没有使用 `!important` 强行覆盖普通规则。

## 22. 思考题与参考答案

1. `.card` 与 `#card` 有什么区别？
   - `.card` 匹配可复用的 class；`#card` 匹配页面中唯一的 id。日常组件样式优先使用 class。
2. `margin` 与 `padding` 有什么区别？
   - margin 是元素外部距离，padding 是内容与边框之间的内部留白。
3. 为什么建议设置 `box-sizing: border-box`？
   - 它让声明宽度包含 padding 和 border，尺寸更容易计算，也更不容易在手机上溢出。
4. 为什么按钮不能只设计 `:hover`？
   - 手机没有稳定 hover，键盘用户依赖焦点提示，因此还需要普通、焦点、禁用等状态。
5. `rem` 为什么常用于字体？
   - 它相对根字体大小，能更好尊重浏览器和用户的文字缩放设置。
6. CSS 变量有什么好处？
   - 可以集中维护主题值，修改一处就能更新所有引用组件。

下一课将学习 Flex 和 Grid：先用 Flex 排一行工具栏，再用 Grid 完成电脑双栏、手机单栏的日记布局。
