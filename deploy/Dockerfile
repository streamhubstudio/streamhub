# =============================================================================
# StreamHub core image — builds the NestJS core AND bundles the React SPA and
# the browser SDK (streamhub-adaptor) so a single container serves everything.
#
# Build context = repo root (see docker-compose `build.context: .`).
# Multi-stage: web + adaptor + core compile, then a slim runtime.
# =============================================================================

# ---- 1. React SPA (streamhub-web) -> dist ----------------------------------
FROM node:20-bookworm AS web
WORKDIR /web
COPY streamhub-web/package.json streamhub-web/package-lock.json ./
RUN npm ci
COPY streamhub-web/ ./
RUN npm run build

# ---- 2. Browser SDK (streamhub-adaptor IIFE) -> dist/*.global.js -----------
FROM node:20-bookworm AS adaptor
WORKDIR /adaptor
COPY streamhub-adaptor/package.json streamhub-adaptor/package-lock.json ./
RUN npm ci
COPY streamhub-adaptor/ ./
RUN npm run build

# ---- 3. Core (NestJS) -> dist + pruned prod node_modules -------------------
FROM node:20-bookworm AS core
WORKDIR /app
# better-sqlite3 compiles a native addon.
RUN apt-get update && apt-get install -y --no-install-recommends python3 build-essential \
    && rm -rf /var/lib/apt/lists/*
COPY streamhub-core/package.json streamhub-core/package-lock.json ./
RUN npm ci
COPY streamhub-core/ ./
RUN npm run build && npm prune --omit=dev

# ---- 4. Runtime ------------------------------------------------------------
FROM node:20-bookworm-slim AS runtime
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production

# core: compiled JS + native prod deps
COPY --from=core /app/node_modules ./node_modules
COPY --from=core /app/dist ./dist
COPY --from=core /app/package.json ./package.json
# SPA served by ServeStaticModule from CORE/web (i.e. dist/../web)
COPY --from=web /web/dist ./web
# adaptor IIFE staged; entrypoint copies it into <DATA_DIR>/sdk at boot
COPY --from=adaptor /adaptor/dist ./adaptor-dist

# deploy glue (entrypoint + token seeder)
COPY deploy/core-entrypoint.sh /usr/local/bin/entrypoint.sh
COPY deploy/seed-token.js /app/deploy/seed-token.js
RUN chmod +x /usr/local/bin/entrypoint.sh

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "dist/main.js"]
