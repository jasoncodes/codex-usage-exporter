# syntax=docker/dockerfile:1
FROM node:24-slim

SHELL ["/bin/bash", "-euo", "pipefail", "-c"]

RUN \
  --mount=type=cache,id=apt-cache,sharing=locked,target=/var/cache/apt \
  --mount=type=cache,id=apt-lib,sharing=locked,target=/var/lib/apt \
  <<SH
  rm /etc/apt/apt.conf.d/docker-clean
  echo 'Binary::apt::APT::Keep-Downloaded-Packages "true";' > /etc/apt/apt.conf.d/keep-cache
  apt-get update --yes

  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates
SH

RUN \
  --mount=type=cache,id=npm,target=/root/.npm \
  --mount=type=cache,id=node-compile-cache,target=/tmp/node-compile-cache \
  <<'SH'
  npm install -g @openai/codex
SH

WORKDIR /app
COPY package.json ./
COPY src ./src

RUN \
  --mount=type=cache,id=npm,target=/root/.npm \
  --mount=type=cache,id=node-compile-cache,target=/tmp/node-compile-cache \
  <<'SH'
  npm install -g . --omit=dev
SH

ENV CODEX_HOME=/data/codex

CMD ["codex-usage-exporter"]
