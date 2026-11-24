# Build each stage for the target platform so native dependencies match the runner.
FROM node:22-alpine AS deps
ARG NPM_REGISTRY=https://registry.npmjs.org
WORKDIR /app
RUN apk add --no-cache gcompat
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm ci --registry="${NPM_REGISTRY}" --no-audit --no-fund --maxsockets=5 --fetch-timeout=40000

FROM node:22-alpine AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
RUN apk add --no-cache gcompat
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# next.config.ts must enable output: "standalone" before building.
RUN npm run build

FROM node:22-alpine AS runner
ARG NPM_REGISTRY=https://registry.npmjs.org
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    TZ=Asia/Shanghai \
    APP_TIMEZONE=Asia/Shanghai \
    PORT=3000 \
    HOSTNAME=0.0.0.0
RUN apk add --no-cache gcompat tzdata \
    && addgroup --system --gid 1001 nodejs \
    && adduser --system --uid 1001 --ingroup nodejs nextjs

# Install the locked production dependency tree independently of Next's tracing.
# Stage 1 must list drizzle-orm and postgres in dependencies, not devDependencies.
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm ci --omit=dev --ignore-scripts --registry="${NPM_REGISTRY}" --no-audit --no-fund --maxsockets=5 --fetch-timeout=40000 \
    && node -e "require.resolve('drizzle-orm/postgres-js/migrator'); require.resolve('postgres')"

COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/drizzle ./drizzle
COPY --from=builder --chown=nextjs:nodejs /app/scripts ./scripts
COPY --from=builder --chown=nextjs:nodejs /app/src/lib/db/index.ts /app/src/lib/db/schema.ts ./src/lib/db/
COPY --from=builder --chown=nextjs:nodejs /app/src/lib/feishu/messages.ts /app/src/lib/feishu/card-format.ts ./src/lib/feishu/
RUN mkdir -p .next/cache \
    && chown -R nextjs:nodejs .next \
    && chmod 755 scripts/docker-entrypoint.sh
USER nextjs
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=180s --retries=3 \
    CMD wget -q -T 4 -O /dev/null "http://127.0.0.1:${PORT}/api/health" || exit 1
ENTRYPOINT ["/app/scripts/docker-entrypoint.sh"]
