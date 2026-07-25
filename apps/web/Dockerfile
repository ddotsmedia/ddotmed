# Built from the repository root: docker build -f apps/web/Dockerfile .
FROM node:22-alpine AS base
RUN corepack enable && apk add --no-cache libc6-compat

# ── dependencies ──────────────────────────────────────────────────────────────
FROM base AS deps
WORKDIR /repo
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/shared-types/package.json ./packages/shared-types/
COPY packages/i18n/package.json ./packages/i18n/
COPY packages/ui-components/package.json ./packages/ui-components/
COPY packages/country-packs/package.json ./packages/country-packs/
COPY apps/web/package.json ./apps/web/
RUN pnpm install --frozen-lockfile --filter @medicore/web...

# ── build ─────────────────────────────────────────────────────────────────────
FROM base AS builder
WORKDIR /repo
ENV NEXT_TELEMETRY_DISABLED=1 NEXT_OUTPUT=standalone
COPY --from=deps /repo/node_modules ./node_modules
COPY --from=deps /repo/packages ./packages
COPY --from=deps /repo/apps/web/node_modules ./apps/web/node_modules
COPY . .

ARG NEXT_PUBLIC_API_URL=/api
ARG NEXT_PUBLIC_WS_URL=/ws
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL NEXT_PUBLIC_WS_URL=$NEXT_PUBLIC_WS_URL

RUN pnpm --filter "@medicore/shared-types" --filter "@medicore/i18n" --filter "@medicore/country-packs" run build \
 && pnpm --filter @medicore/web run build

# ── runtime ───────────────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0

RUN addgroup -g 10001 -S medicore && adduser -u 10001 -S medicore -G medicore

COPY --from=builder --chown=medicore:medicore /repo/apps/web/.next/standalone ./
COPY --from=builder --chown=medicore:medicore /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=medicore:medicore /repo/apps/web/public ./apps/web/public

USER medicore
EXPOSE 3000

HEALTHCHECK --interval=20s --timeout=10s --start-period=40s --retries=5 \
    CMD wget -qO- http://localhost:3000/api/health || exit 1

CMD ["node", "apps/web/server.js"]
