# builder-service

面向 Linux 的构建与版本发布平台，使用 Node.js 和 SQLite。已接入真实 API、持久化队列、Git/Bash/Node.js 构建和公开产物下载；开发阶段按用户要求采用本机执行。Docker 模式须在目标服务器单独验收。

- [运行与执行边界](docs/runtime.md)：本机启动、API、备份恢复及服务器 Docker 配置。
- [实施与验收记录](docs/implementation-acceptance.md)：测试范围、浏览器结果和未完成的环境验收。

- [构建平台设计方案](docs/build-platform-design.md)：架构、Git 操作、并行队列、构建隔离、账号权限、版本状态和实施验收计划。

## 环境与启动

需要 Node.js 24 LTS 和 npm 11，以及 Git、Bash、OpenSSH 客户端和 OpenSSL。`better-sqlite3` 包含原生模块，需在目标操作系统安装依赖；没有匹配预编译包时，需要 Python、C/C++ 编译器及系统构建工具。以下命令均在仓库根目录执行。

### 首次配置

安装依赖并创建本地配置。已有 `.env` 时跳过复制，保留原有配置和主密钥；`cp -n` 用于避免覆盖已有文件。

```bash
npm ci
cp -n apps/server/.env.template apps/server/.env
chmod 600 apps/server/.env
```

首次初始化时，生成独立的 SSH 私钥加密主密钥：

```bash
openssl rand -base64 32
```

将生成结果填入 `apps/server/.env` 的 `BUILDER_SECRET_KEY=` 后并保存，再启动服务。模板中的该项刻意留空，不提供共用密钥。恢复已有数据库时必须使用原主密钥，不要重新生成。

### `.env.template` 与 `.env` 的关系

- `apps/server/.env.template` 是提交到仓库的配置模板，提供变量说明和本机开发默认值，不包含真实密钥，服务不会直接读取它。
- `apps/server/.env` 是从模板复制并填写后的实际运行配置，由后端启动命令读取，已被 Git 忽略，不得提交。请放在 `apps/server` 下，根目录的 `.env` 不会被当前启动命令读取。
- 模板更新不会自动同步到已有 `.env`，需手动补充新增变量。旧的 `.env.example` 仅为兼容保留，新环境统一使用 `.env.template`。
- `BUILDER_SECRET_KEY` 必须是 32 字节随机值的 base64 编码，重启和更新代码时保持不变，并与数据库备份分开保管。丢失或替换后，已有 SSH 私钥将无法解密。

### 启动与检查

配置完成后启动前后端；后续启动直接运行此命令即可：

```bash
npm run dev
```

浏览器打开 `http://127.0.0.1:5173/`，后端健康检查为 `http://127.0.0.1:3000/api/health`。使用 `127.0.0.1` 访问以匹配默认 `APP_ORIGIN`；如改用 `localhost` 或其他端口，需同步调整 `.env` 中的 `APP_ORIGIN`。修改 `.env` 后停止并重新运行 `npm run dev` 才会生效。

若 SSH 密钥或受信任主机列表提示 `BUILDER_SECRET_KEY 缺失或无效`，检查实际 `.env` 中的主密钥是否已填写且格式正确，并重启后端。健康检查正常仅说明 API 已启动，缺少主密钥时这两项功能仍会返回 503。

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
