# 本地 Docker 测试

本机复用服务器的 `compose.yml`、API/Web 镜像定义和任务镜像定义。`compose.local.yml` 将项目命名为 `builder-service-local`，把前端和 API 汇到 `http://127.0.0.1:18112`。API 以开发模式接受该 HTTP 来源，执行器仍为 Docker，构建容器仍使用 `--network none`。

## 构建并启动

启动 Docker Desktop，或使用提供 `/var/run/docker.sock` 的本机 Linux 引擎。先检查 `DOCKER_HOST` 和当前 Docker context 的端点，确认实际连接的是本机。用普通用户在仓库根目录执行以下命令。Docker Desktop 需要能访问仓库目录，API 和它启动的任务容器使用同一个绝对数据路径。Apple Silicon 上默认构建 Linux arm64 镜像，可用于测试 Linux 构建。要比对服务器的 Linux amd64 镜像架构，可先在当前终端执行 `export DOCKER_DEFAULT_PLATFORM=linux/amd64`。

如果用 Kiri 且终端找不到 `docker`，先执行 `export PATH="$HOME/.kiri/bin:$PATH"`，再用 `docker context show` 确认当前 context 为 `kiri`。

要从国内镜像源拉取，可以先执行 `export BUILDER_LOCAL_IMAGE_PREFIX=docker.m.daocloud.io/library/`。该变量适用于以下命令中的 Node、Nginx、Docker CLI 基础镜像和本地网关镜像。

旧版部署如果仍使用 `var/docker-local/data`，先停止本地实例，将原目录移到 `var/docker-local/storage/data`，并同步更新 `var/docker-local/server.env` 里的 `DATA_DIR`，再执行下面的启动命令。新部署会直接创建新的路径。

```bash
(
  set -eu
  umask 077
  unset BUILDER_REVISION BUILDER_UID BUILDER_GID DOCKER_SOCKET_GID \
    BUILDER_DATA_DIR BUILDER_ENV_FILE BUILDER_LOCAL_STORAGE_DIR BUILDER_LOCAL_NGINX_IMAGE
  local_dir="$(pwd -P)/var/docker-local"
  storage_dir="$local_dir/storage"
  mkdir -p "$storage_dir/data"
  revision="local-$(git rev-parse --short HEAD)"
  runtime_image=builder-runtime:local-node24
  builder_uid=$(id -u)
  builder_gid=$(id -g)
  image_prefix=${BUILDER_LOCAL_IMAGE_PREFIX:-docker.io/library/}
  node_image="${image_prefix}node:24-bookworm-slim"
  nginx_image="${image_prefix}nginx:1.28-alpine"
  docker_cli_image="${image_prefix}docker:29.1.3-cli"

  docker build -f tools/Dockerfile --build-arg NODE_IMAGE="$node_image" \
    --build-arg BUILDER_UID="$builder_uid" --build-arg BUILDER_GID="$builder_gid" \
    -t "$runtime_image" .
  docker build -f deploy/Dockerfile --target api \
    --build-arg NODE_IMAGE="$node_image" --build-arg DOCKER_CLI_IMAGE="$docker_cli_image" \
    --build-arg BUILDER_UID="$builder_uid" --build-arg BUILDER_GID="$builder_gid" \
    -t "builder-service-api:$revision" .
  docker build -f deploy/Dockerfile --target web \
    --build-arg NODE_IMAGE="$node_image" --build-arg NGINX_IMAGE="$nginx_image" \
    -t "builder-service-web:$revision" .

  socket_gid=$(docker run --rm --network none \
    --mount type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock,readonly \
    --entrypoint stat "$runtime_image" -c %g /var/run/docker.sock)

  cat > "$local_dir/compose.env" <<EOF
BUILDER_REVISION=$revision
BUILDER_UID=$builder_uid
BUILDER_GID=$builder_gid
DOCKER_SOCKET_GID=$socket_gid
BUILDER_DATA_DIR='$storage_dir/data'
BUILDER_ENV_FILE='$local_dir/server.env'
BUILDER_LOCAL_STORAGE_DIR='$storage_dir'
BUILDER_LOCAL_NGINX_IMAGE=$nginx_image
EOF

  if [ ! -e "$local_dir/server.env" ]; then
    secret_key=$(openssl rand -base64 32)
    cat > "$local_dir/server.env" <<EOF
HOST=0.0.0.0
PORT=3000
DATA_DIR="$storage_dir/data"
APP_ORIGIN=http://127.0.0.1:18112
BUILDER_RUNNER=docker
BUILDER_IMAGE=$runtime_image
BUILDER_GIT_NETWORK=none
BUILDER_BUILD_NETWORK=none
BUILDER_SECRET_KEY=$secret_key
EOF
  fi

  docker compose -p builder-service-local --env-file "$local_dir/compose.env" \
    -f deploy/compose.yml -f deploy/compose.local.yml up -d --wait
)
```

访问 `http://127.0.0.1:18112` 登录新建的本地实例，初始管理员见[仓库说明](../README.md#环境与启动)。用 `curl -fsS http://127.0.0.1:18112/api/health` 检查经本地网关访问 API。数据库和本地配置保存在 Git 忽略的 `var/docker-local/` 下，后续启动会沿用本地密钥。

停止本地实例可运行以下命令。

```bash
(
  unset BUILDER_REVISION BUILDER_UID BUILDER_GID DOCKER_SOCKET_GID \
    BUILDER_DATA_DIR BUILDER_ENV_FILE BUILDER_LOCAL_STORAGE_DIR BUILDER_LOCAL_NGINX_IMAGE
  docker compose -p builder-service-local --env-file var/docker-local/compose.env \
    -f deploy/compose.yml -f deploy/compose.local.yml down
)
```

## Git 与依赖下载

本地 Compose 启动 `gitee-relay`。使用 `git@gitee.com:组织/仓库.git` 的项目绑定 SSH 密钥后，远端 Git 步骤通过专用 Unix 套接字连接 `gitee.com:22`。Git 容器可以保留 `BUILDER_GIT_NETWORK=none`，构建脚本不挂载该套接字。首次连接成功后平台会记录主机公钥。其他 Git 主机或 HTTPS 拉取需要单独配置符合 [Git 出口隔离要求](../docs/runtime.md#服务器-docker-模式)的网络。

基础 Compose 启动 `dependency-proxy`。新建项目和已有项目执行脚本时自动收到 HTTPS 代理设置，Corepack、pnpm 和支持代理的下载工具可按各项目的版本要求下载依赖。无需编辑项目脚本或预装指定版本的 pnpm；任务镜像包含 Corepack 的 pnpm 命令。联网工具、允许的来源、严格离线启动以及更新已有部署的步骤见[部署手册](README.md#构建依赖出口)。

从平台运行真实构建时，确认日志已越过 Corepack 下载和项目依赖安装；打包工具兼容性、签名及各架构产物要在后续步骤分别验收。
