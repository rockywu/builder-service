ARG NODE_IMAGE=node:24-bookworm-slim
FROM ${NODE_IMAGE}
ARG DEBIAN_MIRROR=deb.debian.org
RUN sed -i "s|http://deb.debian.org/|http://${DEBIAN_MIRROR}/|g" /etc/apt/sources.list.d/debian.sources \
    && apt-get -o Acquire::http::Timeout=15 -o Acquire::Retries=2 update \
    && apt-get -o Acquire::http::Timeout=15 -o Acquire::Retries=2 install -y --no-install-recommends bash git openssh-client ca-certificates curl python3 zip unzip xz-utils \
    && rm -rf /var/lib/apt/lists/*
ARG BUILDER_UID=1000
ARG BUILDER_GID=1000
RUN --mount=type=bind,source=deploy/ensure-builder-user.sh,target=/tmp/ensure-builder-user.sh \
    sh /tmp/ensure-builder-user.sh "$BUILDER_UID" "$BUILDER_GID"
COPY tools/git-relay-client.cjs /usr/local/lib/builder/git-relay-client.cjs
COPY tools/with-dependency-proxy.mjs /usr/local/lib/builder/with-dependency-proxy.mjs
RUN corepack enable pnpm
WORKDIR /workspace
USER node
