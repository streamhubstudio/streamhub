#!/usr/bin/env bash
# =============================================================================
# StreamHub — consistent backup of the SQLite data + per-app secrets.
# -----------------------------------------------------------------------------
# Backs up, from DATA_DIR:
#   * streamhub.db            (global DB: tenants, users, api_tokens, apps, nodes)
#   * apps/<app>/app.db       (one per app: streams, vods, ingress_auth)
#   * secrets.json            (per-app S3 credentials, chmod 600)
#
# Each *.db is snapshotted with `sqlite3 … "VACUUM INTO"` — a WAL-safe, single
# file, consistent copy (the same technique the core uses before its boot-time
# migration, see streamhub-core/src/shared/db/db.service.ts). We never tar a
# live .db directly (that can capture a torn WAL). The snapshots + secrets.json
# are tar+gzipped with a UTC timestamp, optionally uploaded to S3, and old
# copies (local and remote) past BACKUP_RETENTION_DAYS are pruned.
#
# Idempotent, safe to run from cron / a systemd timer. Config is 100% env vars:
#
#   BACKUP_DATA_DIR          host data dir to back up   (default /opt/streamhub/data)
#   BACKUP_LOCAL_DIR         where the tarball is kept  (default <DATA_DIR>/backups)
#   BACKUP_RETENTION_DAYS    prune copies older than N  (default 30)
#   BACKUP_S3_BUCKET         S3 bucket; empty = no upload (local backup only)
#   BACKUP_S3_ENDPOINT       S3-compatible endpoint URL (Wasabi/MinIO; optional)
#   BACKUP_S3_PREFIX         key prefix in the bucket   (default streamhub-backups)
#   BACKUP_S3_ACCESS_KEY_ID / BACKUP_S3_SECRET_ACCESS_KEY
#                            creds for the upload (fall back to ambient AWS_*)
#   BACKUP_S3_REGION         AWS region                 (default us-east-1)
#
# Exit codes: 0 ok · 1 usage · 2 preflight (missing dep/dir) · 3 snapshot failed
#             · 4 upload failed. Retention problems are logged as warnings only.
# =============================================================================
set -euo pipefail

# --- config ------------------------------------------------------------------
DATA_DIR="${BACKUP_DATA_DIR:-/opt/streamhub/data}"
LOCAL_DIR="${BACKUP_LOCAL_DIR:-${DATA_DIR}/backups}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"
S3_BUCKET="${BACKUP_S3_BUCKET:-}"
S3_ENDPOINT="${BACKUP_S3_ENDPOINT:-}"
S3_PREFIX="${BACKUP_S3_PREFIX:-streamhub-backups}"
S3_REGION="${BACKUP_S3_REGION:-us-east-1}"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
ARCHIVE_NAME="streamhub-backup-${STAMP}.tar.gz"

# --- logging -----------------------------------------------------------------
log()  { printf '[backup %s] %s\n'  "$(date -u +%H:%M:%S)" "$*"; }
warn() { printf '[backup %s] WARN: %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
die()  { printf '[backup %s] ERROR: %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; exit "${2:-1}"; }

usage() {
  sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

case "${1:-}" in
  -h|--help) usage 0 ;;
  "") : ;;
  *) die "unknown argument: $1 (this script takes no args; configure via env — see --help)" 1 ;;
esac

# --- staging + cleanup trap --------------------------------------------------
STAGING="$(mktemp -d "${TMPDIR:-/tmp}/streamhub-backup.XXXXXX")"
cleanup() { rm -rf "$STAGING"; }
trap cleanup EXIT

# --- preflight ---------------------------------------------------------------
command -v sqlite3 >/dev/null 2>&1 || die "sqlite3 not found (apt-get install sqlite3)" 2
command -v tar     >/dev/null 2>&1 || die "tar not found" 2
[ -d "$DATA_DIR" ] || die "DATA_DIR does not exist: $DATA_DIR (set BACKUP_DATA_DIR)" 2

USE_S3=0
if [ -n "$S3_BUCKET" ]; then
  command -v aws >/dev/null 2>&1 || die "BACKUP_S3_BUCKET set but aws CLI not found (pip install awscli)" 2
  USE_S3=1
fi

mkdir -p "$LOCAL_DIR" "$STAGING/data/apps"

log "starting backup of $DATA_DIR (stamp $STAMP)"

# --- snapshot one .db consistently -------------------------------------------
# VACUUM INTO gives a compacted, WAL-safe copy; fall back to the .backup API on
# older sqlite3 that lacks VACUUM INTO.
snapshot_db() {
  local src="$1" dst="$2"
  mkdir -p "$(dirname "$dst")"
  if sqlite3 "$src" "VACUUM INTO '$dst'" 2>/dev/null; then
    return 0
  fi
  warn "VACUUM INTO failed for $src, trying .backup"
  sqlite3 "$src" ".backup '$dst'"
}

