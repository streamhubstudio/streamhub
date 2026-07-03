#!/usr/bin/env bash
# =============================================================================
# StreamHub — restore a backup produced by deploy/backup.sh.
# -----------------------------------------------------------------------------
# Fetches a backup (from S3 or a local dir), verifies it, and restores it into a
# target DATA_DIR — with an explicit confirmation so you can't wipe prod by
# accident, and after snapshotting whatever is currently in the target so the
# restore is itself reversible.
#
#   deploy/restore.sh --list                 # show available backups and exit
#   deploy/restore.sh                         # restore the LATEST backup
#   deploy/restore.sh --from 20260701T031500Z # restore a specific backup
#   deploy/restore.sh --from /path/x.tar.gz  # restore an explicit local file
#   deploy/restore.sh --target /opt/streamhub-core/data --yes   # non-interactive
#
# Flags:
#   --from <timestamp|latest|FILE>  which backup (default: latest)
#   --target <dir>                  DATA_DIR to restore into (default env/opt)
#   --source <s3|local>             where to fetch from (default: s3 if a bucket
#                                   is configured, else local)
#   --list                          list available backups, then exit
#   --yes                           skip the interactive confirmation
#
# Uses the same env vars as backup.sh (BACKUP_S3_BUCKET / _ENDPOINT / _PREFIX /
# _REGION / _ACCESS_KEY_ID / _SECRET_ACCESS_KEY, BACKUP_LOCAL_DIR,
# BACKUP_DATA_DIR). IMPORTANT: stop the core (docker compose stop core, or
# systemctl stop streamhub-core) before restoring — writing DBs under a live core
# is unsafe.
#
# Exit codes: 0 ok · 1 usage · 2 preflight · 3 not found · 4 verify failed
#             · 5 aborted by user.
# =============================================================================
set -euo pipefail

# --- config / defaults -------------------------------------------------------
TARGET_DIR="${BACKUP_DATA_DIR:-/opt/streamhub/data}"
LOCAL_DIR="${BACKUP_LOCAL_DIR:-${TARGET_DIR}/backups}"
S3_BUCKET="${BACKUP_S3_BUCKET:-}"
S3_ENDPOINT="${BACKUP_S3_ENDPOINT:-}"
S3_PREFIX="${BACKUP_S3_PREFIX:-streamhub-backups}"
S3_REGION="${BACKUP_S3_REGION:-us-east-1}"

FROM="latest"
SOURCE=""
DO_LIST=0
ASSUME_YES=0

log()  { printf '[restore %s] %s\n'  "$(date -u +%H:%M:%S)" "$*"; }
warn() { printf '[restore %s] WARN: %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
die()  { printf '[restore %s] ERROR: %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; exit "${2:-1}"; }

# --- args --------------------------------------------------------------------
while [ $# -gt 0 ]; do
  case "$1" in
    --from)   FROM="${2:-}"; shift 2 ;;
    --target) TARGET_DIR="${2:-}"; shift 2 ;;
    --source) SOURCE="${2:-}"; shift 2 ;;
    --list)   DO_LIST=1; shift ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    -h|--help) sed -n '2,45p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument: $1 (see --help)" 1 ;;
  esac
done

# default source: S3 when a bucket is configured, else local
if [ -z "$SOURCE" ]; then
  if [ -n "$S3_BUCKET" ]; then SOURCE="s3"; else SOURCE="local"; fi
fi
case "$SOURCE" in s3|local) ;; *) die "--source must be s3 or local" 1 ;; esac

# --- preflight ---------------------------------------------------------------
command -v sqlite3 >/dev/null 2>&1 || die "sqlite3 not found" 2
command -v tar     >/dev/null 2>&1 || die "tar not found" 2

aws_args=()
if [ "$SOURCE" = "s3" ]; then
  command -v aws >/dev/null 2>&1 || die "--source s3 but aws CLI not found" 2
  [ -n "$S3_BUCKET" ] || die "--source s3 but BACKUP_S3_BUCKET is empty" 1
  [ -n "$S3_ENDPOINT" ] && aws_args+=(--endpoint-url "$S3_ENDPOINT")
  if [ -n "${BACKUP_S3_ACCESS_KEY_ID:-}" ]; then
    export AWS_ACCESS_KEY_ID="$BACKUP_S3_ACCESS_KEY_ID"
    export AWS_SECRET_ACCESS_KEY="${BACKUP_S3_SECRET_ACCESS_KEY:-}"
  fi
  export AWS_DEFAULT_REGION="$S3_REGION"
fi

# --- list backup keys/paths (newest last) ------------------------------------
list_backups() {
  if [ "$SOURCE" = "s3" ]; then
    aws "${aws_args[@]}" s3api list-objects-v2 \
      --bucket "$S3_BUCKET" --prefix "${S3_PREFIX%/}/" \
      --query 'Contents[].Key' --output text 2>/dev/null \
      | tr '\t' '\n' | grep -E 'streamhub-backup-.*\.tar\.gz$' | sort || true
  else
    find "$LOCAL_DIR" -maxdepth 1 -type f -name 'streamhub-backup-*.tar.gz' 2>/dev/null | sort || true
  fi
}

