# 第 03 课：Flex 与 Grid 响应式布局

## 1. 本课目标

这一课学习三个概念：

1. Flex：安排一行或一列内容。
2. Grid：安排同时有行和列的页面区域。
3. 响应式切换：电脑双栏，手机单栏。

完成后，你能独立写出日记页面的顶部工具栏、侧栏和正文布局，并解释为什么某处使用 Flex、某处使用 Grid。

## 2. 开始前的 HTML

新建一个练习文件，或把以下结构加入你的练习页。不要覆盖正式应用目录 `apps/client`。

```html
<body>
  <header class="topbar">
    <a class="brand" href="#">我的日记</a>
    <button class="new-button" type="button">写日记</button>
  </header>

  <main class="app-layout">
    <aside class="sidebar">
      <nav class="main-nav" aria-label="主要导航">
        <a href="#today">今天</a>
        <a href="#timeline">时间线</a>
        <a href="#calendar">日历</a>
      </nav>
    </aside>

    <section class="content" id="today">
      <header class="content-header">
        <div>
          <p class="eyebrow">TODAY</p>
          <h1>今天的日记</h1>
        </div>
        <time datetime="2026-09-10">2026 年 9 月 10 日</time>
      </header>

      <article class="diary-card">
        <h2>从一小段开始</h2>
        <p>把今天值得记住的事情写下来。</p>
      </article>
    </section>
  </main>
</body>
```

先复用第 2 课的颜色变量和全局 `box-sizing`，再学习本课布局。

## 3. 正常文档流

不写布局 CSS 时，块级元素通常从上到下排列，这叫正常文档流。正常流不是错误，它是安全的默认行为：内容变长时页面会自然向下扩展。

Flex 和 Grid 应用于父元素，用来安排它的直接子元素。它们不是把整个页面上的所有元素一起移动。

```html
<div class="parent">
  <div>子元素 A</div>
  <div>子元素 B</div>
</div>
```

```css
.parent {
  display: flex;
}
```

只有 A、B 作为 `.parent` 的直接子元素参与这次 Flex 排列。

## 4. Flex 的主轴和交叉轴

```css
.topbar {
  display: flex;
  flex-direction: row;
}
```

`row` 表示主轴从左到右，交叉轴从上到下。如果改为 `column`，主轴就从上到下。

常用属性：

| 属性 | 作用 |
| --- | --- |
| `display: flex` | 开启 Flex 布局 |
| `flex-direction` | 设置主轴方向 |
| `justify-content` | 沿主轴分配空间 |
| `align-items` | 沿交叉轴对齐 |
| `gap` | 子元素之间的距离 |
| `flex-wrap` | 空间不足时是否换行 |

## 5. 写一个顶部工具栏

```css
.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  min-height: 64px;
  padding: 0.75rem max(1rem, calc((100% - 72rem) / 2));
  border-bottom: 1px solid var(--line);
  background: var(--paper);
}
```

- `align-items: center` 让品牌和按钮在交叉轴居中。
- `justify-content: space-between` 把剩余空间放在两者中间。
- `gap` 保证空间很窄时两者仍有最小距离。

不要使用大量 `margin-left` 把按钮硬推到右侧；父容器应负责排列子元素。

## 6. Flex 子元素怎样伸缩

`flex` 是三个值的缩写：`flex-grow`、`flex-shrink`、`flex-basis`。

```css
.search-input {
  flex: 1 1 20rem;
}

.new-button {
  flex: 0 0 auto;
}
```

- `grow`：有剩余空间时是否变大。
- `shrink`：空间不足时是否变小。
- `basis`：参与分配前的初始尺寸。

常见写法 `flex: 1` 表示该项目可以占用剩余空间。

如果 Flex 子元素包含很长文字，常常还需要：

```css
.content-title {
  min-width: 0;
}
```

否则子元素默认最小宽度可能阻止它缩小，导致横向溢出。

## 7. Flex 换行

```css
.tag-list {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}
```

标签数量不固定，空间不足时应该自然换行。`flex-wrap: nowrap` 是默认值，会尝试挤在同一行。

不要用固定宽度预测每个标签占多少空间；中文、英文和用户字号都会改变宽度。

## 8. Grid 的行和列

```css
.app-layout {
  display: grid;
  grid-template-columns: 16rem minmax(0, 1fr);
  gap: 2rem;
}
```

这里定义两列：

- 侧栏固定为 `16rem`。
- 主内容使用 `1fr` 获取剩余空间。
- `minmax(0, 1fr)` 允许主内容真正缩小到 0，避免长内容撑破页面。

