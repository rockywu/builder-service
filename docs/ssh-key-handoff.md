# SSH 密钥与提示规范：开发交接

> 交接日期：2026-11-12。面向接手开发的 agent。
> 必读：`AGENTS.md`（实施规则）、`docs/ssh-key-api.md`（接口契约，**本文不重复其中细节，冲突时以契约为准**）、`docs/ui-handoff.md`、`docs/build-platform-design.md`。

## 0. 一句话现状

前端已完成并提交于 `4f21e2b`。后端已补齐存储迁移、主密钥加密、8 个管理接口、项目绑定、任务快照和 Git 凭据注入；当前变更尚未提交，专项测试与回归结果以 `docs/implementation-acceptance.md` 为准。Docker 实际挂载、目标网络与生产部署仍须单独验收。

> 下方保留原交接任务拆分。已完成的后端实现保持既有 UI，新增逻辑位于 `tools/ssh.ts` 及现有平台模块。

---

## 1. 本次已完成的设计调整（不得改动）

按 `AGENTS.md`，下面的视觉与交互已定稿，后端联调只能改数据接入，不能改模板结构、样式、文案。

### 1.1 统一提示条 `NoticeBar`

- 文件：`apps/web/src/components/NoticeBar.vue`
- 规范：浅色底 + 同色 1px 描边 + 14px 顶对齐图标 + 12px 正文（`leading-5`），圆角 `rounded-md`，内边距 `px-3 py-2`；内容走默认插槽，可含 `<code>`、链接、按钮（链接/按钮加 `whitespace-nowrap`，避免折行）。
- `tone`：`info`（灰，说明，默认）/ `warning`（琥珀，风险或阻断）/ `success`（绿，可立即执行）/ `danger`（红）。warning/danger 带 `role="alert"`。
- 规则（已写入 `docs/ui-handoff.md` 技术约定表）：**弹窗与抽屉内的提示一律用 `NoticeBar`，不用 `el-alert`，不手写 `bg-amber-50` 等提示块。**

已替换位置：

| 文件                  | 提示                                                       | tone              |
| --------------------- | ---------------------------------------------------------- | ----------------- |
| `BuildDialog.vue`     | 该分支尚未拉取…                                            | warning           |
| `BuildDialog.vue`     | 槽位状态（空闲 / 排队）                                    | success / warning |
| `BuildDialog.vue`     | 拉取凭据提示（见 1.2）                                     | warning           |
| `ProjectDrawer.vue`   | 主机 X 尚未加入受信任主机…前往设置                         | warning           |
| `ProjectDrawer.vue`   | 工作目录说明；配置修改只影响之后发起的构建…                | info              |
| `SshKeyDialog.vue`    | 服务端生成的密钥不能更换私钥…；更换私钥影响提示 + 取消更换 | info / warning    |
| `KnownHostDialog.vue` | 请逐一核对指纹…                                            | warning           |

刻意未替换（属于内容块而非提示）：`ConfirmDialog` 的「将永久清理」列表、`SshKeyDialog` 生成结果卡片、`BuildDialog` 顶部项目摘要、设置页卡片底栏。

### 1.2 发起构建弹窗：拉取前凭据提示

- 文件：`apps/web/src/components/BuildDialog.vue`；`pages/admin/ProjectsPage.vue` 增加 `@configure="openConfig"`。
- 位置：项目摘要与「构建分支」之间。**只提示，不阻止拉取。** HTTPS 仓库不提示。

| 条件                                                                  | 文案                                                | 操作                                                                                   |
| --------------------------------------------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------- |
| SSH 地址且 `project.sshKeyId == null`                                 | 该仓库使用 SSH 地址但未绑定拉取密钥，拉取会失败。   | 管理员：「去配置」→ 关闭弹窗并打开该项目构建配置抽屉；普通用户：「请联系管理员配置。」 |
| 已绑定密钥，且主机（host+port）不在 `known_hosts`（**仅管理员**判断） | 主机 `host[:port]` 尚未加入受信任主机，拉取会失败。 | 「前往设置」新标签页打开 `/admin/settings`                                             |

