# builder-service

面向 Linux 的构建与版本发布平台，使用 Node.js 和 SQLite。当前已搭建代码脚手架并接入账号密码登录，其余构建业务尚未实现。

- [构建平台设计方案](docs/build-platform-design.md)：架构、Git 操作、并行队列、构建隔离、账号权限、版本状态和实施验收计划。

## 环境与启动

需要 Node.js 24 LTS 和 npm 11。`better-sqlite3` 包含原生模块，需在目标操作系统安装依赖；没有匹配预编译包时，需要 Python、C/C++ 编译器及系统构建工具。

```bash
npm ci
cp apps/server/.env.example apps/server/.env
npm run dev
```

### 纯前端 UI 预览

前端使用 Element Plus 组件 + Tailwind CSS 工具类，已按设计文档第 9 节完成全部页面的可交互样板：项目（配置抽屉、发起构建）、构建队列（执行槽位、实时日志、停止/删除）、版本（四色测试状态、删除）、用户、设置（并行数），以及公开下载入口和项目下载页。数据均为浏览器内存 Mock，内置模拟调度器按并行上限 FIFO 执行任务，无需启动后端或配置 `.env`：

```bash
npm run dev -w @builder/web
```

访问 `http://127.0.0.1:5173`，演示账号：管理员 `admin / admin123456`，普通用户 `tester / tester123456`（无项目配置、用户和设置权限）。刷新页面即恢复演示数据，不会拉取 Git 代码或执行真实构建。

### 完整服务（现有脚手架）

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
      modules/        # 已实现 auth，其余业务保留边界说明
  web/
    src/
      layouts/        # 管理端与公开页面布局
      pages/          # 页面占位组件
      router.ts       # 页面路由
docs/
  build-platform-design.md
```

登录页支持账号密码登录和错误提示，管理页面与管理 API 需要有效会话，管理端提供退出登录。SQLite 已创建 users、sessions 表，密码使用 scrypt 哈希、会话仅保存 token 哈希。

下载页面使用独立公开布局，登录页有“前往项目下载”入口；`/downloads` 及项目下载页无需登录，不调用认证接口。当前下载数据仍为页面占位，尚未实现实际产物下载。

用户管理、Git、队列调度、构建执行、图标上传及版本状态业务尚未开发。启动不会执行 Git 或构建命令。

后端 `APP_ORIGIN` 必须与浏览器访问的前端来源完全一致，默认 `http://127.0.0.1:5173`。如果使用 localhost 或修改前端端口，请同步修改该变量。生产使用同一 HTTPS 域名；`NODE_ENV=production` 要求 HTTPS 来源，session cookie 随 HTTPS 来源启用 Secure。认证写接口校验 Origin，并对已有会话校验 CSRF token。

本次实施决定和限制见 [implementation-notes.md](implementation-notes.md)。
