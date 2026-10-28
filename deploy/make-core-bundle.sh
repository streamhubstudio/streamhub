#!/usr/bin/env bash
# =============================================================================
# make-core-bundle.sh — build the NATIVE (non-Docker) core bundle.
# -----------------------------------------------------------------------------
# Produces dist/streamhub-core-<version>-linux-<arch>.tar.gz with everything the
# plain-server (systemd) shape runs, laid out exactly as deploy-core.sh installs
# it into APP_DIR:
#
#   streamhub-core        the Go core (static, CGO_ENABLED=0, version baked in)
#   VERSION               product version (dashboard footer)
#   web/                  the dashboard SPA (streamhub-web build)
#   adaptor-dist/         the browser SDK IIFE (copied into <DATA_DIR>/sdk at boot)
#   plugins-vendor/       composed decoupled apps (only if apps-pull ran first)
#   streamhub-core.sha256 checksum of the binary
#
# Needs on the BUILD host: go (1.26+), node + npm (SPA/SDK build only). The
# target host needs NO Go, NO Node and NO npm — only ffmpeg/ffprobe (media) and
# python3 (decoupled app workers). The stream-health worker is the binary's own
# `health-worker` subcommand.
#
# Usage:
#   deploy/make-core-bundle.sh [version]        # default: repo-root VERSION
#   GOARCH=arm64 deploy/make-core-bundle.sh     # cross-build
#
# Compose the decoupled apps first (optional): streamhub-core apps pull
# Env: DIST_DIR (default <repo>/dist) · GOARCH (default amd64) · SKIP_WEB=1
#      (reuse an existing streamhub-web/dist + streamhub-adaptor/dist).
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." >/dev/null 2>&1 && pwd)"
DIST_DIR="${DIST_DIR:-$ROOT/dist}"
GOARCH="${GOARCH:-amd64}"

log() { printf '[core-bundle] %s\n' "$*"; }
die() { printf '[core-bundle] ERROR: %s\n' "$*" >&2; exit 1; }

VERSION="${1:-}"
if [ -z "$VERSION" ]; then
  [ -r "$ROOT/VERSION" ] || die "no version given and $ROOT/VERSION is missing"
  VERSION="$(head -1 "$ROOT/VERSION" | tr -d '[:space:]')"
fi
VERSION="${VERSION#v}"
case "$VERSION" in
  [0-9]*.[0-9]*.[0-9]*) : ;;
  *) die "version '$VERSION' is not X.Y.Z" ;;
esac

command -v go >/dev/null 2>&1 || die "go not found (needed to build the core)"

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}';
  else shasum -a 256 "$1" | awk '{print $1}'; fi
}

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

# Build stamp for GET /system/build and the SPA's About panel: the commit from
# the checkout (or STREAMHUB_GIT_COMMIT when building outside one), UTC now.
GIT_COMMIT="${STREAMHUB_GIT_COMMIT:-$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || true)}"
BUILD_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
export STREAMHUB_GIT_COMMIT="$GIT_COMMIT"   # read by streamhub-web/vite.config.ts
VPKG=github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/version

log "building the Go core ($VERSION, linux/$GOARCH, commit ${GIT_COMMIT:0:12})"
# go generate embeds the repo-root CHANGELOG.md (GET /system/changelog).
( cd "$ROOT/streamhub-core-go" && go generate ./internal/buildinfo && \
  CGO_ENABLED=0 GOOS=linux GOARCH="$GOARCH" \
    go build -trimpath \
      -ldflags "-s -w -X $VPKG.Override=$VERSION -X $VPKG.Commit=$GIT_COMMIT -X $VPKG.BuildDate=$BUILD_DATE" \
      -o "$STAGE/streamhub-core" ./cmd/streamhub )

if [ "${SKIP_WEB:-0}" != "1" ]; then
  command -v npm >/dev/null 2>&1 || die "npm not found (needed to build the SPA + SDK; or SKIP_WEB=1)"
  log "building the SPA (streamhub-web)"
  ( cd "$ROOT/streamhub-web" && npm ci && npm run build )
  log "building the browser SDK (streamhub-adaptor)"
  ( cd "$ROOT/streamhub-adaptor" && npm ci && npm run build )
fi
[ -f "$ROOT/streamhub-web/dist/index.html" ] || die "streamhub-web/dist is missing"
cp -a "$ROOT/streamhub-web/dist" "$STAGE/web"
mkdir -p "$STAGE/adaptor-dist"
cp "$ROOT"/streamhub-adaptor/dist/*.global.js "$STAGE/adaptor-dist/" 2>/dev/null \
  || die "streamhub-adaptor/dist/*.global.js is missing"

if find "$ROOT/plugins-vendor" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -q .; then
  log "including the composed decoupled apps (plugins-vendor)"
  cp -a "$ROOT/plugins-vendor" "$STAGE/plugins-vendor"
  rm -f "$STAGE/plugins-vendor/README.md"
else
  log "no composed apps (run `streamhub-core apps pull` first to ship them) — bare core"
  mkdir -p "$STAGE/plugins-vendor"
fi
printf '%s\n' "$VERSION" > "$STAGE/VERSION"
cp "$ROOT/LICENSE" "$STAGE/LICENSE"
printf '%s  streamhub-core\n' "$(sha256 "$STAGE/streamhub-core")" > "$STAGE/streamhub-core.sha256"

mkdir -p "$DIST_DIR"
OUT="$DIST_DIR/streamhub-core-$VERSION-linux-$GOARCH.tar.gz"
tar -czf "$OUT" -C "$STAGE" .
log "bundle : $OUT ($(du -h "$OUT" | awk '{print $1}'))"
log "sha256 : $(sha256 "$OUT")"
