# Git SSH 密钥：接口契约与执行要求

前端已按本契约完成（`SettingsPage.vue`、`SshKeyDialog.vue`、`ProjectDrawer.vue`、`BuildDialog.vue`，数据层见 `apps/web/src/api/store.ts` 与 `types.ts`）。后端实现必须与此一致，不得为适配后端修改已完成的 UI（见 `AGENTS.md`）。

项目绑定、测试拉取和 Docker 网络配置见 [Git SSH 拉取交接](ssh-key-handoff.md)。

范围：只支持 SSH 私钥拉取（`git@host:path`、`ssh://`）。不支持账号密码、HTTPS token、带口令的私钥。HTTPS 仓库继续匿名拉取。

## 1. 通用约定

- 所有接口位于 `/api`，**仅管理员**；非 GET 请求校验 `X-CSRF-Token`。错误返回 `{ message }`，前端直接展示 `message`。
- 列表接口支持 `?offset=&limit=`，返回 `{ items, total, nextOffset }`（与现有 `all()` 一致）。
- **私钥永不出现在任何响应、日志、审计摘要或错误信息中。** 审计记录密钥的新增、改名、更换、删除，以及主机的信任/移除（只记名称与指纹）。

## 2. 数据结构

```ts
interface SshKey {
  id: number;
  name: string; // 1–40，唯一
  type: 'ed25519' | 'rsa' | 'ecdsa';
  source: 'generated' | 'imported';
  fingerprint: string; // `SHA256:...`（与 ssh-keygen -lf 一致）
  publicKey: string; // OpenSSH 单行公钥，注释可为密钥名
  projectIds: number[]; // 引用该密钥的项目
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null; // 毫秒时间戳
}
interface KnownHost {
  id: number;
  host: string;
  port: number;
  keyType: string; // ssh-ed25519 / ecdsa-sha2-nistp256 / ssh-rsa
  fingerprint: string; // `SHA256:...`
  createdAt: number;
}
interface ScannedHostKey {
  keyType: string;
  publicKey: string;
  fingerprint: string;
}
```

`Project` 响应新增 `sshKeyId: number | null` 与 `sshKeyName: string | null`（**所有登录用户**可见，供发起构建弹窗显示；不返回指纹以外的密钥信息）。

## 3. 接口

| 方法与路径                | 请求体                                                                 | 响应                          | 说明                                                                                                                                                                        |
| ------------------------- | ---------------------------------------------------------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /ssh-keys`           | —                                                                      | 分页 `SshKey`                 |                                                                                                                                                                             |
| `POST /ssh-keys`          | `{ name, mode: 'generate' }` 或 `{ name, mode: 'import', privateKey }` | `SshKey`                      | 生成：服务端生成 ed25519。导入：解析并校验为无口令 OpenSSH/PEM 私钥，导出公钥与指纹；带口令或格式错误返回 400「仅支持无口令的 OpenSSH 私钥」。私钥 ≤ 16 KB；RSA ≥ 2048 位。 |
| `PATCH /ssh-keys/:id`     | `{ name, privateKey? }`                                                | `SshKey`                      | `privateKey` 仅允许 `source = 'imported'`，否则 400。更换后指纹更新。                                                                                                       |
| `DELETE /ssh-keys/:id`    | —                                                                      | 204                           | 允许删除被引用的密钥：同事务内将引用项目的 `sshKeyId` 置空。已排队任务的快照仍记旧 ID，拉取时明确失败「拉取凭据已删除」。                                                   |
| `GET /known-hosts`        | —                                                                      | 分页 `KnownHost`              |                                                                                                                                                                             |
| `POST /known-hosts/scan`  | `{ host, port }`                                                       | `{ items: ScannedHostKey[] }` | 服务端 `ssh-keyscan`（参数数组、超时 10 s、走 任务容器的 Docker 网络），**不保存**。拒绝私网/元数据地址解析结果需遵守部署出口策略。                                               |
| `POST /known-hosts`       | `{ host, port, keys: ScannedHostKey[] }`                               | `KnownHost[]`                 | 服务端重新计算每条 `publicKey` 的指纹并与提交的 `fingerprint` 比对，不一致拒绝；同 host+port+keyType 已存在则覆盖。                                                         |
| `DELETE /known-hosts/:id` | —                                                                      | 204                           |                                                                                                                                                                             |

主机管理接口为旧客户端兼容和管理员维护保留。主机公钥轮换时，须从可信渠道核实新公钥，再更新记录。

项目接口：`POST/PUT /projects` 接收 `sshKeyId: number | null`。

- 仓库为 `git@` / `ssh://` 且 `sshKeyId` 为空 → 400「SSH 地址需要选择密钥」。
- `sshKeyId` 指向不存在的密钥 → 400。HTTPS 仓库允许携带但执行时忽略。