Grid 非常适合“侧栏 + 主内容”这种二维页面骨架。

## 9. `fr`、`repeat` 和 `minmax`

### `fr`

表示可用空间的一份：

```css
grid-template-columns: 1fr 2fr;
```

第二列得到的剩余空间约为第一列两倍。

### `repeat`

重复相同列定义：

```css
grid-template-columns: repeat(3, 1fr);
```

等同于 `1fr 1fr 1fr`。

### `minmax`

定义允许的最小和最大值：

```css
grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr));
```

这适合日记卡片网格：每张至少约 `15rem`，空间足够时自动增加列数，不够时换到下一行。

## 10. 完成电脑双栏布局

```css
.app-layout {
  display: grid;
  grid-template-columns: 15rem minmax(0, 1fr);
  gap: 2rem;
  width: min(100% - 2rem, 72rem);
  margin-inline: auto;
  padding-block: 2rem 4rem;
}

.sidebar {
  align-self: start;
  padding: 1rem;
  border: 1px solid var(--line);
  border-radius: 16px;
  background: var(--paper);
}

.main-nav {
  display: grid;
  gap: 0.25rem;
}

.main-nav a {
  min-height: 44px;
  padding: 0.65rem 0.8rem;
  border-radius: 10px;
  color: var(--ink);
  text-decoration: none;
}

.main-nav a:hover,
.main-nav a:focus-visible {
  background: #f3e7dc;
}

.content {
  min-width: 0;
}

.content-header {
  display: flex;
  align-items: end;
  justify-content: space-between;
  gap: 1rem;
  margin-bottom: 1.25rem;
}

.content-header h1,
.content-header p {
  margin: 0;
}
```

页面骨架使用 Grid，标题行内部使用 Flex。不同布局工具可以嵌套，并不冲突。

## 11. 切换为手机单栏

```css
@media (max-width: 48rem) {
  .topbar {
    min-height: 56px;
  }

  .app-layout {
    grid-template-columns: 1fr;
    gap: 1rem;
    width: min(100% - 1rem, 72rem);
    padding-block: 1rem 5rem;
  }

  .sidebar {
    order: 2;
  }

  .content-header {
    align-items: start;
    flex-direction: column;
    gap: 0.25rem;
  }
}
```

`grid-template-columns: 1fr` 将主布局改为一列。`flex-direction: column` 让标题和日期上下排列。

只是视觉上移动元素时要谨慎使用 `order`：键盘焦点和屏幕阅读顺序仍按 HTML 顺序。主要内容的逻辑顺序应先在 HTML 中合理安排。

## 12. 手机底部导航

正式 App 常用固定底部导航。最小示例：

```css
.bottom-nav {
  position: fixed;
  right: 0;
  bottom: 0;
  left: 0;
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  padding-bottom: env(safe-area-inset-bottom);
  border-top: 1px solid var(--line);
  background: rgb(255 253 248 / 96%);
}
```

`env(safe-area-inset-bottom)` 为带底部手势区域的手机预留安全距离。固定导航会覆盖内容，所以主页面底部 padding 必须大于导航高度。

本课练习可以先保留侧栏；第 16 课进入 Capacitor 时再验证真实安全区。

## 13. `position` 的使用边界

| 值 | 含义 |
| --- | --- |
| `static` | 默认值，处于正常文档流 |
| `relative` | 保留原位置，并可作为绝对子元素定位参照 |
| `absolute` | 脱离正常流，相对最近的定位祖先定位 |
| `fixed` | 相对视口固定 |
| `sticky` | 滚动到阈值后粘住 |

不要用大量 `position: absolute` 排整个页面。文字变长、翻译变化或手机变窄时，绝对定位元素很容易重叠。

侧栏粘住可以这样写：

```css
.sidebar {
  position: sticky;
  top: 1rem;
}
```

粘性定位受祖先滚动容器影响；如果无效，先检查祖先是否设置了 `overflow`。

## 14. 溢出与长文本

```css
.diary-card {
  overflow-wrap: anywhere;
}

.single-line-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
```

日记正文通常应该换行，不应省略；列表中确实只能显示一行的标题才适合省略号。不要对整个页面使用 `overflow: hidden`，这可能让用户无法滚动到内容。

## 15. 布局调试方法

临时加入轮廓可以看清每个盒子：

```css
* {
  outline: 1px solid rgb(255 0 0 / 15%);
}
```

