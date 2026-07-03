#!/usr/bin/env bash
# =============================================================================
# StreamHub — safe plain-server deploy of streamhub-core (systemd).
# -----------------------------------------------------------------------------
# The secure replacement for the old deploy-streamhub.sh (which hardcoded
# secrets — gitignored, never commit it). This script NEVER takes secrets on the
# command line and NEVER writes them: it assumes the host .env already exists in
# APP_DIR and leaves it untouched. It just ships new code and restarts:
#
#   1. sanity-check APP_DIR + its .env (must already exist — no secret creation)
#   2. back up the DBs + secrets via deploy/backup.sh (abort if that fails)
#   3. overlay the new core code from a tarball onto APP_DIR
#      (tar overlay: it never removes .env / data/ / apps/ / logs/)
#   4. npm ci && npm run build
#   5. systemctl restart the service, then wait for /api/v1/health
#
# Usage:
#   deploy/deploy-core.sh <core.tar.gz>
#   CORE_TARBALL=/tmp/core.tgz deploy/deploy-core.sh
#   APP_DIR=/opt/streamhub-core SERVICE_NAME=streamhub deploy/deploy-core.sh core.tgz
#
# The tarball must contain the core files at its ROOT, e.g. built with:
#   tar czf core.tgz -C streamhub-core .
#
# Flags:  --tarball FILE   same as the positional arg / CORE_TARBALL
#         --skip-backup    skip step 2 (NOT recommended)
#         --no-restart     do everything except the systemctl restart
#
# Env:  APP_DIR (default /opt/streamhub-core) · SERVICE_NAME (default streamhub)
#       BACKUP_DATA_DIR (default <APP_DIR>/data) · PORT (default 3020)
#
# Exit codes: 0 ok · 1 usage · 2 preflight · 3 backup failed · 4 build failed
#             · 5 service/health failed.
# =============================================================================
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/streamhub-core}"
SERVICE_NAME="${SERVICE_NAME:-streamhub}"
PORT="${PORT:-3020}"
CORE_TARBALL="${CORE_TARBALL:-}"
SKIP_BACKUP=0
NO_RESTART=0

log()  { printf '[deploy %s] %s\n'  "$(date -u +%H:%M:%S)" "$*"; }
warn() { printf '[deploy %s] WARN: %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
die()  { printf '[deploy %s] ERROR: %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; exit "${2:-1}"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --tarball)    CORE_TARBALL="${2:-}"; shift 2 ;;
    --skip-backup) SKIP_BACKUP=1; shift ;;
    --no-restart) NO_RESTART=1; shift ;;
    -h|--help) sed -n '2,45p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) die "unknown flag: $1 (see --help)" 1 ;;
    *) CORE_TARBALL="$1"; shift ;;
  esac
done

# where THIS script lives, so we can call its sibling backup.sh
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# --- 1. preflight ------------------------------------------------------------
[ -n "$CORE_TARBALL" ] || die "no tarball given (pass a path or set CORE_TARBALL)" 1
[ -f "$CORE_TARBALL" ] || die "tarball not found: $CORE_TARBALL" 2
command -v npm >/dev/null 2>&1 || die "npm not found" 2
command -v systemctl >/dev/null 2>&1 || die "systemctl not found (this path is for systemd hosts)" 2
[ -d "$APP_DIR" ] || die "APP_DIR does not exist: $APP_DIR" 2

if [ ! -f "$APP_DIR/.env" ]; then
  die "no .env in $APP_DIR — this script does not create secrets. Run install.sh for first-time setup, or place a filled .env there first." 2
fi
log "APP_DIR=$APP_DIR SERVICE_NAME=$SERVICE_NAME (reusing existing .env)"

# --- 2. backup ---------------------------------------------------------------
if [ "$SKIP_BACKUP" = "0" ]; then
  export BACKUP_DATA_DIR="${BACKUP_DATA_DIR:-$APP_DIR/data}"
  if [ -x "$SCRIPT_DIR/backup.sh" ]; then
    log "backing up before deploy (BACKUP_DATA_DIR=$BACKUP_DATA_DIR)"
    "$SCRIPT_DIR/backup.sh" || die "pre-deploy backup failed — aborting (override with --skip-backup)" 3
  else
    warn "backup.sh not executable/found next to this script; skipping backup"
  fi
else
  warn "--skip-backup: no pre-deploy backup taken"
fi

# --- 3. overlay new code -----------------------------------------------------
# tar extraction only ADDS/updates files present in the archive; it never
# deletes .env, data/, apps/ or logs/ that are not in the tarball.
log "extracting core tarball into $APP_DIR"
tar -xzf "$CORE_TARBALL" -C "$APP_DIR" || die "failed to extract $CORE_TARBALL" 2

# --- 4. build ----------------------------------------------------------------
log "installing deps + building (npm ci && npm run build)"
( cd "$APP_DIR" && npm ci && npm run build ) || die "npm ci / build failed" 4

# --- 5. restart + health -----------------------------------------------------
if [ "$NO_RESTART" = "1" ]; then
  log "--no-restart: skipping systemctl restart. Done (build only)."
  exit 0
fi

log "restarting service $SERVICE_NAME"
systemctl restart "$SERVICE_NAME" || die "systemctl restart $SERVICE_NAME failed" 5

log "waiting for core health on 127.0.0.1:$PORT ..."
healthy=0
for _ in $(seq 1 20); do
  if command -v curl >/dev/null 2>&1 \
     && curl -fsS "http://127.0.0.1:${PORT}/api/v1/health" >/dev/null 2>&1; then
    healthy=1; break
  fi
  sleep 2
done

if [ "$healthy" = "1" ]; then
  log "deploy OK — $SERVICE_NAME is healthy"
else
  systemctl --no-pager --lines=30 status "$SERVICE_NAME" || true
  die "service restarted but /api/v1/health did not come up — check logs (journalctl -u $SERVICE_NAME)" 5
fi
