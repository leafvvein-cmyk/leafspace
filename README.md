# 日记本：从零学习版

这个目录用于从最基础的编码技术开始，重新学习并完成一个日记网站与移动应用。

我们不会一开始使用 React、NestJS 等复杂框架，而是按照下面的顺序学习：

1. HTML：搭建页面结构。
2. CSS：完成页面布局和视觉设计。
3. JavaScript：实现新增、编辑、删除和搜索。
4. localStorage：先把日记保存在当前浏览器。
5. Node.js：编写自己的后端接口。
6. SQLite：持久保存账号和日记。
7. PWA：让网页可以安装到手机桌面并离线使用。
8. Capacitor：复用网页代码生成 Android 和 iOS 应用。

以上是循序渐进的学习路线：localStorage 和服务端 SQLite 用于前置练习，不是正式多端产品的最终存储方案。正式版本采用 PostgreSQL 云端数据库、Web IndexedDB 和手机本地 SQLite。

## 最新产品设计：v2

电脑端已确定为“浏览器使用 + 可安装桌面 PWA”，手机端为可安装的 Android / iOS App。两端共用 HTML、CSS 和原生 JavaScript 核心代码，采用温暖纸张风格，登录只使用账号和密码。

| 文档 | 内容 |
| --- | --- |
| [产品设计方案 v2](docs/产品设计方案-v2.md) | 产品范围、22 项功能的实现方式、技术选择、开发阶段和验收标准 |
| [页面与导航设计 v2](docs/页面与导航设计-v2.md) | 电脑/手机布局、页面路由、逐页交互、设计规范和异常状态 |
| [接口与数据设计 v2](docs/接口与数据设计-v2.md) | 账号、日记、同步、图片、导出等接口，数据字段、表约束和测试用例 |
| [使用指南](docs/使用指南.md) | 电脑/手机预览入口、登录、日记、待办、密码本、设置与启动方法 |

这三份是**产品设计基线**，不表示对应功能全部开发完成。根目录 `index.html` 仍是你的基础练习，没有覆盖。现已建立 `apps/client` 前端、`apps/api` 后端，以及 `apps/mobile/android`、`apps/mobile/ios` 原生工程；手机安装包尚未生成。实际进度及检查证据见 [开发进度与验收台账](docs/开发进度.md)。

当前启动：先运行 `npm install`；日常开发网页用 `npm run dev`。需要检查或安装桌面 PWA 时，先运行 `npm run build`，再运行 `npm run preview`，然后打开 `http://127.0.0.1:4173/settings/about`；正式构建预览会注册离线页面并继续代理本机 API。后台需先启动 Docker，再运行 `npm run db:up`、`npm run db:migrate` 和 `npm run dev:api`。网页只使用账号密码登录，并已接入恢复码、设备管理、学习空间显式复制迁移、双向日记同步、冲突保存/合并、私有图片失败重试与文字先行补图、含图导出、安全缓存清理、回收站永久删除和账号注销。同步状态页会区分已确认、待上传、图片失败、冲突和不确定响应；不要把仅登录成功理解为所有本机内容已上传。

登录代码与基础规则见 [账号登录与数据隔离学习](docs/账号登录与数据隔离学习.md)。运行 `npm run test:auth-browser` 可在独立临时 PostgreSQL 库中验证完整浏览器流程，不会把测试账号写进开发库。

手机工程：`npm run mobile:doctor` 检查环境，`npm run mobile:sync` 生成品牌图标/启动图并同步两端内置页面；环境齐全后用 `npm run mobile:android` 生成 Android 调试包。项目内 Java 21 已就绪，当前仍缺 Android SDK；iOS 编译还需要 Mac。命令不会代为接受 SDK 许可证。配置、关键字和步骤见 [手机 App 开发与运行](docs/手机App开发与运行.md)。

运维基础：生产 API 必须为私密图片与导出文件配置绝对持久化目录；本地可运行 `npm run db:restore-drill`，实际完成临时数据库、图片和导出文件的备份、删除后恢复及 SHA-256 校验。操作边界见 [备份、恢复与运维](docs/备份恢复与运维.md)。

