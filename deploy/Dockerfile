# =============================================================================
# StreamHub core image — the Go core (streamhub-core-go) plus the React SPA and
# the browser SDK (streamhub-adaptor), so a single container serves everything.
#
# Build context = repo root (see docker-compose `build.context: .`).
# Multi-stage: web + adaptor (Node, build-time only) + core (Go, static), then a
# Debian-slim runtime with the media/worker tooling the core shells out to.
#
# Decoupled Studio Apps are composed BEFORE `docker build` by
# `streamhub-core apps pull` (needs STREAMHUB_APPS_TOKEN): it writes
# plugins-vendor/<id>/ (backend manifest + worker source) and
# streamhub-web/src/plugins-vendor/<id>/ (UI). This image copies the former to
# ./plugins-vendor next to the core binary; an uncomposed (hermetic) build just
# ships no vendored apps.
# =============================================================================

# ---- 1. React SPA (streamhub-web) -> dist ----------------------------------
FROM node:24-bookworm-slim AS web
# Build stamp shown in the dashboard's About / Build panel (vite.config.ts
# reads it; the context has no .git). /VERSION gives the web build its version.
ARG STREAMHUB_GIT_COMMIT=""
ENV STREAMHUB_GIT_COMMIT=$STREAMHUB_GIT_COMMIT
WORKDIR /web
COPY streamhub-web/package.json streamhub-web/package-lock.json ./
RUN npm ci
COPY streamhub-web/ ./
COPY VERSION /VERSION
RUN npm run build

# ---- 2. Browser SDK (streamhub-adaptor IIFE) -> dist/*.global.js -----------
FROM node:24-bookworm-slim AS adaptor
WORKDIR /adaptor
COPY streamhub-adaptor/package.json streamhub-adaptor/package-lock.json ./
RUN npm ci
COPY streamhub-adaptor/ ./
RUN npm run build

# ---- 3. Core (Go) -> one static binary ------------------------------------
# (static, CGO_ENABLED=0: the alpine toolchain image is enough and small)
FROM golang:1.26-alpine AS core
WORKDIR /src
COPY streamhub-core-go/go.mod streamhub-core-go/go.sum ./
RUN go mod download
COPY streamhub-core-go/ ./
COPY VERSION /VERSION
# The changelog is embedded into the binary (GET /system/changelog): go:embed
# can't reach outside the module, so `go generate` copies ../../../CHANGELOG.md
# (= /CHANGELOG.md here) into internal/buildinfo/changelog/ first.
COPY CHANGELOG.md /CHANGELOG.md
RUN go generate ./internal/buildinfo
# Product version, commit and build date baked in (GET /system/build; the
# version wins over any VERSION file at runtime). The context has no .git, so
# the commit comes from the STREAMHUB_GIT_COMMIT build arg (compose passes it
# through from the environment; empty = unknown).
ARG STREAMHUB_GIT_COMMIT=""
RUN V=github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/version && \
    CGO_ENABLED=0 go build -trimpath \
      -ldflags "-s -w -X $V.Override=$(head -1 /VERSION | tr -d '[:space:]') -X $V.Commit=${STREAMHUB_GIT_COMMIT} -X $V.BuildDate=$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      -o /out/streamhub-core ./cmd/streamhub

# ---- 4. Composed decoupled apps (optional) -> /out/plugins-vendor ----------
# (plugins-vendor/ always exists: its README.md is committed, the apps are not)
FROM debian:bookworm-slim AS vendor
COPY plugins-vendor/ /out/plugins-vendor/
RUN rm -f /out/plugins-vendor/README.md

# ---- 5. Runtime ------------------------------------------------------------
FROM debian:bookworm-slim AS runtime
WORKDIR /app

# INSTALL_VENDORED_WORKER_DEPS selects which COMPOSED (decoupled) apps get
# their worker python deps BAKED into the image: a comma list of app ids
# ("deface,yolo"), "all", or "0" (bare media server — install.sh --no-plugins).
# The worker SOURCE always rides inside ./plugins-vendor/<id>/worker; this arg
# only controls the pip layer. Heavy stacks (yolo/presence/vision pull CPU torch
# ~1GB+) stay opt-in; the default bakes only the CPU-light deface deps — and
# no-ops gracefully on a hermetic (uncomposed) build.
ARG INSTALL_VENDORED_WORKER_DEPS=deface
# Legacy alias kept for install.sh/compose compatibility: 0 → bare.
ARG INSTALL_DEFACE_WORKER=1