- 主机列表仅管理员可读：弹窗打开时管理员调用 `loadKnownHosts()`，失败静默不提示。
- 主机解析用 `sshHostOf()`（`apps/web/src/api/store.ts`）：`git@host:path` → 端口 22；`ssh://[user@]host[:port]/path`，IPv6 去方括号。**后端生成 known_hosts 与比对时必须与此规则一致**，否则前端提示与真实拉取结果会不一致。

### 1.3 拉取时不选密钥（设计决定）

密钥绑定在项目上（只有管理员可改），拉取与构建都用项目绑定的密钥；发起构建弹窗「拉取凭据」只读显示 `sshKeyName ?? '匿名'`。**不要**在拉取步骤增加密钥选择。

---

## 2. 前端已接好的数据层（后端照此实现即可）

`apps/web/src/api/store.ts`、`types.ts`：

| 前端函数                          | 接口                                   | 用途页面                                 |
| --------------------------------- | -------------------------------------- | ---------------------------------------- |
| `loadSshKeys()`                   | `GET /api/ssh-keys`（分页）            | 设置页、项目抽屉下拉                     |
| `createSshKey(input)`             | `POST /api/ssh-keys`                   | `SshKeyDialog` 生成 / 导入               |
| `updateSshKey(id, patch)`         | `PATCH /api/ssh-keys/:id`              | 改名 / 更换私钥                          |
| `deleteSshKey(id)`                | `DELETE /api/ssh-keys/:id`             | 设置页删除（确认弹窗列出受影响项目）     |
| `loadKnownHosts()`                | `GET /api/known-hosts`（分页）         | 设置页、项目抽屉、发起构建弹窗（管理员） |
| `scanKnownHost(host, port)`       | `POST /api/known-hosts/scan`           | `KnownHostDialog`                        |
| `addKnownHosts(host, port, keys)` | `POST /api/known-hosts`                | 信任所选公钥                             |
| `deleteKnownHost(id)`             | `DELETE /api/known-hosts/:id`          | 设置页移除                               |
| `saveProject` 等                  | `POST/PUT /api/projects` 带 `sshKeyId` | 项目抽屉（HTTPS 时前端发送 `null`）      |
| `fetchCode(id, branch)`           | `POST /api/projects/:id/fetch`         | 只发分支，服务端使用项目绑定的密钥       |

分页格式 `{ items, total, nextOffset }`（`apps/web/src/api/client.ts` 的 `all()`）。错误统一 `{ message }`，前端原样展示，**message 即用户文案**。

---

## 3. 后端实施清单

现有后端结构：Fastify 路由 `apps/server/src/modules/platform/routes.ts`，业务 `service.ts`，SQLite 存储与迁移 `store.ts`（`user_version` 当前为 4，项目/任务以 JSON `payload` 列存储），执行 `apps/server/src/tools/runner.ts`、`process.ts`，配置 `config.ts`，测试 `apps/server/test/ssh.test.mjs` 与 `platform.test.mjs`。

### A. 存储与迁移（`store.ts`）

- [x] `user_version` 3 → 4 迁移：新建 `ssh_keys`（id、name UNIQUE、type、source、fingerprint、public_key、encrypted_private_key BLOB、created_at、updated_at、last_used_at）与 `known_hosts`（id、host、port、key_type、public_key、fingerprint、created_at，UNIQUE(host,port,key_type)）。
- [x] 项目以 payload 存储：`Project` 增加 `sshKeyId: number | null`（老数据缺省视为 `null`）。采用 payload 方案，**删除密钥时同事务把引用置空**，并能查询某密钥被哪些项目引用（`SshKey.projectIds`）。
- [x] 任务快照：`types.ts` 的 `Job.snapshot` 增加 `sshKeyId`，入队时写入。