## 4. 存储

- 新增表 `ssh_keys`、`known_hosts`，数据库版本迁移至 4。项目沿用现有 JSON payload，增加可空字段 `sshKeyId`；删除密钥与清空项目引用在同一事务完成。列表批量读取项目与密钥后在内存组合，不使用联表查询。
- 私钥用 AES-256-GCM 加密（每条随机 nonce，存 `nonce + ciphertext + tag`），主密钥来自环境变量 `BUILDER_SECRET_KEY`（32 字节 base64）。缺失或长度错误时：密钥相关接口返回 503 并说明原因，其余功能正常；不得回退为明文存储。
- `apps/server/.env.template` 和 `docs/runtime.md` 说明了如何生成和备份 `BUILDER_SECRET_KEY`。主密钥与数据库备份分开保管；丢失主密钥后，已有 SSH 私钥需要重新生成或导入。

## 5. 执行（`apps/server/src/tools/runner.ts`、`process.ts`）

远端 Git 步骤使用项目绑定的密钥；其他命令继续使用禁用默认身份文件的环境：

1. 远端 Git 步骤在**任务源码目录之外**创建 `0700` 临时目录，写入解密私钥和临时 `known_hosts`（文件均为 `0600`）。Git 不使用默认密钥、SSH agent 或主机公钥文件。
2. 已记录的主机和端口使用 `StrictHostKeyChecking=yes`。首次连接使用 `accept-new`，远端 Git 操作成功后才将该公钥写入数据库。并发首次连接可以确认同一公钥，不能覆盖已记录的公钥。首次连接未通过独立渠道核实公钥。
3. Docker 仅向远端 Git 步骤只读挂载凭据目录。首次连接时，仅将临时 `known_hosts` 文件另行以可写方式挂载；构建脚本容器不获得这些文件。
4. 步骤结束（成功、失败、取消或超时）后删除临时目录；服务启动时清理遗留的凭据临时目录。
5. 入队快照记录 `sshKeyId`；测试拉取（`/projects/:id/test-fetch`）使用当前项目的密钥，正式任务使用入队时的密钥。测试拉取不固定提交；旧版 `/projects/:id/fetch` 继续供固定 SHA 的客户端使用。密钥已删除时不回退为无凭据拉取。
6. 成功使用后更新 `lastUsedAt`。主机公钥不匹配时拒绝连接，并提示联系管理员核实。

## 6. 验收

- 生成密钥 → 公钥添加为只读 Deploy Key → 项目选择密钥 → 选择分支或标签 → 入队 → 自动拉取并构建成功；可在入队前测试拉取。
- 首次成功拉取自动记录主机公钥；主机公钥变化、密钥被删除、Deploy Key 被撤销时均明确失败。
- 构建脚本中 `ls /run/creds`、`env`、`cat ~/.ssh/*` 均拿不到私钥；接口响应、日志、审计中搜索不到私钥内容。
- 不同项目使用不同密钥并行构建互不影响。
