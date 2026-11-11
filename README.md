# builder-service

面向 Linux 的构建与版本发布平台，使用 Node.js 和 SQLite。已接入真实 API、持久化队列、Git/Bash/Node.js 构建和公开产物下载；开发阶段按用户要求采用本机执行。Docker 模式须在目标服务器单独验收。

- [运行与执行边界](docs/runtime.md)：本机启动、API、备份恢复及服务器 Docker 配置。
- [实施与验收记录](docs/implementation-acceptance.md)：测试范围、浏览器结果和未完成的环境验收。

- [构建平台设计方案](docs/build-platform-design.md)：架构、Git 操作、并行队列、构建隔离、账号权限、版本状态和实施验收计划。

## 环境与启动

需要 Node.js 24 LTS 和 npm 11。`better-sqlite3` 包含原生模块，需在目标操作系统安装依赖；没有匹配预编译包时，需要 Python、C/C++ 编译器及系统构建工具。

```bash
npm ci
cp apps/server/.env.example apps/server/.env
npm run dev
```

### UI 与 API

现有界面保持不变，数据来自后端。请使用上面的 `npm run dev` 同时启动前后端。管理员默认 `admin / admin123456`（仅首次初始化），普通账号由管理员创建；浏览器刷新保留后端数据。Git 拉取与构建会执行真实命令，仅接入受信任仓库。

全局演示环境横条已按用户要求删除；登录页账号填充区继续保留。原内存 Mock 已移除。

### 完整服务

- 默认管理员：账号 `admin`，密码 `admin123456`。仅首次初始化创建，重启不重置。
- 公开下载入口：`http://127.0.0.1:5173/downloads`。
- 健康检查：`http://127.0.0.1:3000/api/health`；开发时前端代理 `/api` 到后端。
- 开发模式监视前后端源码并自动更新；使用 Ctrl+C 停止两个服务。
- 服务默认仅监听本机。环境变量从 `apps/server/.env` 读取，`DATA_DIR` 相对 `apps/server` 解析，默认写入仓库根目录 `var/`，已忽略提交。
- 若修改后端端口，需同步修改 `apps/web/vite.config.ts` 的开发代理目标。

## 常用命令

```bash
npm run typecheck
npm run build
npm run format:check
CI=true npm run test -w @builder/server
CI=true npm run test:platform -w @builder/server
npm start
```

`npm run build` 输出 `apps/server/dist` 和 `apps/web/dist`。`npm start` 仅启动编译后的 API，前端产物需由静态文件服务器提供；生产环境的 Nginx/systemd 配置不在本次交付中。使用 history 路由时，静态服务器需将前端页面路径回退到 `index.html`，`/api` 交给后端。

## 目录

```text
apps/
  server/
    src/
      app.ts          # Fastify 应用与健康检查
      index.ts        # 启动及关闭
      config.ts       # 环境配置
      db/             # better-sqlite3 Worker 启动/关闭
      modules/        # auth + platform API、调度与存储
      tools/          # Git、Bash、执行器、产物与恢复
  web/
    src/
      layouts/        # 管理端与公开页面布局
      pages/          # 管理与公开下载页面
      api/            # 请求、CSRF、轮询与数据适配
      router.ts       # 页面路由
docs/
  build-platform-design.md
```

登录页支持账号密码登录和错误提示，管理页面与管理 API 需要有效会话，管理端提供退出登录。SQLite 通过迁移创建业务表，密码使用 scrypt 哈希、会话仅保存 token 哈希。

下载页面使用独立公开布局，登录页有“前往项目下载”入口；`/downloads` 及项目下载页无需登录，不调用认证接口。产物通过按 ID 查找的受控下载接口提供，下载前核对大小和 SHA-256。

用户管理、项目图标、队列、构建、版本状态均通过服务端 API 操作。服务启动会恢复任务并领取已排队构建；启动前核对 `DATA_DIR` 和执行模式。

后端 `APP_ORIGIN` 必须与浏览器访问的前端来源完全一致，默认 `http://127.0.0.1:5173`。如果使用 localhost 或修改前端端口，请同步修改该变量。生产使用同一 HTTPS 域名；`NODE_ENV=production` 要求 HTTPS 来源，session cookie 随 HTTPS 来源启用 Secure。认证写接口校验 Origin，并对已有会话校验 CSRF token。

本次实施决定和限制见 [implementation-notes.md](implementation-notes.md)。
