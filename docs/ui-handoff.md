# UI 交接文档（v0.1.0）

本文档面向接手前端落地与前后端联调的开发者/Agent。`v0.1.0` 已完成全部页面的可交互 UI 样板，数据来自浏览器内存 Mock。后续任务是**保持现有界面结构与交互规则不变**，把 Mock 换成真实 API，并补齐生产化细节。

- 需求与业务规则以 [`build-platform-design.md`](./build-platform-design.md) 为准；本文只描述 UI 已经确定的结构、交互和数据需求。两者冲突时以设计文档为准，并同步修正本文。
- 本期范围固定为设计文档第 9 节所列页面，不增加新页面、仪表盘或远程构建等能力。

## 1. 运行与技术约定

```bash
npm run dev -w @builder/web        # http://127.0.0.1:5173，/api 代理到 127.0.0.1:3000
npm run typecheck -w @builder/web
npm run build -w @builder/web
npx prettier --write apps/web/src  # 提交前格式化
```

演示账号（仅 Mock）：`admin / admin123456`（管理员）、`tester / tester123456`（普通用户）。

| 项           | 约定                                                                                                                                               |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 框架         | Vue 3 `<script setup>` + TypeScript（strict，开启 `exactOptionalPropertyTypes`，可选字段写成 `x?: T \| undefined`）                                |
| 组件库       | Element Plus 2.14.8 全量引入；图标用 `@element-plus/icons-vue`                                                                                     |
| 样式         | Tailwind CSS 4（`@tailwindcss/vite`），**只写工具类，不新增 `<style>` 块或自定义 CSS 文件**                                                        |
| 主题         | `src/styles.css` 中 `@theme` 定义 `brand-50…700`（主色 `#2563eb`）与字体；`:root` 同步 Element Plus `--el-color-primary*` 变量。改主色需两处同时改 |
| 覆盖 EP 样式 | Tailwind preflight 在 `@layer base`，EP 样式未分层优先级更高；需要覆盖时用 `!` 前缀（如 `!w-60`、`!mb-0`）                                         |
| 依赖版本     | 全部精确锁版本，新增依赖同样精确锁定                                                                                                               |

## 2. 目录结构

```
apps/web/src
├─ main.ts                 # 引入 element-plus 样式 → styles.css
├─ router.ts               # 路由、登录守卫、adminOnly 守卫、页面标题
├─ auth.ts                 # 当前用户、isAdmin、canManage()（目前为 Mock 版本）
├─ styles.css              # Tailwind 入口 + 主题变量（唯一的 CSS 文件）
├─ layouts/
│  ├─ AdminLayout.vue      # 管理端：顶部导航、槽位指示器、用户菜单
│  └─ PublicLayout.vue     # 公开下载端：简洁页头 + max-w-5xl 内容区
├─ pages/
│  ├─ LoginPage.vue
│  ├─ admin/  ProjectsPage / BuildsPage / ReleasesPage / UsersPage / SettingsPage
│  └─ public/ DownloadsPage / ProjectDownloadsPage
├─ components/
│  ├─ AppLogo.vue          # Logo + 可选副标题
│  ├─ PageHeader.vue       # 页面标题、说明、右侧操作插槽
│  ├─ ProjectAvatar.vue    # 项目图标（图片或名称首字 + 项目色），sm/md/lg/xl
│  ├─ StatusTag.vue        # 任务/测试状态标签（带状态圆点，进行中闪烁）
│  ├─ ProjectDrawer.vue    # 新建项目 / 构建配置 抽屉
│  ├─ BuildDialog.vue      # 发起构建弹窗
│  ├─ JobDrawer.vue        # 任务详情 + 实时日志抽屉
│  └─ ConfirmDialog.vue    # 统一确认弹窗（图标在左上角）
├─ utils/
│  ├─ confirm.ts           # openConfirm() / confirmDelete()，返回 Promise<boolean>
│  ├─ jobActions.ts        # 停止任务、删除任务、删除版本的「确认 → 调用 → 提示」流程
│  ├─ status.ts            # 任务状态、测试状态的文案/颜色/顺序（唯一来源）
│  └─ format.ts            # 相对时间、日期、耗时、文件大小、短 SHA
└─ mocks/
   ├─ types.ts             # 前端数据类型（联调时迁移为 API 类型）
   └─ db.ts                # 内存数据库 + 模拟调度器 + Mock API（联调后删除）
```

