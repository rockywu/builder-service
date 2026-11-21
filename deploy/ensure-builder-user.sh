#!/bin/sh
set -eu

builder_uid=$1
builder_gid=$2
test "$builder_uid" -gt 0

if ! getent group "$builder_gid" >/dev/null; then
  groupadd --gid "$builder_gid" builder
fi

# OpenSSH resolves the numeric UID even when every path is passed explicitly.
if ! getent passwd "$builder_uid" >/dev/null; then
  useradd --uid "$builder_uid" --gid "$builder_gid" --no-create-home \
    --no-log-init --home-dir /nonexistent --shell /usr/sbin/nologin builder
fi
