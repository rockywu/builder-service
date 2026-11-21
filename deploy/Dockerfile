ARG NODE_IMAGE=node:24-bookworm-slim
ARG NGINX_IMAGE=nginx:1.28-alpine
ARG DOCKER_CLI_IMAGE=docker:29.1.3-cli

FROM ${NODE_IMAGE} AS build
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates python3 make g++ && rm -rf /var/lib/apt/lists/*
ENV CI=true
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci --no-audit --no-fund
COPY apps ./apps
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

FROM ${NGINX_IMAGE} AS web
COPY deploy/web.nginx.conf /etc/nginx/nginx.conf
RUN chmod 0644 /etc/nginx/nginx.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
USER 101:101
ENTRYPOINT ["nginx", "-g", "daemon off;"]

FROM ${DOCKER_CLI_IMAGE} AS docker-cli

FROM ${NODE_IMAGE} AS api
ARG DEBIAN_MIRROR=deb.debian.org
RUN sed -i "s|http://deb.debian.org/|http://${DEBIAN_MIRROR}/|g" /etc/apt/sources.list.d/debian.sources \
    && apt-get -o Acquire::http::Timeout=15 -o Acquire::Retries=2 update \
    && apt-get -o Acquire::http::Timeout=15 -o Acquire::Retries=2 install -y --no-install-recommends ca-certificates openssh-client procps \
    && rm -rf /var/lib/apt/lists/*
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/apps/server/package.json /app/apps/server/package.json
COPY --from=build /app/apps/server/dist /app/apps/server/dist
ARG BUILDER_UID=1000
ARG BUILDER_GID=1000
RUN --mount=type=bind,source=deploy/ensure-builder-user.sh,target=/tmp/ensure-builder-user.sh \
    sh /tmp/ensure-builder-user.sh "$BUILDER_UID" "$BUILDER_GID"
RUN install -d -o node -g node -m 0755 /run/builder-gitee /run/builder-dependencies
COPY deploy/gitee-relay.mjs /app/apps/server/gitee-relay.mjs
COPY deploy/dependency-proxy.mjs /app/apps/server/dependency-proxy.mjs
ENV NODE_ENV=production
WORKDIR /app/apps/server
USER node
CMD ["node", "--env-file=.env", "dist/index.js"]
