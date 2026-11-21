# Builder Service Docker 部署

当前服务器的部署目录为 `/opt/builder-service`，访问地址为 `https://builder.jjm.atmy.work`。前端和 API 只分别发布到宿主 `127.0.0.1:18110` 和 `127.0.0.1:18111`。现有 Nginx 网关使用 `gateway.builder.conf` 路由，复用原有 TLS 证书。

本机 Docker 部署和 构建依赖下载见[本地 Docker 测试](local.md)。

## 首次部署与配置

- `deploy/.env` 供 Compose 读取：`BUILDER_REVISION` 为 API 和 Web 镜像的共同版本标签；`BUILDER_UID`、`BUILDER_GID` 是服务账号；`DOCKER_SOCKET_GID` 取自 `stat -c %g /var/run/docker.sock`。`BUILDER_DATA_DIR` 是绝对路径，在宿主和 API 容器内必须一致。`BUILDER_ENV_FILE` 指向实际 API 配置文件。
- 该服务器将实际 API 配置保存在 `/home/dev/.config/builder-service/server.env`（权限 `0600`）。参考 `apps/server/.env.template`，设置 `HOST=0.0.0.0`、`PORT=3000`、`DATA_DIR`、HTTPS `APP_ORIGIN`、Docker runner 和任务镜像。首次生成 `BUILDER_SECRET_KEY` 后持续保留，主密钥与数据库备份分开保存。
- 仅受信任的 API 调度器挂载 Docker socket。任务容器不挂载 socket；执行脚本的容器有独立的工作目录和 HOME，Git 私钥只挂载到对应的拉取步骤。API 使用宿主 PID 命名空间，以便重启时识别 SQLite 数据目录中的持久调度锁。
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

Git 拉取和脚本执行默认使用 Docker 的普通网络。新主机先用任务镜像验证 Git、DNS 和打包所需的下载地址。若主机已有适合任务的 Docker 网络，可在服务端环境文件填写 `BUILDER_DOCKER_NETWORK`；可选的 `BUILDER_DOCKER_DNS` 接受逗号分隔的 DNS 地址。通常两项均可留空。

宿主机自身通过代理上网时，可在服务端环境文件中填写容器可达的 `HTTP_PROXY`、`HTTPS_PROXY` 和 `NO_PROXY`。这些变量会传给 Git 和构建任务，其中的值对项目脚本可见。仅监听宿主回环地址的代理可通过构建网桥上的监听器转接。包源可在管理端全局指定，支持内网域名、IP 和自定义端口。

从旧版升级时先排空任务，备份环境文件并重建镜像。移除旧的依赖代理、Gitee 中继及其 Compose 覆盖，保留宿主机实际需要的 DNS 和出口。旧版本的分阶段网络变量已停用。用真实任务验证原仓库拉取、依赖下载和产物后，再清理旧容器。

## 验证与回退

通过 HTTPS 域名读回 `/api/health`、登录会话和 `/api/queue`（确认 `runner=docker` 且无调度错误）。验收真实构建时，还需确认任务固定 Git 提交、成功执行、下载产物校验和一致。公开下载入口为 `/downloads`。

若需下线站点，先移走网关中的 `builder.conf`，通过 `nginx -t` 后重载，再停止 `builder-service` 单元。若仅回退镜像且数据库结构兼容，恢复上一次 `BUILDER_REVISION` 后重启。两种操作均保留业务数据和密钥。
