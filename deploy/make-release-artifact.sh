#!/usr/bin/env bash
# =============================================================================
# make-release-artifact.sh — build a versioned StreamHub source artifact.
# -----------------------------------------------------------------------------
# Produces the SAME artifact the CI `release:artifact` job publishes, but
# runnable locally so you can host it at a temp URL and validate the installer's
# upgrade path against a real box:
#
#   dist/streamhub-<version>.tar.gz   flat source tree (docker-compose.yml at
#                                     the archive root — what install.sh expects)
#                                     with a stamped VERSION = <version>
#   dist/latest.json                  {version, tarball, sha256, installer,
#                                     published_at} manifest for the landing
#
# EXCLUDES (never shipped): .git, all node_modules / dist / coverage /
# __pycache__ / .pytest_cache build output, the runtime data/ tree, and every
# secret (.env, .env.local, *.local, Access.md, deploy-streamhub.sh).
# INCLUDES: install.sh, uninstall.sh, deploy/ (incl. the streamhub CLI +
# systemd unit), the component sources, docs.
#
# Usage:
#   deploy/make-release-artifact.sh [version]     # default: repo-root VERSION
#   deploy/make-release-artifact.sh 2.2.0
#
# Env:  DIST_DIR (default <repo>/dist) · PUBLISHED_AT (default: now, UTC ISO8601;
#       CI passes $CI_JOB_STARTED_AT).
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." >/dev/null 2>&1 && pwd)"
DIST_DIR="${DIST_DIR:-$ROOT/dist}"

log()  { printf '[release] %s\n' "$*"; }
die()  { printf '[release] ERROR: %s\n' "$*" >&2; exit 1; }

# ---- version (arg, else repo-root VERSION), normalized (strip a leading v) ---
VERSION="${1:-}"
if [ -z "$VERSION" ]; then
  [ -r "$ROOT/VERSION" ] || die "no version given and $ROOT/VERSION is missing"
  VERSION="$(head -1 "$ROOT/VERSION" | tr -d '[:space:]')"
fi
VERSION="${VERSION#v}"
[ -n "$VERSION" ] || die "empty version"
case "$VERSION" in
  [0-9]*.[0-9]*.[0-9]*) : ;;
  *) die "version '$VERSION' is not X.Y.Z" ;;
esac

TARBALL="streamhub-$VERSION.tar.gz"
OUT="$DIST_DIR/$TARBALL"
PUBLISHED_AT="${PUBLISHED_AT:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"

# ---- sha256 helper (linux: sha256sum, macOS: shasum -a 256) ------------------
sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}';
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}';
  else die "no sha256sum / shasum available"; fi
}

# ---- stage a clean, deterministic copy of the tree --------------------------
# find enumerates the files to ship (pruning build output + the data/ tree +
# secrets), then a tar-pipe copies exactly that set into staging. VERSION is
# stamped LAST so the archive always carries the release version.
STAGING="$(mktemp -d)"
FILELIST="$(mktemp)"
cleanup() { rm -rf "$STAGING" "$FILELIST"; }
trap cleanup EXIT

log "staging source from $ROOT (excluding build output, data/, secrets)"
# Prune build output, the runtime data/ + per-app DB trees (at ANY depth, not
# just root — the dev core writes streamhub-core/data + streamhub-core/apps),
# any 'secrets' dir, and secret files. Belt-and-suspenders: also drop every
# *.db* file by name so a stray SQLite DB can never ride along.
( cd "$ROOT" && find . \
    \( -name .git -o -name node_modules -o -name dist -o -name coverage \
       -o -name __pycache__ -o -name .pytest_cache \
       -o -name data -o -name secrets -o -path './.claude' \
       -o -name '.env' -o -name '.env.local' -o -name '*.local' \
       -o -path './Access.md' -o -path './deploy-streamhub.sh' \
    \) -prune -o -type f \
       ! -name '.DS_Store' ! -name '*.log' ! -name 'VERSION' \
       ! -name '*.db' ! -name '*.db-wal' ! -name '*.db-shm' ! -name '*.db.bak-*' \
       -print ) > "$FILELIST"

[ -s "$FILELIST" ] || die "staging file list is empty — wrong ROOT ($ROOT)?"

# Copy the enumerated files into staging, preserving the tree layout.
tar -cf - -C "$ROOT" -T "$FILELIST" | tar -xf - -C "$STAGING"

# Stamp VERSION = the release version (authoritative for the installer).
printf '%s\n' "$VERSION" > "$STAGING/VERSION"

# Sanity: the installer keys off docker-compose.yml at the archive root.
[ -f "$STAGING/docker-compose.yml" ] || die "docker-compose.yml missing from staging — refusing to ship"
[ -f "$STAGING/install.sh" ]         || die "install.sh missing from staging — refusing to ship"

# ---- pack + manifest --------------------------------------------------------
mkdir -p "$DIST_DIR"
log "packing $OUT"
tar -czf "$OUT" -C "$STAGING" .

SHA="$(sha256 "$OUT")"

cat > "$DIST_DIR/latest.json" <<JSON
{
  "version": "$VERSION",
  "tarball": "$TARBALL",
  "sha256": "$SHA",
  "installer": "install.sh",
  "published_at": "$PUBLISHED_AT"
}
JSON

# Also copy the installer + uninstaller next to the artifact so a single publish
# step can mirror the whole landing payload from dist/.
cp -f "$ROOT/install.sh" "$DIST_DIR/install.sh"
cp -f "$ROOT/uninstall.sh" "$DIST_DIR/uninstall.sh" 2>/dev/null || true

log "artifact : $OUT"
log "size     : $(du -h "$OUT" | awk '{print $1}')"
log "sha256   : $SHA"
log "manifest : $DIST_DIR/latest.json"
log "installer: $DIST_DIR/install.sh"
printf '%s  %s\n' "$SHA" "$TARBALL"