### B. 私钥加密与配置

- [x] `config.ts` 读取 `BUILDER_SECRET_KEY`（32 字节 base64）；AES-256-GCM，每条随机 nonce，存 `nonce + ciphertext + tag`。
- [x] 缺失/长度错误：密钥相关接口返回 503 + 原因；其他功能正常；**绝不回退明文**。
- [x] `apps/server/.env.example`、`docs/runtime.md` 补生成命令（如 `openssl rand -base64 32`）与备份说明（主密钥与数据库分开保管；丢失主密钥=全部私钥失效）。

### C. 密钥与主机接口（`routes.ts`）

- [x] 8 个接口全部按契约实现：仅管理员（复用 `admin(r)`）、非 GET 校验 CSRF、分页。
- [x] 生成：ed25519，输出 OpenSSH 单行公钥与 `SHA256:` 指纹（与 `ssh-keygen -lf` 一致）。导入：≤16 KB，仅无口令 OpenSSH/PEM，RSA ≥ 2048；失败 400「仅支持无口令的 OpenSSH 私钥」。
- [x] `PATCH` 的 `privateKey` 只允许 `source='imported'`。
- [x] `scan`：`ssh-keyscan` 用参数数组、超时 10 s、走 Git 受限网络，不保存；遵守私网/元数据地址出口策略。
- [x] `POST /known-hosts`：服务端重算指纹并与提交值比对，不一致拒绝；同 host+port+keyType 覆盖。
- [x] 审计（`audit()`）：密钥新增/改名/更换/删除、主机信任/移除，只记名称与指纹。
- [x] **任何响应、日志、审计、错误信息都不得出现私钥。**

### D. 项目接口集成

- [x] `saveProject()`（`routes.ts` 约 206 行）读取并校验 `sshKeyId`：SSH 地址为空 → 400「SSH 地址需要选择密钥」；指向不存在的密钥 → 400；HTTPS 允许携带但执行时忽略。已接入存储并在事务内复核密钥引用。
- [x] `GET /api/projects` 对所有登录用户返回 `sshKeyId` 与 `sshKeyName`（不返回其他密钥信息）。公开接口 `/api/public/projects` **不得**返回。

### E. 执行器（核心安全点）

默认命令继续禁用宿主身份文件；仅远端 Git 步骤覆盖 `GIT_SSH_COMMAND` 并提供临时凭据。

- [x] `runner.fetch()`（约 164 行，`ls-remote` + `fetch`）与 `runner.execute()`（约 253/321 行 `fetch`）在**任务源码目录之外**创建 `0700` 临时目录，写解密私钥（`0600`）与由 `known_hosts` 生成的文件（`[host]:port` 格式，与 1.2 的解析规则一致）。
- [x] `GIT_SSH_COMMAND` 按契约第 5 节组装，经环境变量传入，不拼 shell。
- [x] Docker：仅 git 步骤只读挂载凭据目录；`bash build.sh` 步骤不挂载。本机模式同样只在 git 子进程环境中提供。
- [x] 步骤结束（成功/失败/取消/超时）立即删除；服务启动时清理遗留凭据目录。
- [x] 拉取与执行使用同一密钥：`/projects/:id/fetch` 用项目当前密钥，执行用快照 `sshKeyId`；密钥已删除 → 失败「拉取凭据已删除」，不回退无凭据。
- [x] 主机校验失败 → 「主机 X 未受信任或主机公钥已变化」；成功使用后更新 `lastUsedAt`。

### F. 测试（`apps/server/test/ssh.test.mjs`、`platform.test.mjs`）

- [x] 加密往返、主密钥缺失 503、导入格式校验、指纹计算、删除密钥置空项目引用、项目 SSH 地址缺密钥 400、普通用户访问密钥接口 403、响应中不含私钥。
- [x] 执行器：凭据目录权限、步骤后删除、构建脚本环境中拿不到私钥（`env`、`ls /run/creds`、`cat ~/.ssh/*`）。

