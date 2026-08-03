FROM node:22-bookworm-slim AS dependencies

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

FROM dependencies AS builder

COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:22-bookworm-slim AS runner

WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000

RUN groupadd --system --gid 1001 nodejs \
  && useradd --system --uid 1001 --gid nodejs nextjs

COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/scripts/background-worker.mjs ./scripts/background-worker.mjs
COPY --from=builder --chown=nextjs:nodejs /app/scripts/storage-maintenance.mjs ./scripts/storage-maintenance.mjs
COPY --from=builder --chown=nextjs:nodejs /app/scripts/migrate.mjs ./scripts/migrate.mjs
COPY --from=builder --chown=nextjs:nodejs /app/scripts/owner-auth-cli.mjs ./scripts/owner-auth-cli.mjs
COPY --from=builder --chown=nextjs:nodejs /app/scripts/bootstrap-owner.mjs ./scripts/bootstrap-owner.mjs
COPY --from=builder --chown=nextjs:nodejs /app/scripts/reset-owner-password.mjs ./scripts/reset-owner-password.mjs
COPY --from=builder --chown=nextjs:nodejs /app/database ./database
COPY --from=builder --chown=nextjs:nodejs /app/app/server/auth/password.mjs ./app/server/auth/password.mjs
COPY --from=builder --chown=nextjs:nodejs /app/app/server/auth/owner-auth-repository.mjs ./app/server/auth/owner-auth-repository.mjs
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/postgres ./node_modules/postgres
COPY --from=builder /app/docker/app-entrypoint.sh /usr/local/bin/app-entrypoint
RUN chmod 0555 /usr/local/bin/app-entrypoint

USER nextjs
ENTRYPOINT ["/usr/local/bin/app-entrypoint"]
CMD ["node", "server.js"]
