# =============================================================================
# StreamHub core image — builds the NestJS core AND bundles the React SPA and
# the browser SDK (streamhub-adaptor) so a single container serves everything.
#
# Build context = repo root (see docker-compose `build.context: .`).
# Multi-stage: web + adaptor + core compile, then a slim runtime.
# =============================================================================

# ---- 1. React SPA (streamhub-web) -> dist ----------------------------------
FROM node:24-bookworm AS web
WORKDIR /web
COPY streamhub-web/package.json streamhub-web/package-lock.json ./
RUN npm ci
COPY streamhub-web/ ./
RUN npm run build

# ---- 2. Browser SDK (streamhub-adaptor IIFE) -> dist/*.global.js -----------
FROM node:24-bookworm AS adaptor
WORKDIR /adaptor
COPY streamhub-adaptor/package.json streamhub-adaptor/package-lock.json ./
RUN npm ci
COPY streamhub-adaptor/ ./
RUN npm run build

# ---- 3. Core (NestJS) -> dist + pruned prod node_modules -------------------
FROM node:24-bookworm AS core
WORKDIR /app
# better-sqlite3 compiles a native addon.
RUN apt-get update && apt-get install -y --no-install-recommends python3 build-essential \
    && rm -rf /var/lib/apt/lists/*
COPY streamhub-core/package.json streamhub-core/package-lock.json ./
RUN npm ci
COPY streamhub-core/ ./
RUN npm run build && npm prune --omit=dev

# ---- 4. Runtime ------------------------------------------------------------
FROM node:24-bookworm-slim AS runtime
WORKDIR /app

# INSTALL_VENDORED_WORKER_DEPS selects which COMPOSED (decoupled) apps get
# their worker python deps BAKED into the image: a comma list of app ids
# ("deface,yolo"), "all", or "0" (bare media server — install.sh --no-plugins).
# The worker SOURCE always rides inside dist/plugins-vendor/<id>/worker (the
# portable composition, 2.20+); this arg only controls the pip layer. Heavy
# stacks (yolo/presence/vision pull CPU torch ~1GB+) stay opt-in; the default
# bakes only the CPU-light deface deps — and no-ops gracefully on a hermetic
# (uncomposed) build where dist/plugins-vendor is absent.
ARG INSTALL_VENDORED_WORKER_DEPS=deface
# Legacy alias kept for install.sh/compose compatibility: 0 → bare.
ARG INSTALL_DEFACE_WORKER=1

# ca-certificates for TLS; python3 + venv host the needsWorker plugin runtime;
# ffmpeg is the CORE's own binary (snapshots, VOD transcode — and h264_nvenc/
# hevc_nvenc when the container is granted a GPU via `gpus: all` + the
# nvidia-container-toolkit). The workers don't need it: opencv-python-headless
# bundles its own FFmpeg libs and needs no libGL, so glib is their only extra.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates python3 python3-venv libglib2.0-0 ffmpeg \
    && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production

# core: compiled JS + native prod deps
COPY --from=core /app/node_modules ./node_modules
COPY --from=core /app/dist ./dist
COPY --from=core /app/package.json ./package.json
# real product version (repo-root VERSION) — read by modules/health/app-version
# and surfaced on /health + /auth/config.appVersion (dashboard footer)
COPY VERSION ./VERSION
# SPA served by ServeStaticModule from CORE/web (i.e. dist/../web)
COPY --from=web /web/dist ./web
# adaptor IIFE staged; entrypoint copies it into <DATA_DIR>/sdk at boot
COPY --from=adaptor /adaptor/dist ./adaptor-dist

# ---- Python worker runtime (needsWorker plugins spawn `python -m <worker>`) --
# The DECOUPLED apps' worker SOURCE already lives inside the core image at
# dist/plugins-vendor/<id>/worker (portable composition, 2.20+); the registry
# resolves each spawn there, so NO per-worker COPY exists anymore. This layer
# provides the interpreter (venv) and OPTIONALLY bakes selected apps' pip deps
# (INSTALL_VENDORED_WORKER_DEPS — see the ARG block above). A hermetic build
# (dist/plugins-vendor absent) no-ops. requirements resolve from the vendored
# trees copied with dist above, so the pip layer re-runs only when they change.
RUN python3 -m venv /opt/workers/venv \
    && /opt/workers/venv/bin/pip install --no-cache-dir --upgrade pip \
    && SEL="$INSTALL_VENDORED_WORKER_DEPS" \
    && if [ "$INSTALL_DEFACE_WORKER" = "0" ]; then SEL="0"; fi \
    && if [ "$SEL" != "0" ] && [ -d dist/plugins-vendor ]; then \
         for req in dist/plugins-vendor/*/worker/requirements.txt; do \
           [ -f "$req" ] || continue; \
           id=$(basename $(dirname $(dirname "$req"))); \
           case ",$SEL," in \
             *,all,*|*",$id,"*) \
               echo "baking worker deps: $id"; \
               /opt/workers/venv/bin/pip install --no-cache-dir -r "$req" ;; \
           esac; \
         done; \
       fi
# stream-health worker: plain Node (the core's own runtime), ZERO npm deps —
# no install step, just the source. It shells out to the ffmpeg/ffprobe
# binaries installed above for the core.
COPY health-worker/   /opt/workers/health-worker/
ENV PLUGIN_PYTHON=/opt/workers/venv/bin/python \
    HEALTH_WORKER_DIR=/opt/workers/health-worker

# ---- Studio App export sources ----------------------------------------------
# The exporter/appstore resolve each DECOUPLED app's worker source from its
# vendored package (dist/plugins-vendor/<id>/worker — version-pinned) since
# 2.20; the old per-worker /opt/worker-src copies are gone with the exodus.
# Only the repo LICENSE stays staged so exported bundles carry it.
COPY LICENSE                /opt/worker-src/LICENSE
ENV STREAMHUB_WORKER_SRC_ROOT=/opt/worker-src

# deploy glue (entrypoint + token seeder)
COPY deploy/core-entrypoint.sh /usr/local/bin/entrypoint.sh
COPY deploy/seed-token.js /app/deploy/seed-token.js
RUN chmod +x /usr/local/bin/entrypoint.sh

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "dist/main.js"]
