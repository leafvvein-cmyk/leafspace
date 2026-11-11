# 第 11 课：SQLite 与 SQL

## 1. 本课目标

本课学习三个概念：

1. 用表、行、列和约束描述日记数据。
2. 用参数化 SQL 完成查询、插入和删除。
3. 用迁移与事务保证数据库结构和写入完整性。

```powershell
npm run learn:11
```

打开 <http://127.0.0.1:4187>。自动检查：

```powershell
npm run check:learn:11
```

运行服务会创建 `learning/lesson-11/data/lesson-11.sqlite`；它只属于课程 11，已从版本控制忽略。

## 2. 数据库与内存数组的区别

内存数组随服务器进程结束而消失。SQLite 把数据写入文件，并提供 SQL、约束和事务：

```text
Express 路由 → 参数化 SQL → SQLite 文件
```

SQLite 适合学习和单机应用。正式多用户服务器使用 PostgreSQL，因为需要并发连接、账号隔离、备份和多实例运行。

当前项目使用的 Node 22 会把内置 `node:sqlite` 标记为实验功能，启动时出现 ExperimentalWarning 属于运行时状态提示。课程因此固定在隔离数据库中；正式依赖选择必须重新核对目标 Node 版本、驱动稳定性和维护政策。

## 3. 表、行与列

```sql
CREATE TABLE entries (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  revision INTEGER NOT NULL
);
```

- 表 `entries` 保存同类记录。
- 每一行是一篇日记。
- 每一列是一个字段。
- PRIMARY KEY 唯一标识一行。
- NOT NULL 禁止缺失值。

## 4. 数据类型与 STRICT

SQLite 常用类型：`INTEGER`、`REAL`、`TEXT`、`BLOB`、`NULL`。本课使用 `STRICT` 表，减少把错误类型写入列的情况。

```sql
CREATE TABLE example (count INTEGER NOT NULL) STRICT;
```

类型仍不能代替业务验证，例如 TEXT 不知道标题最多 80 字符，需要 CHECK。

## 5. CHECK 约束

```sql
title TEXT NOT NULL CHECK(length(title) BETWEEN 2 AND 80)
```

网页和 API 已验证，但数据库约束保护最终写入。所有层规则应一致；规则变更要通过迁移演进。

## 6. 建表迁移

```sql
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);
```

启动时先检查版本 1 是否存在；没有才在事务中建表并记录版本。已经应用的迁移不能改写，否则不同设备或服务器会得到不同结构。

正式项目把每个迁移保存为不可变 SQL 文件，并按顺序应用。

## 7. 打开数据库

```js
import { DatabaseSync } from 'node:sqlite';
const database = new DatabaseSync(path);
database.exec('PRAGMA foreign_keys = ON');
```

外键默认行为需要明确开启。持久文件还使用 WAL 日志模式改善读写协调，但 WAL 文件也属于备份范围，不能只复制正在写入的主文件冒充一致备份。

## 8. SELECT

```sql
SELECT *
FROM entries
ORDER BY entry_date DESC, created_at DESC;
```

`ORDER BY` 明确结果顺序。没有 ORDER BY 时，数据库不承诺返回顺序。

生产查询尽量只选择需要的列；`SELECT *` 在本课用于展示完整行。

## 9. 预编译与参数

```js
const find = database.prepare('SELECT * FROM entries WHERE id=?');
const row = find.get(id);
```

问号是参数位置。数据库把 id 当数据，不当 SQL 代码。

永远不要这样拼接用户输入：

```js
database.prepare(`SELECT * FROM entries WHERE id='${id}'`);
```

字符串拼接会产生 SQL 注入风险，也破坏引号和特殊字符处理。

## 10. INSERT

```sql
INSERT INTO entries(
  id,title,content,entry_date,created_at,updated_at
) VALUES(?,?,?,?,?,?);
```

```js
insert.run(id, title, content, date, now, now);
```

列清单应明确写出，不依赖表当前列顺序。

## 11. UPDATE 与 revision

典型乐观并发更新：

```sql
UPDATE entries
SET title=?, revision=revision+1
WHERE id=? AND revision=?;
```

如果影响行数为 0，记录不存在或版本已经变化。正式同步据此返回冲突，不能让旧设备静默覆盖新内容。

本课页面只演示新增和删除，思考任务会补 UPDATE。

## 12. DELETE

```sql
DELETE FROM entries WHERE id=?;
```

检查 `result.changes`：0 表示没有匹配行，应返回 404。

正式日记默认软删除到回收站，并保留同步 tombstone；本课直接删除只用于理解 SQL。

## 13. 事务

```js
database.exec('BEGIN IMMEDIATE');
try {
  insert.run(...values);
  database.exec('COMMIT');
} catch (error) {
  database.exec('ROLLBACK');
  throw error;
}
```

事务确保一组操作全部提交或全部回滚。ROLLBACK 后仍要继续抛出错误，让 API 返回失败；不能回滚后显示成功。