部署基线见 [容器部署模板](deploy/README.md)：包含 PostgreSQL、顺序迁移、API、PWA 反向代理、健康检查和三个持久卷。模板已经通过 Compose 解析与 Nginx 语法检查，但镜像仓库当前连接超时，尚无本轮完整镜像构建和正式服务器运行证据。

学习文档继续保留，每个模块按“规则与关键字 → 小例子 → 亲手实现 → 测试检查”推进，不要求一次掌握整份技术方案。正式产品范围以 v2 为准，学习前几课的小功能不代表最终产品只做这些。

## 课程入口

完整路线见 [docs/学习重构方案.md](docs/学习重构方案.md)。

第一课见 [docs/第01课-认识网页结构.md](docs/第01课-认识网页结构.md)。

第二课见 [docs/第02课-CSS基础规则与纸张风格.md](docs/第02课-CSS基础规则与纸张风格.md)，包含选择器、层叠、单位、盒模型、响应式规则、关键字、练习与参考答案。

第三课见 [docs/第03课-Flex与Grid响应式布局.md](docs/第03课-Flex与Grid响应式布局.md)，用 Flex 和 Grid 完成电脑双栏、手机单栏布局。

第四课见 [docs/第04课-JavaScript变量函数与事件.md](docs/第04课-JavaScript变量函数与事件.md)，配套独立练习页和桌面/手机自动浏览器检查。

第五课见 [docs/第05课-对象数组与循环.md](docs/第05课-对象数组与循环.md)，用对象、数组和循环生成多篇日记列表。

第六课见 [docs/第06课-表单与输入验证.md](docs/第06课-表单与输入验证.md)，学习 HTML 约束、JavaScript 业务规则及可访问错误提示。

第七课见 [docs/第07课-localStorage与JSON.md](docs/第07课-localStorage与JSON.md)，包含刷新恢复、schema 检查、损坏数据和写入失败处理。

第八课见 [docs/第08课-搜索标签与日期.md](docs/第08课-搜索标签与日期.md)，练习字面搜索、标签、日期区间、组合筛选和防抖。

第九课见 [docs/第09课-Node与HTTP.md](docs/第09课-Node与HTTP.md)，用 Node.js 原生 HTTP 建立页面和 JSON 日记接口。

第十课见 [docs/第10课-Express路由与错误处理.md](docs/第10课-Express路由与错误处理.md)，学习 Router、middleware、CRUD、请求编号和统一错误处理。

第十一课见 [docs/第11课-SQLite与SQL.md](docs/第11课-SQLite与SQL.md)，使用真实 SQLite、参数化 SQL、迁移和事务持久保存练习日记。

第十二课见 [docs/第12课-账号与密码安全.md](docs/第12课-账号与密码安全.md)，实现仅账号密码、Argon2id、HttpOnly 会话和一次性恢复码。

第十三课见 [docs/第13课-Fetch与前后端连接.md](docs/第13课-Fetch与前后端连接.md)，把浏览器、账号会话、Express API 和 SQLite 日记真正连接起来。

第十四课见 [docs/第14课-离线缓存与可靠同步.md](docs/第14课-离线缓存与可靠同步.md)，使用 IndexedDB、本机待上传队列、幂等请求编号和版本冲突保护实现离线先写。

第十五课见 [docs/第15课-PWA安装与离线外壳.md](docs/第15课-PWA安装与离线外壳.md)，通过 Manifest、Service Worker、安全缓存和更新提示把网页变成可安装 PWA。

第十六课见 [docs/第16课-Capacitor移动应用.md](docs/第16课-Capacitor移动应用.md)，直接使用现有 Android/iOS 工程学习资源同步、运行时判断、原生插件、权限与安装包验收边界。

写代码时可以查阅 [docs/HTML基础语法速查表.md](docs/HTML基础语法速查表.md)。

## 学习方式

每一课都按照以下过程进行：

- 我先解释本课只需要理解的概念。
- 每课会列出语法规则、关键字、常见错误和代码规范。
- 你亲手输入代码，不要求死记。
- 我们一起启动页面并观察结果。
- 你完成一个很小的练习。
- 我检查代码并解释如何改进。

不要一次追求完整产品。每一课只新增少量知识，并保证项目始终可以运行。