复用规则：

- 所有二次确认都走 `utils/confirm.ts`，不要直接用 `ElMessageBox`。物理删除用 `confirmDelete({ title, target, scope, note? })`，必须列出清理范围。
- 状态文案和颜色只从 `utils/status.ts` 取，页面内不写死。
- 页面统一结构：`PageHeader` + 白底圆角卡片（`rounded-xl border border-slate-200 bg-white`）。详情优先用右侧抽屉，不跳新页面。

## 3. 布局与导航

**管理端 `AdminLayout`**

- 顶部吸顶导航：Logo、导航（项目、构建队列、版本、用户\*、设置\*；\*仅管理员可见），当前项高亮下划线；窄屏导航横向滚动。
- 右侧：**槽位指示器**（`占用/上限 执行中 · N 排队`，点击进入构建队列，需实时刷新）、公开下载页入口图标、用户下拉（显示账号与角色，含退出登录）。
- 内容区 `max-w-7xl`。
- 顶部琥珀色「UI 演示环境…」横条为 Mock 专用，**联调后删除**。

**公开端 `PublicLayout`**：Logo（副标题「下载中心」）+ 右侧「管理端登录 →」，内容区 `max-w-5xl`。公开端页面**不得调用任何认证接口**。

**路由**

| 路径                           | 页面                | 权限                                   |
| ------------------------------ | ------------------- | -------------------------------------- |
| `/`                            | 重定向 `/login`     | —                                      |
| `/login`                       | 登录                | 公开                                   |
| `/admin/projects`              | 项目                | 登录                                   |
| `/admin/builds?project=<id>`   | 构建队列            | 登录                                   |
| `/admin/releases?project=<id>` | 版本                | 登录                                   |
| `/admin/users`                 | 用户                | 管理员（否则重定向 `/admin/projects`） |
| `/admin/settings`              | 设置                | 管理员                                 |
| `/downloads`                   | 项目下载入口        | 公开                                   |
| `/downloads/:projectSlug`      | 项目下载页          | 公开                                   |
| 其他                           | 重定向 `/downloads` | —                                      |

守卫逻辑：未登录访问 `/admin/*` 跳 `/login`；会话接口异常（非 401）跳 `/login?error=service`，登录页显示「无法确认登录状态」。页面标题为 `<页面名> · 构建平台`。

## 4. 页面规格

### 4.1 登录 `/login`

- 点阵背景，居中登录卡片：账号、密码（可显示）、错误提示（`role="alert"`）、登录按钮（loading 防重复提交）。
- 卡片下方蓝色大卡片「只需要下载构建版本？→ 前往项目下载」，右上角「项目下载」胶囊按钮。
- 登录成功跳 `/admin/projects`。
- 「演示账号（点击填入）」区块为 Mock 专用，**联调后删除**。

### 4.2 项目 `/admin/projects`

- 头部：项目数量说明、搜索框（匹配名称/仓库/slug），管理员可见「新建项目」。
- 卡片网格（sm 2 列 / xl 3 列），每张卡片包括：
  - 图标、名称、仓库路径，以及右上 ⋯ 菜单：构建配置（仅管理员）、构建记录、版本列表、公开下载页（新窗口）。
  - 描述。
  - 灰底信息区：「最近构建」（状态 + 编号，点击打开任务日志抽屉）、「最新版本」（测试状态 + 相对时间，无则「暂无版本」）。
  - 底部：`⑂ 默认分支 · 工作目录`；有进行中任务时显示「N 进行中」；「发起构建」按钮。
- 管理员且无搜索词时，末尾显示虚线「新建项目」卡片。

**项目配置抽屉 `ProjectDrawer`**（新建/编辑共用，仅管理员）

