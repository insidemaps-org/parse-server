# Stage 1: Clone repository
FROM node:22-alpine AS git-clone
ARG GIT_TOKEN
ARG BRANCH=dev

RUN apk add --no-cache git

RUN git config --global url."https://${GIT_TOKEN}:x-oauth-basic@github.com/".insteadOf "https://github.com/"

RUN git clone -b ${BRANCH} --recurse-submodules --depth 1 \
    https://github.com/insidemaps-org/web-legacy-api-server.git /repo

# Stage 2: Build web-legacy-api-server
FROM node:22-alpine AS web-build

RUN apk add --no-cache openjdk17

WORKDIR /var/www/production

COPY --from=git-clone /repo ./

RUN echo '{"parseServerURLForNode": {"URL": "http://127.0.0.1:1337/parse"}}' > ./config.json

RUN npm ci --prefer-offline && \
    npm run build-ts && \
    npm prune --production && \
    npm cache clean --force

# Stage 3: Build parse-server
FROM node:22-alpine AS parse-build

RUN apk add --no-cache git

WORKDIR /parse-server

COPY . .
RUN npm ci --ignore-scripts && \
    npm run build && \
    npm prune --production && \
    npm cache clean --force

# Stage 4: Final production image
FROM node:22-alpine AS production

RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

RUN mkdir -p /var/log/insideMaps /var/tmp/insideMaps/files /parse-server/config /parse-server/cloud && \
    chown -R nodejs:nodejs /var/log/insideMaps /var/tmp/insideMaps /parse-server

WORKDIR /var/www/production

COPY --from=web-build --chown=nodejs:nodejs /var/www/production ./

WORKDIR /parse-server

COPY --from=parse-build --chown=nodejs:nodejs /parse-server ./

VOLUME ["/parse-server/config", "/parse-server/cloud"]

ENV NODE_ENV=production \
    PORT=1337

EXPOSE $PORT

USER nodejs

ENTRYPOINT ["npm", "start", "--"]
