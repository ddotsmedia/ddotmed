# Built from the repository root: docker build -f services/core-api/Dockerfile .
FROM node:22-alpine AS base
RUN corepack enable && apk add --no-cache libc6-compat openssl

# ── dependencies ──────────────────────────────────────────────────────────────
FROM base AS deps
WORKDIR /repo
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/shared-types/package.json ./packages/shared-types/
COPY packages/i18n/package.json ./packages/i18n/
COPY packages/country-packs/package.json ./packages/country-packs/
COPY services/core-api/package.json ./services/core-api/
RUN pnpm install --frozen-lockfile --filter @medicore/core-api...

# ── build ─────────────────────────────────────────────────────────────────────
FROM base AS builder
WORKDIR /repo
COPY --from=deps /repo/node_modules ./node_modules
COPY --from=deps /repo/packages ./packages
COPY --from=deps /repo/services/core-api/node_modules ./services/core-api/node_modules
COPY . .

RUN pnpm --filter "@medicore/shared-types" --filter "@medicore/i18n" --filter "@medicore/country-packs" run build \
 && pnpm --filter @medicore/core-api exec prisma generate \
 && pnpm --filter @medicore/core-api run build \
 && pnpm deploy --legacy --filter @medicore/core-api --prod /out
# --legacy: pnpm 10+ otherwise requires inject-workspace-packages=true, which would
# copy workspace deps instead of symlinking them and break hot reload in local dev.
# Scoping the flag to the image keeps the workspace symlinked for developers.

# ── runtime ───────────────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production PORT=4000

RUN apk add --no-cache openssl \
 && addgroup -g 10001 -S medicore && adduser -u 10001 -S medicore -G medicore

COPY --from=builder --chown=medicore:medicore /out/node_modules ./node_modules
COPY --from=builder --chown=medicore:medicore /repo/services/core-api/dist ./dist
COPY --from=builder --chown=medicore:medicore /repo/services/core-api/prisma ./prisma
COPY --from=builder --chown=medicore:medicore /repo/services/core-api/package.json ./

# `prisma generate` in the builder writes into that stage's node_modules, which
# `pnpm deploy` then rebuilds from the store — so the generated client is lost.
# Regenerate against the deployed tree, at build time rather than on every boot.
RUN npx prisma generate \
 && chown -R medicore:medicore node_modules

USER medicore
EXPOSE 4000

HEALTHCHECK --interval=20s --timeout=10s --start-period=40s --retries=5 \
    CMD wget -qO- http://localhost:4000/health || exit 1

# Migrations are applied on start so a fresh VPS converges without a manual step.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main.js"]
