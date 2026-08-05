FROM node:22-bookworm-slim AS dependencies

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

FROM dependencies AS builder

COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build
RUN npm run build:worker
RUN npm run build:discord-worker

FROM node:22-bookworm-slim AS discord-dependencies

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM discord-dependencies AS discord-runner

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1

RUN groupadd --system --gid 1001 nodejs \
  && useradd --system --uid 1001 --gid nodejs nextjs

COPY --from=builder --chown=nextjs:nodejs /app/.next/worker/discord-worker.mjs ./worker/discord-worker.mjs

USER nextjs

FROM node:22-bookworm-slim AS runner

WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000

RUN apt-get update \
  && apt-get install -y --no-install-recommends openjdk-17-jre-headless ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --system --gid 1001 nodejs \
  && useradd --system --uid 1001 --gid nodejs nextjs

COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/scripts/background-worker.mjs ./scripts/background-worker.mjs
COPY --from=builder --chown=nextjs:nodejs /app/.next/worker ./worker
COPY --from=builder --chown=nextjs:nodejs /app/scripts/storage-maintenance.mjs ./scripts/storage-maintenance.mjs
COPY --from=builder --chown=nextjs:nodejs /app/lib/storage-protocol.mjs ./lib/storage-protocol.mjs
COPY --from=builder --chown=nextjs:nodejs /app/lib/local-filesystem-storage.mjs ./lib/local-filesystem-storage.mjs
COPY --from=builder --chown=nextjs:nodejs /app/scripts/migrate.mjs ./scripts/migrate.mjs
COPY --from=builder --chown=nextjs:nodejs /app/lib/runtime-preflight.mjs ./lib/runtime-preflight.mjs
COPY --from=builder --chown=nextjs:nodejs /app/scripts/owner-auth-cli.mjs ./scripts/owner-auth-cli.mjs
COPY --from=builder --chown=nextjs:nodejs /app/scripts/bootstrap-owner.mjs ./scripts/bootstrap-owner.mjs
COPY --from=builder --chown=nextjs:nodejs /app/scripts/reset-owner-password.mjs ./scripts/reset-owner-password.mjs
COPY --from=builder --chown=nextjs:nodejs /app/database ./database
COPY --from=builder --chown=nextjs:nodejs /app/config ./config
COPY --from=builder --chown=nextjs:nodejs /app/scripts/provision-miniflux-feeds.mjs ./scripts/provision-miniflux-feeds.mjs
COPY --from=builder --chown=nextjs:nodejs /app/app/server/auth/password.mjs ./app/server/auth/password.mjs
COPY --from=builder --chown=nextjs:nodejs /app/app/server/auth/owner-auth-repository.mjs ./app/server/auth/owner-auth-repository.mjs
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/postgres ./node_modules/postgres
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/@opendataloader ./node_modules/@opendataloader
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/pdfjs-dist ./node_modules/pdfjs-dist
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/@napi-rs ./node_modules/@napi-rs
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/mammoth ./node_modules/mammoth
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/@xmldom ./node_modules/@xmldom
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/argparse ./node_modules/argparse
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/ansi-styles ./node_modules/ansi-styles
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/base64-js ./node_modules/base64-js
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/bluebird ./node_modules/bluebird
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/color-convert ./node_modules/color-convert
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/color-name ./node_modules/color-name
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/core-util-is ./node_modules/core-util-is
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/dingbat-to-unicode ./node_modules/dingbat-to-unicode
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/duck ./node_modules/duck
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/emoji-regex ./node_modules/emoji-regex
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/escalade ./node_modules/escalade
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/inherits ./node_modules/inherits
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/immediate ./node_modules/immediate
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/isarray ./node_modules/isarray
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/jszip ./node_modules/jszip
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/lie ./node_modules/lie
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/lop ./node_modules/lop
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/option ./node_modules/option
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/pako ./node_modules/pako
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/path-is-absolute ./node_modules/path-is-absolute
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/process-nextick-args ./node_modules/process-nextick-args
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/readable-stream ./node_modules/readable-stream
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/safe-buffer ./node_modules/safe-buffer
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/setimmediate ./node_modules/setimmediate
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/string_decoder ./node_modules/string_decoder
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/underscore ./node_modules/underscore
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/util-deprecate ./node_modules/util-deprecate
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/xmlbuilder ./node_modules/xmlbuilder
COPY --from=builder /app/docker/app-entrypoint.sh /usr/local/bin/app-entrypoint
RUN chmod 0555 /usr/local/bin/app-entrypoint

USER nextjs
ENTRYPOINT ["/usr/local/bin/app-entrypoint"]
CMD ["node", "server.js"]
