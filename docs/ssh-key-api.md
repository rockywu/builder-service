# Git SSH 密钥：接口契约与执行要求

前端已按本契约完成（`SettingsPage.vue`、`SshKeyDialog.vue`、`KnownHostDialog.vue`、`ProjectDrawer.vue`、`BuildDialog.vue`，数据层见 `apps/web/src/api/store.ts` 与 `types.ts`）。后端实现必须与此一致，不得为适配后端修改已完成的 UI（见 `AGENTS.md`）。

开发交接（现状、缺口清单、任务拆分、验收）见 `docs/ssh-key-handoff.md`。

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
| `POST /known-hosts/scan`  | `{ host, port }`                                                       | `{ items: ScannedHostKey[] }` | 服务端 `ssh-keyscan`（参数数组、超时 10 s、走 Git 专用受限网络），**不保存**。拒绝私网/元数据地址解析结果需遵守部署出口策略。                                               |
| `POST /known-hosts`       | `{ host, port, keys: ScannedHostKey[] }`                               | `KnownHost[]`                 | 服务端重新计算每条 `publicKey` 的指纹并与提交的 `fingerprint` 比对，不一致拒绝；同 host+port+keyType 已存在则覆盖。                                                         |
| `DELETE /known-hosts/:id` | —                                                                      | 204                           |                                                                                                                                                                             |

项目接口：`POST/PUT /projects` 接收 `sshKeyId: number | null`。

- 仓库为 `git@` / `ssh://` 且 `sshKeyId` 为空 → 400「SSH 地址需要选择密钥」。
- `sshKeyId` 指向不存在的密钥 → 400。HTTPS 仓库允许携带但执行时忽略。

## 4. 存储

- 新增表 `ssh_keys`、`known_hosts`，数据库版本迁移至 4。项目沿用现有 JSON payload，增加可空字段 `sshKeyId`；删除密钥与清空项目引用在同一事务完成。列表批量读取项目与密钥后在内存组合，不使用联表查询。
- 私钥用 AES-256-GCM 加密（每条随机 nonce，存 `nonce + ciphertext + tag`），主密钥来自环境变量 `BUILDER_SECRET_KEY`（32 字节 base64）。缺失或长度错误时：密钥相关接口返回 503 并说明原因，其余功能正常；不得回退为明文存储。
- `.env.example` 和 `docs/runtime.md` 补充 `BUILDER_SECRET_KEY` 的生成与备份说明（丢失主密钥 = 所有私钥不可用，需要重新生成/导入）。备份包含数据库但主密钥单独保管。

## 5. 执行（`apps/server/src/tools/runner.ts`、`process.ts`）

远端 Git 步骤使用项目绑定的密钥；其他命令继续使用禁用默认身份文件的环境：

1. 涉及远端的 git 步骤（`fetch()` 中的 `ls-remote` 与 `fetch`，`execute()` 中的 `fetch`）在**任务源码目录之外**创建 `0700` 临时目录，写入解密私钥（`0600`）和由 `known_hosts` 表生成的文件（`[host]:port` 格式）。
2. `GIT_SSH_COMMAND=ssh -F /dev/null -o BatchMode=yes -o IdentitiesOnly=yes -o IdentityAgent=none -i <dir>/id -o UserKnownHostsFile=<dir>/known_hosts -o StrictHostKeyChecking=yes`，经参数数组/环境变量传入，不拼接 shell。
3. Docker 模式：仅 git 步骤以只读方式挂载该目录（如 `/run/creds`）；`bash build.sh` 步骤不挂载，构建脚本无法读取私钥。
4. 步骤结束（成功、失败、取消）立即删除临时目录；服务启动时清理遗留的凭据临时目录。
5. 入队快照记录 `sshKeyId`；拉取代码（`/projects/:id/fetch`）与执行使用同一密钥。执行时密钥已删除 → 任务失败「拉取凭据已删除」，不回退为无凭据拉取。
6. 成功使用后更新 `lastUsedAt`。日志不输出私钥路径以外的凭据内容；主机校验失败给出明确错误「主机 X 未受信任或主机公钥已变化」。

## 6. 验收

- 生成密钥 → 公钥添加为只读 Deploy Key → 信任主机 → 项目选择密钥 → 拉取代码 → 入队 → 构建成功。
- 未信任主机、主机公钥变化、密钥被删除、Deploy Key 被撤销时均明确失败。
- 构建脚本中 `ls /run/creds`、`env`、`cat ~/.ssh/*` 均拿不到私钥；接口响应、日志、审计中搜索不到私钥内容。
- 不同项目使用不同密钥并行构建互不影响。
