# HTML 基础语法速查表

这是一份查阅手册，不要求一次背完。写代码时遇到不熟悉的标签或属性，可以回来查找。

## 1. 文档骨架

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>页面标题</title>
    <link rel="stylesheet" href="styles.css">
  </head>
  <body>
    页面内容
    <script src="app.js"></script>
  </body>
</html>
```

## 2. 基本语法

```html
<标签名 属性名="属性值">内容</标签名>
```

示例：

```html
<p class="welcome-message">欢迎回来。</p>
```

## 3. 常用内容标签

| 标签 | 用途 |
| --- | --- |
| `h1`–`h6` | 六级标题 |
| `p` | 段落 |
| `strong` | 非常重要的内容 |
| `em` | 语气强调 |
| `small` | 补充性小字 |
| `time` | 日期或时间 |
| `blockquote` | 一段引用 |
| `br` | 单次换行 |
| `hr` | 内容主题分隔 |

## 4. 页面结构标签

| 标签 | 用途 |
| --- | --- |
| `header` | 页面或章节顶部 |
| `nav` | 导航区域 |
| `main` | 页面主要内容 |
| `aside` | 侧栏和辅助信息 |
| `section` | 有主题的内容区域 |
| `article` | 可独立阅读的内容 |
| `footer` | 页面或章节底部 |
| `div` | 普通块级容器 |
| `span` | 普通行内容器 |

## 5. 列表

| 标签 | 用途 |
| --- | --- |
| `ul` | 无序列表 |
| `ol` | 有序列表 |
| `li` | 列表项目 |
| `dl` | 描述列表 |
| `dt` | 描述名称 |
| `dd` | 描述内容 |

## 6. 链接和图片

```html
<a href="index.html">返回首页</a>
<img src="images/cover.jpg" alt="打开的日记本">
```

- `a` 使用 `href` 指定目标。
- `img` 使用 `src` 指定图片。
- 有意义的图片必须提供 `alt`。
- 纯装饰图片可以使用 `alt=""`。
- 链接文字应说明去向，不要只写“点击这里”。

## 7. 表单标签

| 标签 | 用途 |
| --- | --- |
| `form` | 包含一组输入控件 |
| `label` | 输入控件的文字说明 |
| `input` | 单行或特定类型输入 |
| `textarea` | 多行文字输入 |
| `button` | 按钮 |
| `select` | 下拉选择框 |
| `option` | 一个下拉选项 |
| `fieldset` | 把相关输入分组 |
| `legend` | 分组标题 |

## 8. 常见 input 类型

| type | 用途 |
| --- | --- |
| `text` | 普通单行文字 |
| `password` | 密码 |
| `email` | 邮箱地址 |
| `number` | 数值 |
| `date` | 日期 |
| `time` | 时间 |
| `search` | 搜索文字 |
| `checkbox` | 可多选的复选框 |
| `radio` | 一组中选择一个 |
| `file` | 选择文件 |

## 9. 常用全局属性

| 属性 | 用途 |
| --- | --- |
| `id` | 页面内唯一标识 |
| `class` | 一个或多个分类名称 |
| `title` | 补充说明，不能替代可见文字 |
| `hidden` | 隐藏元素 |
| `lang` | 内容语言 |
| `tabindex` | 键盘焦点顺序，初学时谨慎使用 |
| `data-*` | 自定义数据，例如 `data-id="12"` |
| `aria-label` | 没有可见文字时提供无障碍名称 |

## 10. 表单常用属性

| 属性 | 用途 |
| --- | --- |
| `name` | 提交数据时的字段名 |
| `value` | 当前或默认值 |
| `placeholder` | 空值提示 |
| `required` | 必填 |
| `disabled` | 禁用且通常不会提交 |
| `readonly` | 只读但仍可提交 |
| `minlength` | 最少字符数 |
| `maxlength` | 最多字符数 |
| `min` / `max` | 数值或日期范围 |
| `checked` | 默认选中复选框或单选框 |
| `selected` | 默认选中下拉项 |
| `autocomplete` | 自动填充提示 |

## 11. 布尔属性

这些属性只要出现就表示开启：

```html
<input required>
<input disabled>
<input readonly>
<input type="checkbox" checked>
```

不要写 `required="false"`。属性仍然存在，浏览器仍可能视为必填。需要关闭时应删除整个属性。

## 12. HTML 编写规则

1. 第一行写 `<!doctype html>`。
2. 中文页面使用 `<html lang="zh-CN">`。
3. 使用 UTF-8 字符编码。
4. 标签名和属性名使用小写。
5. 属性值使用双引号。
6. 正确关闭成对标签。
7. 后打开的标签先关闭。
8. 嵌套一层缩进两个空格。
9. 一个页面通常只有一个 `main` 和一个主要 `h1`。
10. 每个 `id` 在页面内必须唯一。
11. 表单输入必须有可识别的 `label`。
12. 按钮明确写出 `type`。
13. 图片提供合适的 `alt`。
14. 用 HTML 表达含义，用 CSS 控制外观。
15. 不使用 `font`、`center` 等过时标签。

## 13. 推荐命名规则

- 使用简短、准确的英文名称。
- 使用小写字母。
- 多个单词使用短横线。
- 名称描述作用，不描述临时颜色或位置。

```html
<section class="diary-editor">
  <input id="diary-title">
</section>
```

推荐 `save-button`，不推荐 `red-button`。

## 14. 连接 CSS 和 JavaScript

在 `head` 中连接 CSS：

```html
<link rel="stylesheet" href="styles.css">
```

在 `body` 结束前连接 JavaScript：

```html
<script src="app.js"></script>
```

## 15. 基础无障碍规则

- 可点击操作使用 `button`，不要让 `div` 假装按钮。
- 链接用于跳转，按钮用于执行操作。
- 输入框提供 `label`。
- 操作状态不能只依赖颜色区分。
- 输入错误提供文字说明。
- 标题层级连续、清晰。
- 不随意删除键盘焦点提示。

## 16. 快速检查

- [ ] 浏览器标签标题正确。
- [ ] 页面没有乱码。
- [ ] 标题层级合理。
- [ ] 所有标签正确关闭。
- [ ] 所有 `id` 唯一。
- [ ] 输入框都有标签。
- [ ] 按钮类型明确。
- [ ] 图片有 `alt`。
- [ ] 链接文字能够说明去向。
- [ ] 手机宽度下可以正常阅读。