---

## 4. 建议拆分（可并行的 agent 任务）

| 任务 | 内容                    | 依赖   | 主要文件                                                              |
| ---- | ----------------------- | ------ | --------------------------------------------------------------------- |
| T1   | A + B：迁移、类型、加密 | —      | `store.ts`、`types.ts`、`config.ts`、`.env.example`、`runtime.md`     |
| T2   | C：密钥/主机接口 + 审计 | T1     | `routes.ts`、`service.ts`、新增 `tools/ssh.ts`（生成/解析/指纹/scan） |
| T3   | D：项目接口集成         | T1     | `routes.ts`、`store.ts`                                               |
| T4   | E：执行器凭据注入       | T1、T3 | `runner.ts`、`process.ts`                                             |
| T5   | F + 第 5 节联调验收     | 全部   | `test/`、`docs/implementation-acceptance.md`                          |

T2 与 T3 可在 T1 完成后并行；T4 不依赖 T2 的接口，可用测试数据直接写表。

---

## 5. 验收

### 5.1 端到端（真实环境）

1. 设置页生成密钥 → 公钥添加为代码托管平台只读 Deploy Key。
2. 设置页扫描并信任主机。
3. 新建项目，SSH 地址 + 选择密钥 → 保存。
4. 发起构建弹窗不出现凭据提示 → 拉取代码成功 → 入队 → 构建成功。
5. 反例均明确失败：未信任主机、主机公钥变化、密钥被删除、Deploy Key 被撤销。
6. 不同项目不同密钥并行构建互不影响。
7. 全局搜索接口响应、日志、审计、构建输出，找不到私钥内容。

### 5.2 UI 回归（不得变化）

- 未绑定密钥的 SSH 项目：发起构建弹窗显示「…未绑定拉取密钥…去配置」，点击打开构建配置抽屉。
- 主机未受信任：显示「主机 host:port 尚未加入受信任主机…前往设置」，链接不折行。
- HTTPS 项目：无凭据提示。
- 普通用户：只出现未绑定提示，文案为「请联系管理员配置。」。
- 项目抽屉：SSH 地址出现密钥下拉，未选校验「SSH 地址需要选择拉取密钥」；HTTPS 不出现。
- 后端未就绪前可用 Playwright `page.route()` 在浏览器内拦截 `/api/projects`、`/api/ssh-keys`、`/api/known-hosts` 预览，**不得写入真实数据**，也不得作为验收结论。

---

## 6. 已采用的实施决定与限制

1. **项目引用存储**：沿用 JSON payload，在同一事务内删除密钥与清空引用；契约同步修订。
2. **密钥生成方式**：复用 `ssh-keygen`，支持无口令 OpenSSH/PEM；运行服务的主机需安装 OpenSSH 客户端，`tools/Dockerfile` 已包含 openssh-client。
3. **scan 出口策略**：本机与 Docker 均先拒绝非公网解析结果，扫描已校验的 IP；Docker 同时走 Git 专用受限网络。内网 Git 扫描暂不支持，不能直接放宽出口策略。
4. **普通用户主机提示**：保留原设计，主机列表仅管理员可读。
5. **本机隔离限制**：只适用于受信任仓库；同账号并发脚本具有宿主权限。Docker 的真实容器隔离和受限出口尚需目标 Linux 环境验收。

## 7. 禁止事项

- 不改已完成 UI 的结构、样式、文案和交互顺序（见第 1 节与 `docs/ui-handoff.md`）。
- 不支持账号密码、HTTPS token、带口令私钥；不转交本机 SSH agent 或用户 `~/.ssh`。
- 不得用模拟执行冒充真实 Git 拉取或生产验收（`AGENTS.md`）。