if [ "$DO_LIST" = "1" ]; then
  log "available backups ($SOURCE):"
  n=0
  while IFS= read -r b; do [ -n "$b" ] && { printf '  %s\n' "$b"; n=$((n + 1)); }; done < <(list_backups)
  [ "$n" = 0 ] && log "  (none found)"
  exit 0
fi

# --- resolve which backup to restore -----------------------------------------
STAGING="$(mktemp -d "${TMPDIR:-/tmp}/streamhub-restore.XXXXXX")"
trap 'rm -rf "$STAGING"' EXIT

ARCHIVE=""   # local path to the tar.gz once fetched

# explicit local file wins
if [ -f "$FROM" ]; then
  ARCHIVE="$FROM"
  log "using explicit archive $ARCHIVE"
else
  # pick the key/path from the listing
  chosen=""
  if [ "$FROM" = "latest" ]; then
    chosen="$(list_backups | tail -1)"
  else
    chosen="$(list_backups | grep -F "$FROM" | tail -1 || true)"
  fi
  [ -n "$chosen" ] || die "no backup matching '$FROM' found in $SOURCE" 3

  if [ "$SOURCE" = "s3" ]; then
    ARCHIVE="$STAGING/$(basename "$chosen")"
    log "downloading s3://${S3_BUCKET}/${chosen}"
    aws "${aws_args[@]}" s3 cp "s3://${S3_BUCKET}/${chosen}" "$ARCHIVE" >/dev/null \
      || die "download failed" 3
  else
    ARCHIVE="$chosen"
  fi
  log "selected backup $(basename "$ARCHIVE")"
fi

# --- extract + verify --------------------------------------------------------
EXTRACT="$STAGING/extract"
mkdir -p "$EXTRACT"
tar -xzf "$ARCHIVE" -C "$EXTRACT" || die "failed to extract $ARCHIVE" 4
[ -f "$EXTRACT/data/streamhub.db" ] || die "archive has no data/streamhub.db — not a StreamHub backup?" 4

log "verifying integrity of DBs in the archive"
verify_fail=0
while IFS= read -r -d '' db; do
  res="$(sqlite3 "$db" 'PRAGMA integrity_check;' 2>/dev/null | head -1 || true)"
  if [ "$res" = "ok" ]; then
    log "  ok: ${db#"$EXTRACT"/}"
  else
    warn "  integrity_check FAILED: ${db#"$EXTRACT"/} -> ${res:-<no output>}"
    verify_fail=1
  fi
done < <(find "$EXTRACT/data" -type f -name '*.db' -print0)
[ "$verify_fail" = "0" ] || die "one or more DBs failed integrity_check; aborting" 4

# --- confirm -----------------------------------------------------------------
log "about to restore into TARGET: $TARGET_DIR"
warn "this OVERWRITES streamhub.db, apps/*/app.db and secrets.json in the target."
warn "make sure the core is STOPPED first (docker compose stop core | systemctl stop streamhub-core)."
if [ "$ASSUME_YES" != "1" ]; then
  if [ ! -t 0 ]; then die "refusing to restore without a TTY; pass --yes to force" 5; fi
  printf 'Type the target path (%s) to confirm: ' "$TARGET_DIR"
  read -r reply
  [ "$reply" = "$TARGET_DIR" ] || die "confirmation did not match; aborted" 5
fi

# --- snapshot current target (reversible restore) ----------------------------
mkdir -p "$TARGET_DIR"
if [ -f "$TARGET_DIR/streamhub.db" ] || [ -d "$TARGET_DIR/apps" ]; then
  PRE="$TARGET_DIR/pre-restore-$(date -u +%Y%m%dT%H%M%SZ)"
  mkdir -p "$PRE"
  [ -f "$TARGET_DIR/streamhub.db" ] && cp -p "$TARGET_DIR/streamhub.db" "$PRE/" || true
  [ -f "$TARGET_DIR/secrets.json" ] && cp -p "$TARGET_DIR/secrets.json" "$PRE/" || true
  if [ -d "$TARGET_DIR/apps" ]; then
    ( cd "$TARGET_DIR" && find apps -name 'app.db' -print0 \
        | while IFS= read -r -d '' f; do mkdir -p "$PRE/$(dirname "$f")"; cp -p "$f" "$PRE/$f"; done )
  fi
  log "snapshotted current target into $PRE"
fi

# --- apply -------------------------------------------------------------------
cp -p "$EXTRACT/data/streamhub.db" "$TARGET_DIR/streamhub.db"
log "restored streamhub.db"

restored_apps=0
if [ -d "$EXTRACT/data/apps" ]; then
  while IFS= read -r -d '' f; do
    rel="${f#"$EXTRACT"/data/}"           # apps/<app>/app.db
    mkdir -p "$TARGET_DIR/$(dirname "$rel")"
    cp -p "$f" "$TARGET_DIR/$rel"
    restored_apps=$((restored_apps + 1))
  done < <(find "$EXTRACT/data/apps" -type f -name 'app.db' -print0)
fi
log "restored $restored_apps per-app DB(s)"

if [ -f "$EXTRACT/data/secrets.json" ]; then
  cp -p "$EXTRACT/data/secrets.json" "$TARGET_DIR/secrets.json"
  chmod 600 "$TARGET_DIR/secrets.json"
  log "restored secrets.json"
fi

log "restore OK — now start the core and confirm /api/v1/health"
