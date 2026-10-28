#!/usr/bin/env bash
# =============================================================================
# make-mcp.sh — cross-build the StreamHub MCP server (streamhub-mcp).
# -----------------------------------------------------------------------------
# One static binary per platform (CGO_ENABLED=0), no runtime needed on the
# client machine:
#
#   dist/streamhub-mcp-<version>-<os>-<arch>[.exe]   + .sha256
#
# for darwin/linux/windows × amd64/arm64. Point Claude Desktop / Claude Code
# at the binary (https://streamhub.studio/docs/integrations/MCP).
#
# Usage:
#   deploy/make-mcp.sh [version]          # default: repo-root VERSION
#   TARGETS="linux/amd64 darwin/arm64" deploy/make-mcp.sh
# Env: DIST_DIR (default <repo>/dist) · TARGETS (space-separated os/arch).
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." >/dev/null 2>&1 && pwd)"
DIST_DIR="${DIST_DIR:-$ROOT/dist}"
TARGETS="${TARGETS:-darwin/amd64 darwin/arm64 linux/amd64 linux/arm64 windows/amd64 windows/arm64}"

log() { printf '[mcp] %s\n' "$*"; }
die() { printf '[mcp] ERROR: %s\n' "$*" >&2; exit 1; }

VERSION="${1:-}"
if [ -z "$VERSION" ]; then
  [ -r "$ROOT/VERSION" ] || die "no version given and $ROOT/VERSION is missing"
  VERSION="$(head -1 "$ROOT/VERSION" | tr -d '[:space:]')"
fi
VERSION="${VERSION#v}"

command -v go >/dev/null 2>&1 || die "go not found"

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}';
  else shasum -a 256 "$1" | awk '{print $1}'; fi
}

mkdir -p "$DIST_DIR"
for target in $TARGETS; do
  os="${target%/*}"
  arch="${target#*/}"
  ext=""
  [ "$os" = "windows" ] && ext=".exe"
  out="$DIST_DIR/streamhub-mcp-$VERSION-$os-$arch$ext"
  log "building $os/$arch"
  ( cd "$ROOT/streamhub-core-go" && CGO_ENABLED=0 GOOS="$os" GOARCH="$arch" \
      go build -trimpath -ldflags "-s -w" -o "$out" ./cmd/streamhub-mcp )
  printf '%s  %s\n' "$(sha256 "$out")" "$(basename "$out")" > "$out.sha256"
  log "  → $out ($(du -h "$out" | awk '{print $1}'))"
done