| 分区       | 字段与规则                                                                                                                                                           |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 基本信息   | 图标上传（PNG/JPG/WebP，≤ 2 MB，前端预校验，服务端必须再校验）、「使用默认图标」；项目名称（必填，≤ 40）；描述（≤ 120，展示在公开页）                                |
| 代码仓库   | Git 地址（必填，`git@` / `ssh://` / `https://` 开头）；默认分支（必填）；工作目录（必填，`./` 开头且不含 `..`，标签旁 `?` 提示 + 下方灰色说明块解释含义）            |
| 构建脚本   | 深色代码编辑区 `build.sh`，头部显示 `cd <工作目录> && bash -e build.sh`；右上显示「N 条命令」（忽略空行和 `#` 注释）；Tab 键插入两个空格；至少一条命令，否则校验失败 |
| 产物与限制 | 产物路径（必填，相对工作目录）；超时（5–180 分钟，步长 5）；提示「配置修改只影响之后发起的构建；已排队任务使用入队时的配置快照」                                     |

保存成功提示「构建配置已保存，下次构建生效」或「项目已创建」。

**发起构建弹窗 `BuildDialog`**

- 分支下拉（可搜索，也可输入未列出的分支）+「拉取代码」按钮。
- 只有当前所选分支**已拉取**时才能提交，并显示固定的提交（短 SHA、提交信息、拉取时间）；未拉取时显示警告并禁用提交。这是「入队即固定 commit」在 UI 上的保证，不能去掉。
- 显示槽位情况：有空位为绿色「当前有空闲槽位（占用/上限），入队后立即开始」；满时为琥珀色「执行槽位已满（占用/上限），将排在 N 个任务之后」。
- 摘要：工作目录、构建脚本命令数、超时。
- 提交成功提示「构建 #N 已加入队列」，并自动打开该任务的日志抽屉。

### 4.3 构建队列 `/admin/builds`

- 头部右侧：管理员可见「并行设置」按钮（跳设置页）。
- 概览三卡：
  - **执行槽位**：每槽一张卡，显示占用任务及进度条；空槽显示「空闲」；调低上限后占用可能暂时超过上限，按实际占用数显示。
  - **排队等待**：数量 + 下一个任务。
  - **近 24 小时成功率**：已停止的任务不计入。
- 筛选：分段控件「全部 / 进行中 / 成功 / 失败 / 已停止」（带数量）+ 项目下拉（与 `?project=` 双向同步）。
- 表格列：序号、项目/构建（图标、名称、#编号、提交信息）、`分支@短SHA`、状态（排队显示「第 N 位」，运行显示进度）、发起人、入队时间、耗时、操作（日志 / 停止 / 删除）。
- 排序：执行中 → 排队（按序号升序）→ 其余（按序号倒序）。
- 点击行打开 `JobDrawer`。

**任务抽屉 `JobDrawer`**

- 头部：项目图标、名称 #编号、状态、提交信息；信息栏：分支/提交、发起人、入队时间、耗时。
- 阶段进度条：**拉取源码 → 执行构建脚本 → 收集产物**，每段显示完成、进行中、失败或未开始。
- 日志区（深色终端风格）：`$ ` 和 `+ ` 开头的命令行高亮，错误行红色，成功行绿色；默认自动跟随到底部，用户上滑后暂停跟随，并出现「跟随最新日志」按钮；排队中显示排队位置。
- 底部：失败原因；按权限显示「停止构建」（运行中）、「删除任务」（非执行中）；成功时显示「查看版本」（跳版本页并按项目筛选）。

**停止与删除规则**（`utils/jobActions.ts`）

- **停止**（仅 `running`）：确认弹窗为琥珀色图标。确认后进入 `canceling`（停止中，仍占槽位），后端确认进程真的终止后才变为 `canceled` 并释放槽位。
- **删除**（`queued` / `succeeded` / `failed` / `canceled`，不能删除 `running` / `canceling`）：确认弹窗为红色图标，列出清理范围：
  - 排队任务：从队列移除、删除任务记录及配置快照。
  - 已结束任务：删除源码与依赖目录、日志与临时文件、对应版本及产物（同时提示公开下载会立即失效）、数据库记录。
- **权限**：管理员可操作任意任务；普通用户只能操作自己发起的任务（`canManage(triggeredBy)`）。按钮按权限隐藏，服务端必须再次校验。

### 4.4 版本 `/admin/releases`