# --- global DB ---------------------------------------------------------------
if [ -f "$DATA_DIR/streamhub.db" ]; then
  snapshot_db "$DATA_DIR/streamhub.db" "$STAGING/data/streamhub.db" \
    || die "failed to snapshot global streamhub.db" 3
  log "snapshotted streamhub.db"
else
  warn "no streamhub.db under $DATA_DIR — is this the right DATA_DIR?"
fi

# --- per-app DBs -------------------------------------------------------------
app_count=0
if [ -d "$DATA_DIR/apps" ]; then
  while IFS= read -r -d '' appdb; do
    rel="${appdb#"$DATA_DIR"/}"          # e.g. apps/live/app.db
    snapshot_db "$appdb" "$STAGING/data/$rel" \
      || die "failed to snapshot $rel" 3
    app_count=$((app_count + 1))
  done < <(find "$DATA_DIR/apps" -type f -name 'app.db' -print0)
fi
log "snapshotted $app_count per-app DB(s)"

# --- secrets.json (per-app S3 creds) — plain copy, preserve mode -------------
if [ -f "$DATA_DIR/secrets.json" ]; then
  cp -p "$DATA_DIR/secrets.json" "$STAGING/data/secrets.json"
  log "copied secrets.json"
else
  warn "no secrets.json under $DATA_DIR (ok if no per-app S3 configured)"
fi

# --- pack --------------------------------------------------------------------
ARCHIVE_PATH="$LOCAL_DIR/$ARCHIVE_NAME"
tar -czf "$ARCHIVE_PATH" -C "$STAGING" data
chmod 600 "$ARCHIVE_PATH"
SIZE="$(du -h "$ARCHIVE_PATH" | cut -f1)"
log "wrote $ARCHIVE_PATH ($SIZE)"

# --- upload to S3 ------------------------------------------------------------
if [ "$USE_S3" = "1" ]; then
  ep_args=()
  [ -n "$S3_ENDPOINT" ] && ep_args+=(--endpoint-url "$S3_ENDPOINT")
  # per-run creds override ambient AWS_* / instance role, if provided
  if [ -n "${BACKUP_S3_ACCESS_KEY_ID:-}" ]; then
    export AWS_ACCESS_KEY_ID="$BACKUP_S3_ACCESS_KEY_ID"
    export AWS_SECRET_ACCESS_KEY="${BACKUP_S3_SECRET_ACCESS_KEY:-}"
  fi
  export AWS_DEFAULT_REGION="$S3_REGION"
  S3_URI="s3://${S3_BUCKET}/${S3_PREFIX%/}/${ARCHIVE_NAME}"
  log "uploading to $S3_URI"
  aws "${ep_args[@]}" s3 cp "$ARCHIVE_PATH" "$S3_URI" \
    || die "S3 upload failed ($S3_URI)" 4
  log "uploaded to $S3_URI"
fi

# --- retention: local --------------------------------------------------------
# find -mtime +N = strictly older than N*24h; prune old tarballs, warn-only.
if find "$LOCAL_DIR" -maxdepth 1 -type f -name 'streamhub-backup-*.tar.gz' \
      -mtime "+${RETENTION_DAYS}" -print -delete 2>/dev/null | grep -q .; then
  log "pruned local backups older than ${RETENTION_DAYS} day(s)"
fi

# --- retention: remote -------------------------------------------------------
# Compare the UTC date embedded in each key (…-YYYYmmddT…) against a cutoff.
# Lexicographic compare of YYYYmmdd is chronological, so no per-file epoch math.
if [ "$USE_S3" = "1" ]; then
  if cutoff="$(date -u -d "${RETENTION_DAYS} days ago" +%Y%m%d 2>/dev/null)"; then
    pruned=0
    while IFS= read -r key; do
      [ -n "$key" ] || continue
      base="${key##*/}"                       # streamhub-backup-YYYYmmddT…tar.gz
      d="${base#streamhub-backup-}"; d="${d%%T*}"
      case "$d" in
        [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]) ;;
        *) continue ;;                          # unparseable name, leave it
      esac
      if [ "$d" -lt "$cutoff" ]; then
        if aws "${ep_args[@]}" s3 rm "s3://${S3_BUCKET}/${key}" >/dev/null; then
          pruned=$((pruned + 1))
        else
          warn "could not delete s3://${S3_BUCKET}/${key}"
        fi
      fi
    done < <(aws "${ep_args[@]}" s3api list-objects-v2 \
                 --bucket "$S3_BUCKET" --prefix "${S3_PREFIX%/}/" \
                 --query 'Contents[].Key' --output text 2>/dev/null | tr '\t' '\n')
    [ "$pruned" -gt 0 ] && log "pruned $pruned remote backup(s) older than ${RETENTION_DAYS} day(s)"
  else
    warn "could not compute retention cutoff (non-GNU date?); skipping remote prune"
  fi
fi

log "backup OK"
