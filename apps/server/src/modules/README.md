# 业务模块边界

- `auth/`：密码哈希、登录/会话/退出、Origin 和 CSRF 边界。
- `platform/`：项目与图标、Git 拉取、队列与调度、版本和产物、用户与设置、备份接口。数据库操作在专用 Worker 内的短事务执行，SQL 均为单表。
- `../tools/`：Git/Bash 子进程、本机与 Docker 执行器、路径及产物校验、离线恢复。

开发阶段使用受信任仓库的本机执行模式。Docker 与生产环境边界及待验收项见 `docs/runtime.md`。