- 筛选：版本号搜索、项目下拉（`?project=` 同步，占位文字「全部项目」）、测试状态分段控件（全部 + 四种状态，带数量）。
- 表格：
  - 可展开行显示产物清单（文件名、大小、SHA-256、下载）。
  - 列：版本号（每个项目的最新版本带「最新」徽标）、项目、`分支@短SHA`、产物数量与总大小、构建时间、测试状态、操作。
- **测试状态行内修改**：点击状态标签弹出四色下拉；下方小字显示「修改人 · 相对时间」。修改时提交 `revision`，冲突时提示「该版本状态已被他人修改，请确认后重试」。登录用户均可修改。
- 操作：公开下载页链接；删除版本（`canManage`，确认弹窗列出：N 个产物文件且公开下载立即失效、对应构建任务/日志/源码副本、测试状态记录）。

测试状态（固定颜色，来自 `utils/status.ts`）：已测试（绿）、待测试（黄，新版本默认）、测试中（蓝）、测试不通过（红）。

### 4.5 用户 `/admin/users`（仅管理员）

- 表格：头像（管理员深色）、账号与显示名（当前用户带「（你）」，禁用的行半透明）、角色（行内下拉）、启用开关、最近登录、创建时间、操作（重置密码、删除）。
- 不能修改自己的角色和启用状态；系统必须至少保留一个启用的管理员（后端校验并返回错误文案）。
- **新建用户**弹窗：账号（`^[a-z][a-z0-9._-]{2,31}$`）、显示名称（可选）、角色、初始密码（≥ 8 位，自动生成 12 位，可重新生成）。
- **重置密码**弹窗：自动生成新密码，提示「对方现有会话将失效」。
- **删除用户**：
  - 自己和最后一个启用的管理员不能删除，按钮置灰，悬停提示原因。
  - 确认弹窗列出：账号、密码、角色信息，以及全部会话（立即下线）。
  - 并注明：其发起的 N 个构建任务和测试记录保留原账号名；同名重建视为新账号。

### 4.6 设置 `/admin/settings`（仅管理员）

- 唯一设置项：并行构建数（1–16）。
- 槽位预览：已占用的槽为实心，空闲为虚线；超出新上限的槽变淡。
- 改动后显示效果提示：调高会立即补位最多 N 个；调低不会中断正在执行的任务。
- 「还原」「保存」按钮仅在有改动时可用。保存后调度器立即按新上限补位。

### 4.7 公开下载入口 `/downloads`

- 居中标题「项目下载」+ 搜索框。
- 项目卡片网格（2 列）：图标、名称、最新版本号 + 测试状态 + 相对时间（无版本显示「暂无可下载版本」），以及版本数量。
- 无匹配时显示「没有匹配的项目」。

### 4.8 项目下载页 `/downloads/:projectSlug`

- 「← 全部项目」返回链接；项目头（xl 图标、名称、描述）。
- 测试状态分段筛选（全部 + 四种状态），切换时回到第 1 页。
- 第 1 页首条为**最新版本**大卡片：徽标为「最新版本」，或「最新『某状态』版本」；列出产物和主下载按钮。
- 其余为「历史版本」列表，每页 5 条，超过 5 条显示分页。
- 排序：构建时间倒序，时间相同时按任务 ID 倒序。
- 空状态：
  - 项目没有任何版本：「暂无可下载版本」。
  - 筛选后没有结果：「暂无符合条件的版本」。
  - slug 不存在：结果页「项目不存在」+ 返回按钮。
- 下载目前为演示提示，联调时改为真实下载链接（`<a href download>`）。

## 5. 数据模型（UI 所需字段）

以 `mocks/types.ts` 为基础，联调时迁移到 `src/api/types.ts`。下面标出 Mock 专用、需要删除或替换的字段。

