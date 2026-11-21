#!/bin/sh
# 依赖随 package*.json 变化自动重装；node_modules 是挂载点，因此用 install 而非 ci。
set -eu
cd /app
hash=$(cat package.json package-lock.json apps/server/package.json apps/web/package.json | sha256sum | cut -d' ' -f1)
if [ "$(cat node_modules/.deps-hash 2>/dev/null || true)" = "$hash" ]; then
  echo "依赖已是最新"
  exit 0
fi
npm install --no-audit --no-fund
echo "$hash" > node_modules/.deps-hash
