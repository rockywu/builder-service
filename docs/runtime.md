# API 与构建运行

现有 UI 的模板、样式、文案及交互结构保持不变，页面数据已由浏览器 Mock 切换到真实 API。服务端是唯一业务状态来源；项目、任务、版本、产物和设置持久化到 SQLite。浏览器刷新不会重置业务数据。公开页面仅请求 `/api/public/*`，不读取会话。

## 本机开发

Node.js 24 / npm 11，系统需提供 Git、Bash、Node.js、OpenSSH 客户端（`ssh-keygen`、`ssh-keyscan`、`ssh`），以及项目脚本实际需要的工具。无需 Docker。

```bash
npm ci
cp -n apps/server/.env.template apps/server/.env
chmod 600 apps/server/.env
```

首次初始化时执行 `openssl rand -base64 32`，将结果填入 `apps/server/.env` 的 `BUILDER_SECRET_KEY` 后再启动；已有配置或恢复数据库时保留原主密钥。模板用于说明变量，服务实际读取 `.env`，两者的关系与完整启动步骤见 [README](../README.md#环境与启动)。

```bash
npm run dev
```

`BUILDER_RUNNER=local` 是开发默认值。它会执行管理员配置的真实构建脚本，必须只接入受信任仓库和脚本。每个任务独立克隆指定 SHA，运行于 `DATA_DIR/builds/<jobId>/source`；环境仅继承 PATH 和固定的 Git/语言设置，HOME 与 npm 缓存位于该任务自己的 `.home` 目录，不继承服务进程的密码或 token 环境变量，不读取用户 Git 全局配置。**本机模式没有操作系统级隔离，脚本仍拥有运行服务的本机账号权限和网络访问能力。** 不用它运行不受信任代码，也不能把本轮本机测试记为容器安全验收。

默认管理员仅首次创建 `admin / admin123456`，请重置密码。不会创建演示普通账号；需管理员在现有用户页创建。全局演示环境横条已按用户要求删除；登录页账号填充区继续保留，数据及构建实际来自服务端。

仓库地址支持 HTTPS、SSH 和 `git@host:path`。不接受地址内嵌密码。HTTPS 仓库匿名拉取；SSH 仓库由管理员在设置页生成或导入无口令私钥、核对并信任主机公钥，然后在项目配置中绑定密钥。执行器不转交本机 SSH agent 或登录账号的默认 Git 凭据，也不支持账号密码、HTTPS token 或带口令私钥。

首次使用密钥功能前，在服务端环境配置 `BUILDER_SECRET_KEY`。使用 `openssl rand -base64 32` 生成 32 字节主密钥，写入受限的服务配置文件（0600），配置目录使用 0700。不要写入 Git、构建脚本或日志。私钥以 AES-256-GCM 加密后写入数据库；主密钥缺失或格式错误时密钥/主机管理接口返回 503，其余功能正常。主密钥错误时无法解密已有私钥，不会回退明文。

数据库备份包含加密私钥和已信任主机，**主密钥必须与数据库备份分开保管**。恢复副本时配置原主密钥；丢失原主密钥意味着全部原私钥不可用，需要重新生成/导入并更新代码托管平台授权。当前不提供主密钥轮换工具。

凭据临时目录位于 `DATA_DIR/ssh-temporary`，与源码目录分开，目录 0700、文件 0600。仅远端 Git 步骤得到凭据；Docker 只读挂载 `/run/creds`，构建脚本容器不挂载。每步成功、失败、取消或超时后删除，启动先核对遗留任务进程/容器，再清理临时凭据。**本机模式下，同一服务账号的并发脚本仍有宿主权限，不能据此声称私钥具备操作系统级隔离。**

主机扫描只连接解析后确认的公网 IP，拒绝私网、环回、链路本地、保留及元数据地址；Docker 扫描使用 Git 专用网络，超时 10 秒，扫描不自动保存。内网 Git 服务当前需要在网络策略明确后扩展支持，不能通过放宽扫描校验直接绕过出口限制。扫描结果须管理员通过可信渠道核对指纹后再信任。

## 运行规则

- 发起构建前拉取分支，服务端再次核验 SHA；入队保存完整构建配置快照及操作者 ID。删除后重建同名用户不能继承原用户任务的操作权。
- 创建任务使用 `Idempotency-Key`；请求结果不确定时应保留并重用原 key。服务端拒绝同一 key 对应不同输入；删除任务后保留 7 天的请求回执，防止迟到重试重新创建构建，新任务使用新 key。
- 单调度器在数据库 Worker 的短事务里按全局序号领取。运行及停止中任务都占槽位；调低并行上限不停止当前任务。
- 三个阶段：拉取源码、执行 `bash -ex build.sh`、收集产物。日志纯文本存储，单任务日志上限 10 MB；超出限额、非零退出、超时或缺少产物都明确失败。
- 产物最多 100 个、总计 512 MB。拒绝路径穿越、符号链接、硬链接和非普通文件；收集后计算大小与 SHA-256，原子发布文件目录，再写版本记录。
- 管理员可在项目卡片菜单选择“删除项目”，通过 Popconfirm 二次确认后删除项目及全部排队/已结束构建、源码副本、日志、版本和产物；公开下载立即失效。有运行/停止中的任务或正在拉取时拒绝，需先停止/等待。共享 SSH 密钥和其他项目正在引用的图标保留。清理失败时项目显示“删除未完成”并可重试，重启自动继续；未完成文件清理前保留项目记录。
- 停止时先记为 `canceling`，终止任务进程组，确认退出后再释放槽位。执行中任务不能删除。删除先隐藏版本、拒绝新下载，再删除该任务文件，最后删除数据库记录。正在下载时返回冲突，可在下载结束后重试；失败清理在重启时继续。
- 重启核对未完成任务及产物清单，不能确认进程身份或数据提交结果时保留占用并暂停领取。调度器锁阻止重复启动；若启动阶段被强制中断留下 `.guard`，须先确认无服务进程，再处理该锁。
- 服务空闲时可执行管理员接口 `POST /api/maintenance/backup`（带会话、Origin、CSRF），备份保存到 `DATA_DIR/backups/<id>`，备份期间拒绝业务写入。任务仍在执行或清理时拒绝开始备份。

离线恢复到全新目录，禁止覆盖在线数据：

```bash
npm run build -w @builder/server
node apps/server/dist/tools/restore.js /absolute/backup/id /absolute/new-data-dir
```

恢复前检查 SQLite 完整性、外键及全部公开产物的大小和 SHA-256；随后以独立端口和 `DATA_DIR` 启动验证，再安排切换。脚本失败时不自动切换数据目录。

## 服务器 Docker 模式

本轮不执行 Docker 部署。服务器配置使用 `BUILDER_RUNNER=docker`，`NODE_ENV=production` 禁止本机模式。

```bash
docker build -t builder-runtime:node24 -f tools/Dockerfile .
```

固定镜像包含 Node.js、Bash、Git；其他打包工具由部署方固定加入。构建容器非 root、只读根文件系统、无 capabilities、无宿主凭据或引擎 socket 挂载；只挂载该任务目录，限制 2 CPU、2 GB 内存、256 进程和临时目录空间。构建阶段网络固定为 `none`。

Git 拉取单独使用 `BUILDER_GIT_NETWORK`，部署方必须配置禁止管理网、私网及元数据端点的专用出口策略。默认 `none` 无法访问远端仓库；`bridge` 和 `host` 被拒绝。仅命名一个网络不代表已经落实出口限制，部署时须核对实际防火墙。需要联网安装依赖的项目，也必须先确认受限出口方案，当前不能直接开放构建网络。服务端检测镜像或配置不可用时暂停领取并在队列接口返回原因，不退回本机执行。

Docker 执行、容器恢复、服务器网络隔离及SSH 凭据挂载均须在目标 Linux 环境单独验收。

## 检查与测试

```bash
CI=true npm run typecheck
CI=true npm run test -w @builder/server
CI=true npm run test:platform -w @builder/server
CI=true npm run test:ssh -w @builder/server
CI=true npm run test:project-delete -w @builder/server
CI=true npm run build -w @builder/web
```

平台集成测试使用临时目录和本任务独占的本地 Git HTTP fixture，不访问真实外部仓库。源码编译、集成测试、浏览器交互、容器验收、生产部署分别记录，不能互相代替。