只用于调试，完成后删除。浏览器开发工具的 Layout 面板还能显示 Grid 列线、gap 和 Flex 主轴。

检查三个宽度：

1. `1440px`：电脑侧栏和正文是否舒展。
2. `768px`：断点附近是否突然拥挤或跳动。
3. `360px`：最窄常用手机是否出现横向滚动。

再把浏览器文字放大到 200%，确认内容没有被固定高度裁掉。

## 16. 常见错误

### 把 Flex 写在子元素上

排列兄弟元素的 `display: flex` 应写在它们的父元素上。

### 同时用 gap 和不一致的 margin

父容器已有 `gap` 时，不要再给每个子元素添加不同方向的外边距制造重复间隔。

### `1fr` 仍被长内容撑宽

把列写成 `minmax(0, 1fr)`，并给对应 Grid/Flex 子元素设置 `min-width: 0`。

### 固定两栏在手机上继续显示

添加内容驱动的媒体查询，并在窄屏改为 `grid-template-columns: 1fr`。

### 视觉顺序和操作顺序不同

谨慎使用 `order` 和 Grid 显式位置。HTML 顺序应首先满足阅读与键盘操作逻辑。

### 固定底栏遮住最后一项

给滚动内容增加足够的 `padding-bottom`，并考虑手机安全区。

## 17. 本课关键字

| 关键字 | 含义 |
| --- | --- |
| normal flow | 默认从上到下的文档流 |
| flex container | 设置了 `display: flex` 的父元素 |
| flex item | Flex 容器的直接子元素 |
| main axis | Flex 的主排列方向 |
| cross axis | 与主轴垂直的方向 |
| wrap | 空间不足时换行 |
| grid container | 设置了 `display: grid` 的父元素 |
| track | Grid 的一行或一列 |
| `fr` | Grid 可用空间的一份 |
| `minmax()` | Grid 轨道的最小和最大尺寸 |
| breakpoint | 布局需要改变的宽度位置 |
| media query | 根据媒体条件应用规则 |
| overflow | 内容超过盒子时的处理方式 |
| safe area | 手机刘海或手势区域外的安全空间 |

## 18. 动手任务

1. 用 Flex 把品牌放左边、“写日记”按钮放右边。
2. 用 Grid 创建 `15rem + 剩余空间` 的电脑双栏。
3. 给侧栏导航添加 `gap`，不要给每个链接单独写下边距。
4. 在 `48rem` 以下切换成一列。
5. 给标题行设置手机上下排列。
6. 加入一个特别长、没有空格的测试字符串，修复横向溢出。
7. 用键盘 Tab 检查视觉顺序与焦点顺序是否一致。

## 19. 完成检查表

- [ ] 工具栏使用 Flex，页面骨架使用 Grid。
- [ ] Grid 主内容列使用 `minmax(0, 1fr)`。
- [ ] 可缩小的内容区域设置了 `min-width: 0`。
- [ ] 间距主要由父容器 `gap` 管理。
- [ ] 360px 宽度下切换为单栏。
- [ ] 页面没有横向滚动条。
- [ ] 文字放大后没有重叠或裁切。
- [ ] 键盘焦点顺序符合阅读顺序。
- [ ] 固定元素没有遮住页面最后的内容。
- [ ] 没有用绝对定位搭建整个页面。

## 20. 思考题与参考答案

1. Flex 和 Grid 最主要的区别是什么？
   - Flex 主要处理一维的一行或一列；Grid 适合同时规划行和列的二维区域。
2. 为什么 `display: grid` 要写在父元素上？
   - Grid 负责安排父元素的直接子元素，子元素本身不会自动成为兄弟元素的布局容器。
3. `1fr` 为什么有时还会溢出？
   - Grid 子元素存在基于内容的默认最小宽度；`minmax(0, 1fr)` 和 `min-width: 0` 允许它真正缩小。
4. 为什么断点不应该只按某个手机型号选择？
   - 设备尺寸很多，内容和用户字号也会变化；应在布局实际开始拥挤的位置切换。
5. 为什么要谨慎使用 `order`？
   - 它只改变视觉位置，不一定改变键盘和屏幕阅读器顺序，可能造成理解和操作错位。
6. 固定底部导航为什么要考虑 safe area？
   - 部分手机底部有系统手势区域，未预留安全距离会让按钮难以点击或被系统区域遮挡。

下一课将学习 JavaScript 的变量、数据类型、函数和事件，让“写日记”按钮真正执行操作。