| 类型      | 字段                                                                                                                                                                  | 说明                                                                                                                                                                                |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| User      | `id, username, displayName, role('admin'\|'user'), enabled, createdAt, lastLoginAt\|null`                                                                             | **删除 `password`**（API 永不返回）。现有 `/api/auth/me` 只返回 `id, username, role`，用户列表需要补全字段                                                                          |
| Project   | `id, slug, name, description, repository, defaultBranch, branches[], workdir, buildScript, artifactPath, timeout, icon?`                                              | `icon` 在 Mock 中是 dataURL，真实环境改为服务端受控的图片 URL。`color` 为 Mock 字段，建议前端按 slug 哈希出颜色，不入库。`fetched{branch,sha,message,at}` 为最近一次拉取结果        |
| Job       | `id, seq, number, projectId, branch, sha, message, status, triggeredBy, createdAt, startedAt, finishedAt, snapshot{workdir,buildScript,artifactPath,timeout}, error?` | **删除 `script / visibleLines / plannedMs`**（Mock 用来模拟日志）。新增 `phase: 0\|1\|2`（拉取源码/执行脚本/收集产物）驱动阶段进度条；`progress` 可选，没有则进度条显示为不确定状态 |
| JobStatus | `queued, running, canceling, succeeded, failed, canceled`                                                                                                             | `running` 和 `canceling` 占用槽位（`OCCUPYING`）                                                                                                                                    |
| Release   | `id, jobId, projectId, version(<slug>-b<number>), branch, sha, createdAt, triggeredBy, testStatus, testUpdatedBy, testUpdatedAt, revision, artifacts[]`               | `revision` 用于并发修改检测                                                                                                                                                         |
| Artifact  | `id, name, size, sha256`                                                                                                                                              | 增加下载地址或按 id 拼接                                                                                                                                                            |
| 日志      | 纯文本按行返回                                                                                                                                                        | 前端按前缀识别：`$ ` / `+ ` 为命令，`kind` 可由服务端标注 `error` / `ok`                                                                                                            |

公开接口只返回公开字段：项目的 `slug, name, description, icon`，版本和产物信息。**不得返回 `repository`、`buildScript`、`triggeredBy` 等内部信息。**

## 6. Mock → 真实 API 迁移

### 6.1 Mock 函数与建议接口

接口路径为建议，可按服务端模块划分调整，但响应字段需满足第 5 节。所有写操作带 `X-CSRF-Token`；错误响应体为 `{ message }`，前端直接用 `ElMessage.error(message)` 展示。

| Mock（`mocks/db.ts`）                                   | 建议接口                                                                                                                                 | 备注                                                                                                                                                                                           |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `authenticate` / 会话                                   | `POST /api/auth/login`、`GET /api/auth/me`、`POST /api/auth/logout`                                                                      | **已在服务端实现**。前端可从提交 `3b2d9d9` 的 `apps/web/src/auth.ts` 恢复 `request()`、`ApiError`、CSRF 处理（`git show 3b2d9d9:apps/web/src/auth.ts`），保留现有 `isAdmin` / `canManage` 导出 |
| `db.projects`                                           | `GET /api/projects`                                                                                                                      | 建议附带 `latestJob`、`latestRelease`、`activeCount` 摘要，避免项目页拉取全部任务                                                                                                              |
| `saveProject`                                           | `POST /api/projects`、`PUT /api/projects/:id`                                                                                            | 图标用 multipart 上传；不传图标表示保留，显式清除表示恢复默认                                                                                                                                  |
| `fetchCode`                                             | `POST /api/projects/:id/fetch` `{branch}`                                                                                                | 返回 `{branch, sha, message, at}` 和最新 `branches`                                                                                                                                            |
| `enqueueBuild`                                          | `POST /api/jobs` `{projectId, branch, sha}`                                                                                              | 发起人由会话决定，不信任前端；服务端校验 sha 是该分支最近拉取的结果                                                                                                                            |
| `db.jobs`                                               | `GET /api/jobs?project=&status=`、`GET /api/jobs/:id`                                                                                    |                                                                                                                                                                                                |
| 日志                                                    | `GET /api/jobs/:id/log?offset=`                                                                                                          | 返回 `{lines, nextOffset, done}`，用于增量轮询                                                                                                                                                 |
| 槽位摘要（顶栏/队列概览）                               | `GET /api/queue`                                                                                                                         | `{maxConcurrent, occupied, queued, slots: JobSummary[]}`                                                                                                                                       |
| `stopJob`                                               | `POST /api/jobs/:id/stop`                                                                                                                | 非 running 返回 409                                                                                                                                                                            |
| `deleteJob`                                             | `DELETE /api/jobs/:id`                                                                                                                   | 执行中返回 409「任务已开始执行，请先停止构建」                                                                                                                                                 |
| `db.releases`                                           | `GET /api/releases?project=&status=&q=`                                                                                                  |                                                                                                                                                                                                |
| `setTestStatus`                                         | `PATCH /api/releases/:id/test-status` `{status, revision}`                                                                               | 冲突返回 409                                                                                                                                                                                   |
| `deleteRelease`                                         | `DELETE /api/releases/:id`                                                                                                               |                                                                                                                                                                                                |
| `db.users` / `createUser` / `updateUser` / `deleteUser` | `GET/POST /api/users`、`PATCH /api/users/:id`、`POST /api/users/:id/password`、`DELETE /api/users/:id`                                   | 自我保护和保留管理员规则由服务端校验                                                                                                                                                           |
| `db.settings` / `saveSettings`                          | `GET/PUT /api/settings`                                                                                                                  | `{maxConcurrent}`                                                                                                                                                                              |
| `publicReleases` 等公开数据                             | `GET /api/public/projects`、`GET /api/public/projects/:slug/releases?status=&page=&pageSize=5`、`GET /api/public/artifacts/:id/download` | 免认证；分页改为服务端分页                                                                                                                                                                     |

