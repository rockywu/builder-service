# Builder Service Docker 部署

当前服务器的部署目录为 `/opt/builder-service`，访问地址为 `https://builder.jjm.atmy.work`。前端和 API 只分别发布到宿主 `127.0.0.1:18110` 和 `127.0.0.1:18111`。现有 Nginx 网关使用 `gateway.builder.conf` 路由，复用原有 TLS 证书。

本机 Docker 部署和 构建依赖下载见[本地 Docker 测试](local.md)。

## 首次部署与配置

- `deploy/.env` 供 Compose 读取：`BUILDER_REVISION` 为 API 和 Web 镜像的共同版本标签；`BUILDER_UID`、`BUILDER_GID` 是服务账号；`DOCKER_SOCKET_GID` 取自 `stat -c %g /var/run/docker.sock`。`BUILDER_DATA_DIR` 是绝对路径，在宿主和 API 容器内必须一致。`BUILDER_ENV_FILE` 指向实际 API 配置文件。
- 该服务器将实际 API 配置保存在 `/home/dev/.config/builder-service/server.env`（权限 `0600`）。参考 `apps/server/.env.template`，设置 `HOST=0.0.0.0`、`PORT=3000`、`DATA_DIR`、HTTPS `APP_ORIGIN`、Docker runner、Git 专用网络与 DNS；`BUILDER_BUILD_NETWORK=none`。首次生成 `BUILDER_SECRET_KEY` 后持续保留，主密钥与数据库备份分开保存。
- 仅受信任的 API 调度器挂载 Docker socket。任务容器不挂载 socket；执行脚本的容器通过专用代理下载依赖，无 Git 私钥。API 使用宿主 PID 命名空间，以便重启时识别 SQLite 数据目录中的持久调度锁。
- 该服务器为 Git 拉取配置了 `BUILDER_GIT_NETWORK=builder_git_gitee`，通过专用出口访问 `gitee.com:22`。更新或重新部署时保留这个配置；缺省值 `none` 会使新启动的拉取容器无法访问 Gitee。执行构建脚本的容器继续使用 `BUILDER_BUILD_NETWORK=none`。其他服务器需自行配置符合[构建隔离要求](../docs/runtime.md#服务器-docker-模式)的网络。
- 该主机由 `/etc/systemd/system/builder-service.service` 启动 Compose。首次启动后，在网关开放前以服务账号运行 `python3 deploy/bootstrap-admin.py`。脚本通过本机 API 轮换默认管理员密码，验证新密码可用且旧密码失效，并将新密码保存在该账号的私有配置目录。

## 构建与更新

以下在仓库根目录以部署服务账号执行。首次部署时，用 `id -u` 和 `id -g` 获取服务账号的 UID 和 GID，并以同一组值填写 Compose 的 `BUILDER_UID`、`BUILDER_GID`。若由另一个账号构建，以下 `builder_uid` 和 `builder_gid` 应填写实际部署服务账号的值。镜像标签应标识本次部署的代码版本，确保能恢复到上一组镜像。若 Docker Hub 不可达，可为 `deploy/Dockerfile` 的 `NODE_IMAGE`、`NGINX_IMAGE`、`DOCKER_CLI_IMAGE` 传入可信镜像源及摘要。

```bash
revision=$(git rev-parse --short HEAD)
builder_uid=$(id -u)
builder_gid=$(id -g)
docker build -f deploy/Dockerfile --target api \
  --build-arg BUILDER_UID="$builder_uid" --build-arg BUILDER_GID="$builder_gid" \
  -t "builder-service-api:$revision" .
docker build -f deploy/Dockerfile --target web -t "builder-service-web:$revision" .
docker build -f tools/Dockerfile \
  --build-arg BUILDER_UID="$builder_uid" --build-arg BUILDER_GID="$builder_gid" \
  -t builder-runtime:node24 .
```

`tools/Dockerfile` 同样支持 `NODE_IMAGE`。Debian 包源不可达时，可为 API 和任务镜像构建指定 `--build-arg DEBIAN_MIRROR=镜像站域名`，依然使用 Debian 自带的签名密钥验证软件包索引。

API 和任务镜像都需要包含该 UID 对应的用户，OpenSSH 才能运行。可用以下命令在启动 Compose 前验证镜像。若出现 `No user exists for uid`，请核对镜像的构建参数与 Compose 的运行身份。

```bash
(
  set -e
  for image in "builder-service-api:$revision" builder-runtime:node24; do
    docker run --rm --network none --user "$builder_uid:$builder_gid" \
      --entrypoint getent "$image" passwd "$builder_uid"
  done
)
```

更新 `deploy/.env` 的 `BUILDER_REVISION` 前，确认数据库和产物备份可用、构建队列空闲。使用 `sudo systemctl restart builder-service` 更新部署，保留数据目录与主密钥。站点文件放在网关 `/home/dev/jjm-gateway/conf/apps/`；改动时先在现有网关容器中运行 `nginx -t`，通过后再执行 `nginx -s reload`。

## 构建依赖出口

基础 Compose 默认启动 `dependency-proxy`，单独挂载 Unix 套接字卷。执行构建脚本时，任务容器通过本任务的回环地址使用代理。Corepack、pnpm、npm、Git HTTPS、Electron 和遵守 HTTPS 代理设置的工具可在安装和打包阶段访问允许的 HTTPS 来源。代理无共享依赖缓存，也不挂载源码、凭据和 Docker socket。Git 拉取仍走独立配置。

代理允许指定域名的 443 端口，解析并直接连接通过公网 IPv4 校验的地址，默认域名见[依赖来源列表](../apps/server/src/tools/dependency-hosts.ts)。遇到 HTTP 403 时，查看 `docker compose logs dependency-proxy` 中拒绝的域名。新工具或重定向 CDN 可在 Compose 的环境文件中设置 `BUILDER_DEPENDENCY_HOSTS`，以逗号分隔填写完整的允许列表，然后用 `docker compose up -d --wait` 应用。此值替换默认列表。私网源、明文 HTTP、不支持代理的自定义下载器均需另行适配。DNS 必须向代理返回可达的真实公网 IPv4 地址。

如果宿主机通过本地 HTTP CONNECT 代理出网，可用 Unix 套接字转接到该代理。在 Compose 覆盖文件中只给 `dependency-proxy` 设置 `BUILDER_UPSTREAM_PROXY_SOCKET`，并把套接字所在目录只读挂载到对应位置。套接字权限应仅允许代理服务的运行用户连接。宿主机可用 systemd 的 socket 单元和 `systemd-socket-proxyd` 将连接转发到回环地址的 HTTP 代理。上游必须支持 CONNECT 到已校验的公网 IPv4 地址，构建任务仍只挂载平台自己的域名白名单代理套接字。

升级已有部署时按上节重建 API 和任务镜像，并更新 Compose 服务。手工运行 API 时仅在配好代理后指定 `BUILDER_DEPENDENCY_PROXY_VOLUME`。需要严格离线的 Compose 部署可在 **Compose 环境文件** 显式设置 `BUILDER_DEPENDENCY_PROXY_VOLUME=` 并重建 API；空值会禁用任务的代理挂载。已入队的构建须在升级前完成。更改来源列表会影响随后建立的连接。

## 验证与回退

通过 HTTPS 域名读回 `/api/health`、登录会话和 `/api/queue`（确认 `runner=docker` 且无调度错误）。验收真实构建时，还需确认任务固定 Git 提交、成功执行、下载产物校验和一致，并验证 Git 出口拒绝宿主/私网/元数据地址。公开下载入口为 `/downloads`。

若需下线站点，先移走网关中的 `builder.conf`，通过 `nginx -t` 后重载，再停止 `builder-service` 单元。若仅回退镜像且数据库结构兼容，恢复上一次 `BUILDER_REVISION` 后重启。两种操作均保留业务数据和密钥。
