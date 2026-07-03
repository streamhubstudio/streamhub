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

# INSTALL_YOLO_WORKER=1 additionally bakes the yolo worker, which pulls CPU
# torch via ultralytics (~1GB+). Default 0 keeps the image lean: only the
# CPU-light deface worker is baked; enable yolo per build with
#   docker build --build-arg INSTALL_YOLO_WORKER=1 ...
ARG INSTALL_YOLO_WORKER=0

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
# SPA served by ServeStaticModule from CORE/web (i.e. dist/../web)
COPY --from=web /web/dist ./web
# adaptor IIFE staged; entrypoint copies it into <DATA_DIR>/sdk at boot
COPY --from=adaptor /adaptor/dist ./adaptor-dist

# ---- Python worker runtime (needsWorker plugins spawn `python -m <worker>`) --
# requirements FIRST (they change rarely) so the heavy pip layer stays cached
# across worker-code edits. deface is always baked; yolo only when
# INSTALL_YOLO_WORKER=1. The plugin metas resolve the interpreter via
# PLUGIN_PYTHON and the package dir via DEFACE_WORKER_DIR / YOLO_WORKER_DIR,
# pointed below at the venv + the copied trees.
RUN python3 -m venv /opt/workers/venv
COPY deface-worker/requirements.txt /opt/workers/deface-worker/requirements.txt
COPY yolo-worker/requirements.txt   /opt/workers/yolo-worker/requirements.txt
RUN /opt/workers/venv/bin/pip install --no-cache-dir --upgrade pip \
    && /opt/workers/venv/bin/pip install --no-cache-dir -r /opt/workers/deface-worker/requirements.txt \
    && if [ "$INSTALL_YOLO_WORKER" = "1" ]; then \
         /opt/workers/venv/bin/pip install --no-cache-dir \
             torch torchvision --index-url https://download.pytorch.org/whl/cpu \
         && /opt/workers/venv/bin/pip install --no-cache-dir -r /opt/workers/yolo-worker/requirements.txt ; \
       fi
# worker code AFTER deps (it changes more often than requirements)
COPY deface-worker/ /opt/workers/deface-worker/
COPY yolo-worker/   /opt/workers/yolo-worker/
ENV PLUGIN_PYTHON=/opt/workers/venv/bin/python \
    DEFACE_WORKER_DIR=/opt/workers/deface-worker \
    YOLO_WORKER_DIR=/opt/workers/yolo-worker

# deploy glue (entrypoint + token seeder)
COPY deploy/core-entrypoint.sh /usr/local/bin/entrypoint.sh
COPY deploy/seed-token.js /app/deploy/seed-token.js
RUN chmod +x /usr/local/bin/entrypoint.sh

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "dist/main.js"]