### 6.2 实时刷新

Mock 通过响应式 `db` 和每秒运行的 `tick()` 实现实时变化，真实环境改为轮询（本期不引入 WebSocket）：

- 顶栏槽位指示器、构建队列页、项目页：约每 3 秒刷新 `GET /api/queue` 和相应列表。
- 任务抽屉：任务进行中时约每 1 秒增量拉取日志，结束后停止。
- 页面不可见（`document.visibilityState === 'hidden'`）时暂停轮询。
- `now`（相对时间刷新用的时钟）保留为独立的前端工具，不再依赖 Mock。

### 6.3 建议迁移步骤

1. 新建 `src/api/`（`client.ts` 放 request / ApiError / CSRF，按模块拆分请求函数），类型迁到 `src/api/types.ts`。
2. 恢复真实 `auth.ts`。
3. 每完成一个服务端模块，就把对应页面从 `mocks/db` 切换到 `api/*`，并按第 7 节核对交互。
4. 所有页面切换完成后删除 `src/mocks/`，并确认无残留引用：`grep -r mocks apps/web/src` 结果为空。

## 7. 联调后清理清单

- [ ] 删除 `AdminLayout` 中「UI 演示环境」横条。
- [ ] 删除 `LoginPage` 中演示账号区块（`demoAccounts`）。
- [ ] 把 `ReleasesPage` 的 `demoDownload` 和 `ProjectDownloadsPage` 的 `download()` 改为真实下载链接。
- [ ] 删除 `src/mocks/`，`auth.ts` 不再引用 Mock。
- [ ] 更新 README 的预览说明。
- [ ] 可选：Element Plus 改为按需引入（目前主包超过 500 KB，构建时有警告）。

## 8. 交互验收要点

联调后逐项人工或自动化验证。业务层面的 P0/P1 验收见设计文档第 9 节。

- [ ] 普通用户看不到「用户」「设置」导航、「新建项目」和「构建配置」；直接访问 `/admin/users` 会被重定向。
- [ ] 公开页面在未登录时可正常访问，网络请求中没有认证接口。
- [ ] 分支未拉取时不能发起构建；拉取后显示固定的提交。
- [ ] 并行上限为 2 时提交 5 个任务：槽位卡片显示 2 个执行中，排队显示第 1–3 位，任务结束后按顺序补位。
- [ ] 停止任务：先显示「停止中」，确认终止后变为「已停止」并释放槽位。
- [ ] 删除执行中的任务被拒绝；删除已结束任务后，对应版本和公开下载同步消失。
- [ ] 两个窗口同时修改同一版本的测试状态，后提交的一方收到冲突提示。
- [ ] 不能删除自己或最后一个启用的管理员；删除用户后，其历史任务仍显示原账号名。
- [ ] 下载页：筛选后回到第 1 页；首条为最新版本；超过 5 条时分页；两种空状态文案正确。
- [ ] 日志：运行中自动跟随，上滑后暂停并出现「跟随最新日志」按钮。
- [ ] 所有确认弹窗的图标位于左上角，删除类弹窗列出清理范围。
- [ ] 窄屏（≤ 640px）：导航可横向滚动，页面无水平滚动条，抽屉占满宽度。
