ARG NODE_IMAGE=node:24-bookworm-slim
FROM ${NODE_IMAGE}
ARG DEBIAN_MIRROR=deb.debian.org
RUN sed -i "s|http://deb.debian.org/|http://${DEBIAN_MIRROR}/|g" /etc/apt/sources.list.d/debian.sources \
    && apt-get -o Acquire::http::Timeout=15 -o Acquire::Retries=2 update \
    && apt-get -o Acquire::http::Timeout=15 -o Acquire::Retries=2 install -y --no-install-recommends bash git openssh-client ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /workspace
USER node
