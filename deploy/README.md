# 部署模板

`compose.production.example.yml` 提供一个单机容器部署基线：PostgreSQL、一次性迁移任务、API、静态 PWA/反向代理。Web 端口只绑定 `127.0.0.1`，必须再由实际服务器上的 HTTPS 网关公开，不能直接把示例 HTTP 端口暴露到互联网。

启动前至少提供：

```text
DIARY_DB_PASSWORD=数据库密码
DIARY_DATABASE_URL=postgresql://diary:经过百分号编码的数据库密码@postgres:5432/diary
DIARY_APP_SECRET=至少64字符的密码学随机值
DIARY_WEB_ORIGIN=https://你的正式域名
```

`DIARY_DB_PASSWORD` 与 URL 中解码后的密码必须一致。不要把真实值写进仓库、截图或工单。先解析配置，再构建和启动：

```powershell
docker compose --env-file 你的安全环境文件 -f deploy/compose.production.example.yml config
docker compose --env-file 你的安全环境文件 -f deploy/compose.production.example.yml build
docker compose --env-file 你的安全环境文件 -f deploy/compose.production.example.yml up -d --wait
```

迁移成功后 API 才会启动，API 健康后 Web 才进入健康状态。数据库、图片和导出使用三个独立持久卷；备份时必须把它们作为同一批次处理。机器可通过容器内部或受保护的监控代理轮询 `/api/v1/health/ready` 和 `/api/v1/health/operations`，两个运维接口拒绝非回环直接访问。

此模板不是已完成的正式发布：需要实际域名/TLS、外部备份、告警接收方、容量策略、镜像仓库、签名发布、漏洞扫描和回滚演练。首次上线前还必须按 [备份、恢复与运维](../docs/备份恢复与运维.md) 完成隔离恢复验证。