# ca-certificates for TLS (S3, webhooks, appstore); ffmpeg/ffprobe are the
# core's own media tools (snapshots, VOD transcode, passthrough remux — and
# h264_nvenc/hevc_nvenc when the container is granted a GPU via `gpus: all` +
# the nvidia-container-toolkit); python3 + venv host the needsWorker plugin
# runtime (opencv-python-headless bundles its own FFmpeg libs; glib is its only
# extra); tzdata for per-app timezones; sqlite3 for operator backups/restore.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates tzdata ffmpeg python3 python3-venv libglib2.0-0 sqlite3 \
    && rm -rf /var/lib/apt/lists/*

# The core: one static binary (+ a PATH alias for `docker compose exec core
# streamhub-core seed-token …`). VERSION stays next to it for the dashboard
# footer even though the version is also baked in at link time.
COPY --from=core /out/streamhub-core /app/streamhub-core
RUN ln -s /app/streamhub-core /usr/local/bin/streamhub-core
COPY VERSION ./VERSION
# SPA served from ./web next to the binary
COPY --from=web /web/dist ./web
# adaptor IIFE staged; entrypoint copies it into <DATA_DIR>/sdk at boot
COPY --from=adaptor /adaptor/dist ./adaptor-dist
# composed decoupled apps (manifests + worker source), resolved from the
# binary's dir (./plugins-vendor); empty on a hermetic build
COPY --from=vendor /out/plugins-vendor ./plugins-vendor

# ---- Python worker runtime (needsWorker plugins spawn `python -m <worker>`) --
# Provides the interpreter (venv) and OPTIONALLY bakes selected apps' pip deps
# (INSTALL_VENDORED_WORKER_DEPS — see the ARG block above). An empty
# ./plugins-vendor no-ops. requirements resolve from the vendored trees copied
# above, so the pip layer re-runs only when they change. ultralytics (yolo,
# people-counter, presence, vision apps) depends on the GUI opencv-python,
# which shares the cv2 package with opencv-python-headless and needs libGL
# (absent here): it is swapped back to headless after the app deps.
RUN python3 -m venv /opt/workers/venv \
    && /opt/workers/venv/bin/pip install --no-cache-dir --upgrade pip \
    && SEL="$INSTALL_VENDORED_WORKER_DEPS" \
    && if [ "$INSTALL_DEFACE_WORKER" = "0" ]; then SEL="0"; fi \
    && if [ "$SEL" != "0" ]; then \
         for req in plugins-vendor/*/worker/requirements.txt; do \
           [ -f "$req" ] || continue; \
           id=$(basename "$(dirname "$(dirname "$req")")"); \
           case ",$SEL," in \
             *,all,*|*",$id,"*) \
               echo "baking worker deps: $id"; \
               /opt/workers/venv/bin/pip install --no-cache-dir -r "$req" ;; \
           esac; \
         done; \
       fi \
    && if /opt/workers/venv/bin/pip show opencv-python >/dev/null 2>&1; then \
         echo "replacing opencv-python (needs libGL) with opencv-python-headless"; \
         /opt/workers/venv/bin/pip uninstall -y opencv-python \
         && /opt/workers/venv/bin/pip install --no-cache-dir --force-reinstall --no-deps opencv-python-headless; \
       fi

# The stream-health worker is the core binary itself (`streamhub-core
# health-worker`, spawned by the plugin framework): the runtime has no Node.
ENV PLUGIN_PYTHON=/opt/workers/venv/bin/python

# ---- Studio App export sources ----------------------------------------------
# The exporter/appstore resolve each decoupled app's worker source from its
# vendored package (./plugins-vendor/<id>/worker — version-pinned); only the
# repo LICENSE is staged so exported bundles carry it.
COPY LICENSE                /opt/worker-src/LICENSE
ENV STREAMHUB_WORKER_SRC_ROOT=/opt/worker-src

# deploy glue (entrypoint publishes the SDK into <DATA_DIR>/sdk, then execs)
COPY deploy/core-entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=12 \
  CMD ["/app/streamhub-core", "healthcheck"]

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["/app/streamhub-core"]
