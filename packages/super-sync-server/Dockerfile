# ---- Builder stage ----
FROM node:24-alpine AS builder

WORKDIR /repo

RUN apk add --no-cache openssl libc6-compat

# Root package + lock (for workspace install)
COPY package.json package-lock.json ./
COPY packages/shared-schema/package.json ./packages/shared-schema/
COPY packages/super-sync-server/package.json ./packages/super-sync-server/

# Install ALL dependencies for the monorepo
# Use npm ci for reproducible builds; requires compatible lockfile
RUN npm ci --ignore-scripts

# Copy source code
COPY packages/shared-schema/ ./packages/shared-schema/
COPY packages/super-sync-server/ ./packages/super-sync-server/

# Build shared-schema
WORKDIR /repo/packages/shared-schema
RUN npm run build
# Pack shared-schema to tgz for installation in production
RUN npm pack

# Build super-sync-server
WORKDIR /repo/packages/super-sync-server
RUN npx prisma generate
RUN rm -rf dist && npm run build

# ---- Web app builder (only built for --target planner) ----
# Debian base: the Angular toolchain's native deps; node:24 ships npm 11 (npm 10 crashes on
# this lockfile with "Cannot read properties of null (reading 'edgesOut')").
FROM node:24 AS web

WORKDIR /repo
ENV NODE_OPTIONS=--max-old-space-size=6144

# npm ci needs every workspace manifest listed by root "workspaces": ["packages/*"]
COPY package.json package-lock.json tsconfig.json ./
COPY packages/plugin-api/ ./packages/plugin-api/
COPY packages/shared-schema/ ./packages/shared-schema/
COPY packages/plugin-dev/package.json ./packages/plugin-dev/
COPY packages/vite-plugin/package.json ./packages/vite-plugin/
COPY packages/super-sync-server/package.json ./packages/super-sync-server/
COPY tools/ ./tools/
RUN npm ci --ignore-scripts && npm run prepare

COPY . .
# Default environment.prod.ts: superSyncBaseUrl '' (same origin), isLoginRequired true.
# Output: dist/browser
RUN npm run buildFrontend:prodWeb

# ---- Runtime base ----
FROM node:24-alpine AS runtime

# System deps for Prisma & healthcheck + create user BEFORE copying files
RUN apk add --no-cache openssl libc6-compat wget && \
    addgroup -g 1001 -S nodejs && \
    adduser -S supersync -u 1001 -G nodejs && \
    mkdir -p /app/data && chown supersync:nodejs /app /app/data

WORKDIR /app

# Copy built artifacts from builder (note: tsconfig rootDir is "." so structure is dist/src/ and dist/scripts/)
COPY --from=builder --chown=supersync:nodejs /repo/packages/super-sync-server/dist ./dist
COPY --from=builder --chown=supersync:nodejs /repo/packages/super-sync-server/public ./public
COPY --from=builder --chown=supersync:nodejs /repo/packages/super-sync-server/prisma ./prisma
COPY --from=builder --chown=supersync:nodejs /repo/packages/super-sync-server/scripts ./scripts
COPY --from=builder --chown=supersync:nodejs /repo/packages/super-sync-server/src ./src
COPY --from=builder --chown=supersync:nodejs /repo/packages/super-sync-server/package.json ./package.json
COPY --from=builder --chown=supersync:nodejs /repo/packages/shared-schema/sp-shared-schema-*.tgz ./shared-schema.tgz

# Install dependencies and generate Prisma client in single layer
# Note: prisma CLI installed explicitly for runtime migrate deploy
# IMPORTANT: prisma version must match @prisma/client in package.json
RUN npm install ./shared-schema.tgz --ignore-scripts && \
    npm install --ignore-scripts --omit=dev && \
    npm install prisma@5.22.0 --ignore-scripts && \
    npx prisma generate && \
    rm -f shared-schema.tgz && \
    npm cache clean --force

USER supersync

EXPOSE 1900

ENV NODE_ENV=production
ENV PORT=1900
ENV DATA_DIR=/app/data

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:${PORT}/health || exit 1

CMD ["sh", "-c", "npx prisma migrate deploy && node dist/src/index.js"]

# ---- planner: server + Angular app on one origin (docker-compose.planner.yml) ----
FROM runtime AS planner
COPY --from=web --chown=supersync:nodejs /repo/dist/browser /app/web
ENV WEB_ROOT=/app/web
# No outbound calls at runtime: Prisma CLI update checks and npm update notices
ENV CHECKPOINT_DISABLE=1 NPM_CONFIG_UPDATE_NOTIFIER=false
# Also handles an empty database (no initial migration exists; see the script)
CMD ["sh", "scripts/docker-start.sh"]

# ---- Default target (last stage): server only, as before ----
FROM runtime AS production
