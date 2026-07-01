# =============================================================================
# Parse Server — standalone ECS task
# =============================================================================
# This image runs parse-server with cloud code from web-legacy-api-server.
# The cloud code (parse-cloud-code/authentication/cloud/main.js) requires
# modules from web-legacy-api-server's node/ directory via relative paths,
# so the full built web-legacy-api-server tree must be present at runtime.
#
# Architecture:
#   Task A  (nginx + node-api)  ──→  ECS Service Connect  ──→  Task B (this)
#
# The node-api container reaches parse via the Service Connect hostname
# (e.g. parse-server.production.local:1337) instead of 127.0.0.1:1337.
# =============================================================================

# ── Stage 1: Clone web-legacy-api-server (needed for cloud code) ─────────────
FROM node:22-alpine AS git-clone

ARG GIT_TOKEN
ARG BRANCH=dev

RUN apk add --no-cache git && \
    git config --global url."https://${GIT_TOKEN}:x-oauth-basic@github.com/".insteadOf "https://github.com/"

RUN git clone -b ${BRANCH} --recurse-submodules --depth 1 \
    https://github.com/insidemaps-org/web-legacy-api-server.git /repo

# ── Stage 2: Build web-legacy-api-server ─────────────────────────────────────
# Cloud code requires the built node/ tree + node_modules at runtime.
FROM node:22-alpine AS web-build

RUN apk add --no-cache openjdk17

WORKDIR /var/www/production

COPY --from=git-clone /repo ./

RUN echo '{"parseServerURLForNode": {"URL": "http://127.0.0.1:1337/parse"}}' > ./config.json

RUN npm ci --prefer-offline && \
    npm run build-ts && \
    npm prune --production && \
    npm cache clean --force

# ── Stage 3: Build parse-server ──────────────────────────────────────────────
FROM node:22-alpine AS parse-build

WORKDIR /parse-server

# Copy dependency manifests first (layer cache)
COPY package.json package-lock.json* ./

RUN npm ci --ignore-scripts && \
    npm cache clean --force

# Copy source and build
COPY . .
RUN npm run build && \
    npm prune --production && \
    npm cache clean --force

# ── Stage 4: Production image ────────────────────────────────────────────────
FROM node:22-alpine AS production

RUN apk add --no-cache --upgrade tini \
    && rm -rf /var/cache/apk/* \
    && addgroup -g 1001 -S nodejs \
    && adduser -S nodejs -u 1001 -G nodejs \
    && mkdir -p /var/log/insideMaps /var/tmp/insideMaps/files \
                /parse-server/config /parse-server/cloud \
    && chown -R nodejs:nodejs /var/log/insideMaps /var/tmp/insideMaps /parse-server

# web-legacy-api-server — needed by cloud code's relative require() paths
WORKDIR /var/www/production
COPY --from=web-build --chown=nodejs:nodejs /var/www/production ./

# parse-server
WORKDIR /parse-server
COPY --from=parse-build --chown=nodejs:nodejs /parse-server ./

# cluster=2 workers share the 4 GB task; cap each worker's V8 heap so two
# workers stay well under the task limit and GC hard instead of aborting
# (SIGABRT + multi-GB core dump) under load.
# Logs are shipped to Grafana Loki (console interception) and CloudWatch
# (awslogs), so the redundant on-disk winston files are disabled.
ENV NODE_ENV=production \
    PORT=1337 \
    NODE_OPTIONS="--disable-warning=DEP0170 --max-old-space-size=2048" \
    PARSE_SERVER_LOGS_FOLDER=null

EXPOSE 1337

USER nodejs

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "./bin/parse-server"]