## 14. 参数化 SQL 注入验证

自动测试保存标题：

```text
'); DROP TABLE entries; --
```

因为使用参数，它只是一段普通标题。测试随后重启数据库并再次 SELECT，表和记录都仍存在。

安全不能只靠“输入中没有单引号”；必须使用参数化语句和字段白名单。

## 15. 日期和时间

本课把日记日期存为 `YYYY-MM-DD` TEXT，把事件时间存为 ISO 8601 字符串。这样便于排序和跨语言读取。

日记日期是用户当地日期，不等于 UTC 时间戳。正式产品同时保存明确的 entryDate、createdAt、updatedAt 和必要时区语义。

## 16. 关闭数据库

```js
await new Promise((resolve) => server.close(resolve));
database.close();
```

先停止接收新 HTTP 请求，再关闭数据库。测试重启时必须释放文件句柄，Windows 尤其不能假设进程结束前文件已经可删除。

## 17. 备份不是复制一次文件

可靠备份需要：

- 一致性快照或数据库备份 API。
- 同时包含附件等外部文件。
- 加密、访问控制和保留周期。
- 定期恢复到隔离环境并核对内容。

“备份命令没有报错”不等于可以恢复。正式项目已有 PostgreSQL 与私密文件恢复演练，本课不把 SQLite 文件复制当生产方案。

## 18. 常见错误

### 拼接用户输入到 SQL

始终使用 `?` 参数或数据库驱动对应的参数语法。

### 没有 ORDER BY

查询顺序未定义，页面可能随执行计划变化。

### 只验证 API，不写数据库约束

其他脚本或未来代码仍可能写入非法数据。

### 修改已应用迁移

创建新迁移升级结构，不改写历史文件。

### catch 后忘记 ROLLBACK

连接可能保持在未完成事务中，后续请求继续失败。

### 关闭服务器但不关闭数据库

文件句柄和 WAL 状态可能未正确释放。

## 19. SQL 关键字

| 关键字 | 含义 |
| --- | --- |
| CREATE TABLE | 建立表 |
| SELECT | 查询行 |
| INSERT | 新增行 |
| UPDATE | 修改行 |
| DELETE | 删除行 |
| WHERE | 限制目标行 |
| ORDER BY | 指定排序 |
| PRIMARY KEY | 唯一主键 |
| NOT NULL | 禁止空值 |
| CHECK | 数据约束 |
| BEGIN | 开始事务 |
| COMMIT | 提交事务 |
| ROLLBACK | 回滚事务 |
| migration | 按版本升级数据库结构 |
| prepared statement | 预编译参数化语句 |
| SQL injection | 输入被错误解释为 SQL 代码的攻击 |

## 20. 动手任务

1. 创建两篇记录，重启服务后确认仍存在。
2. 在 SQLite 查询工具中执行只读 SELECT。
3. 给表增加 mood 列：不要改迁移 1，编写迁移 2。
4. 增加 PATCH 路由，使用 id + baseRevision 条件更新。
5. 故意提交旧 revision，返回 409 冲突。
6. 在事务中制造 CHECK 失败，确认没有部分写入。
7. 运行自动检查。

## 21. 完成检查表

- [ ] 能解释表、行、列和主键。
- [ ] 字段使用 NOT NULL 和 CHECK 保护。
- [ ] 数据库结构由版本化迁移创建。
- [ ] 已应用迁移不被改写。
- [ ] 所有用户值都通过参数绑定。
- [ ] SELECT 明确 ORDER BY。
- [ ] 写操作在需要时使用事务。
- [ ] 异常时执行 ROLLBACK 并继续抛错。
- [ ] 服务停止时关闭数据库。
- [ ] 重启持久化和注入字符串测试通过。
- [ ] 明白本课 SQLite 不等于正式多用户 PostgreSQL。

## 22. 思考题与参考答案

1. 为什么参数化 SQL 能处理单引号？
   - SQL 结构与参数值分开传给数据库，值不会被重新解释为语句片段。
2. CHECK 与 API 验证有什么区别？
   - API 提供友好业务错误；CHECK 保护数据库最终状态，防止其他写入路径绕过规则。
3. 为什么没有 ORDER BY 就不能依赖返回顺序？
   - SQL 结果集合默认无序，数据库可根据索引和执行计划改变行顺序。
4. 事务失败为什么要 ROLLBACK？
   - 撤销该事务内已执行操作并让连接回到可用状态。
5. revision 如何防止覆盖？
   - UPDATE 同时匹配 id 和旧 revision；版本不同则不更新，由应用报告冲突。
6. 为什么 SQLite 学习成功不证明正式服务完成？
   - 多用户并发、账号隔离、多实例、生产备份和运维需求不同，正式服务仍需 PostgreSQL 验证。

下一课将学习账号与密码安全：密码哈希、会话、恢复码、速率限制和为什么绝不能保存明文密码。
