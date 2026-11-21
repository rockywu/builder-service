# 本地 Docker 开发环境

源码以 bind mount 挂入容器，前端 Vite HMR、API `tsc-watch` 自动重启；API 仍使用 Docker 执行器，可调试真实构建。生产形态的演示部署见 [local.md](local.md)。

## 启动

需要 Docker Desktop（或提供 `/var/run/docker.sock` 的本机引擎），仓库须位于 Docker 可共享的目录。在仓库根目录执行：

```bash
deploy/dev.sh          # 首次会构建任务镜像与开发镜像并安装依赖
deploy/dev.sh logs -f  # 查看日志
deploy/dev.sh down     # 停止（数据与依赖卷保留）
```

- 前端 <http://127.0.0.1:5173>，API <http://127.0.0.1:3000>（前端 `/api` 由 Vite 代理到 `api` 容器）。
- 与[本地 Docker 测试](local.md)共用同一套数据：SQLite 数据目录 `var/docker-local/storage/data`、主密钥（`var/docker-local/server.env`）和任务镜像 `builder-runtime:local-node24`。`deploy/dev.sh` 每次启动用该配置加上 `APP_ORIGIN=http://127.0.0.1:5173`、`LOG_LEVEL=debug` 生成 `var/docker-dev/server.env`，所以项目、SSH 密钥、版本在两个环境中一致。
- **两个环境不能同时运行**：同一份数据库由调度器锁保护，只允许一个 API 实例。切换前先停另一个（本地部署停止命令见 [local.md](local.md#构建并启动)）。初始管理员见[仓库说明](../README.md#环境与启动)。
- 改 `apps/web/src` 即时热更新；改 `apps/server/src` 后 `tsc-watch` 重新编译并重启 API。修改 `package.json` / `package-lock.json` 后重新执行 `deploy/dev.sh` 会自动重装依赖。
- `node_modules` 保存在命名卷，避免 macOS 与 Linux 原生模块（better-sqlite3、sharp）混用。需要在宿主机运行类型检查或编辑器补全时，另在宿主机执行 `npm install`。

## 常用操作

| 目的          | 命令                                                                                      |
| ------------- | ----------------------------------------------------------------------------------------- |
| 进入 API 容器 | `deploy/dev.sh exec api bash`                                                             |
| 容器内跑测试  | `deploy/dev.sh exec api npm run test:platform -w @builder/server`                         |
| 类型检查      | `deploy/dev.sh exec api npm run typecheck`                                                |
| 重建任务镜像  | `REBUILD=1 deploy/dev.sh`                                                                 |
| 清空依赖卷    | `deploy/dev.sh down -v`（仅删除依赖卷，数据在 `var/docker-local/storage/data`，不受影响） |
| 国内镜像源    | `export BUILDER_LOCAL_IMAGE_PREFIX=docker.m.daocloud.io/library/`                         |

## 注意

- 前端热更新收不到文件事件（Docker Desktop 常见）时，设置 `VITE_USE_POLLING=1` 后重启；API 同理可设置 `TSC_WATCHFILE=PriorityPollingInterval`。
- API 容器挂载 Docker socket 且数据目录使用与宿主一致的绝对路径，仅用于本地开发，不要用于服务器。
- 任务容器的 Git/依赖下载网络行为与[本地 Docker 测试](local.md#git-与依赖下载)一致。
