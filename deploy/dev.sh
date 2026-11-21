#!/usr/bin/env bash
# 本地 Docker 开发环境入口。用法：
#   deploy/dev.sh            构建并启动（等同 up）
#   deploy/dev.sh down       停止
#   deploy/dev.sh logs -f    查看日志
#   deploy/dev.sh <其他>     透传给 docker compose
set -euo pipefail
umask 077
root="$(cd "$(dirname "$0")/.." && pwd -P)"
cd "$root"
dev_dir="$root/var/docker-dev"
# 与 deploy/local.md 的本地部署共用同一套 SQLite 数据目录、主密钥和任务镜像。
local_dir="$root/var/docker-local"
storage_dir="$local_dir/storage"
mkdir -p "$dev_dir" "$storage_dir/data"

image_prefix=${BUILDER_LOCAL_IMAGE_PREFIX:-docker.io/library/}
node_image="${image_prefix}node:24-bookworm-slim"
docker_cli_image="${image_prefix}docker:29.1.3-cli"
runtime_image=builder-runtime:local-node24
builder_uid=$(id -u)
builder_gid=$(id -g)

compose() {
  docker compose -p builder-service-dev --env-file "$dev_dir/compose.env" \
    -f deploy/compose.dev.yml "$@"
}

cmd=${1:-up}
if [ "$cmd" != up ] && [ -f "$dev_dir/compose.env" ]; then
  shift || true
  compose "$cmd" "$@"
  exit
fi
[ "$cmd" = up ] && shift || true

# 任务运行镜像（API 通过 Docker 执行构建脚本）
if ! docker image inspect "$runtime_image" >/dev/null 2>&1 || [ "${REBUILD:-0}" = 1 ]; then
  docker build -f tools/Dockerfile --build-arg NODE_IMAGE="$node_image" \
    --build-arg BUILDER_UID="$builder_uid" --build-arg BUILDER_GID="$builder_gid" \
    -t "$runtime_image" .
fi
docker build -f deploy/Dockerfile.dev --target dev \
  --build-arg NODE_IMAGE="$node_image" --build-arg DOCKER_CLI_IMAGE="$docker_cli_image" \
  --build-arg BUILDER_UID="$builder_uid" --build-arg BUILDER_GID="$builder_gid" \
  -t builder-service-dev:local .

socket_gid=$(docker run --rm --network none \
  --mount type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock,readonly \
  --entrypoint stat "$runtime_image" -c %g /var/run/docker.sock)

cat > "$dev_dir/compose.env" <<EOT
BUILDER_UID=$builder_uid
BUILDER_GID=$builder_gid
DOCKER_SOCKET_GID=$socket_gid
BUILDER_DATA_DIR='$storage_dir'
BUILDER_DEV_ENV_FILE='$dev_dir/server.env'
EOT

# 本地部署的配置不存在时按 local.md 同样的格式创建，确保密钥只有一份。
if [ ! -e "$local_dir/server.env" ]; then
  cat > "$local_dir/server.env" <<EOT
HOST=0.0.0.0
PORT=3000
DATA_DIR="$storage_dir/data"
APP_ORIGIN=http://127.0.0.1:18112
BUILDER_RUNNER=docker
BUILDER_IMAGE=$runtime_image
BUILDER_SECRET_KEY=$(openssl rand -base64 32)
EOT
fi
# 开发配置 = 本地部署配置 + 开发来源与日志级别（后写的同名项生效）。
{
  cat "$local_dir/server.env"
  printf 'APP_ORIGIN=http://127.0.0.1:5173\nLOG_LEVEL=debug\n'
} > "$dev_dir/server.env"

# 同一份 SQLite 只允许一个 API 实例（调度器锁）；本地部署在运行时先停掉它。
compose_local_hint="docker compose -p builder-service-local --env-file var/docker-local/compose.env -f deploy/compose.yml -f deploy/compose.local.yml down"
if docker ps --format '{{.Names}}' | grep -qx builder-service-local-api-1; then
  echo "提示：builder-service-local 正在运行并持有同一份数据库的调度器锁，开发 API 将无法启动。" >&2
  echo "请先停止：$compose_local_hint" >&2
fi

compose up -d --wait "$@"
echo
echo "前端: http://127.0.0.1:5173   API: http://127.0.0.1:3000/api/health"
echo "日志: deploy/dev.sh logs -f   停止: deploy/dev.sh down"
