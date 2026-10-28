#!/usr/bin/env bash
# =============================================================================
# StreamHub — safe plain-server deploy of the core (systemd, no Docker).
# -----------------------------------------------------------------------------
# The secure replacement for the old deploy-streamhub.sh (which hardcoded
# secrets — gitignored, never commit it). This script NEVER takes secrets on the
# command line and NEVER writes them: it assumes the host .env already exists in
# APP_DIR and leaves it untouched. It ships a new core build and restarts:
#
#   1. sanity-check APP_DIR + its .env (must already exist — no secret creation)
#   2. back up the DBs + secrets via deploy/backup.sh (abort if that fails)
#   3. unpack the core bundle (deploy/make-core-bundle.sh) into a staging dir,
#      verify the binary checksum, then swap it in: streamhub-core (atomic
#      rename), web/, plugins-vendor/, VERSION; publish the
#      browser SDK into <DATA_DIR>/sdk. .env, data/, apps/, logs/ are never
#      touched.
#   3b. provision the Python worker runtime (mirrors deploy/Dockerfile): a venv
#      at <APP_DIR>/venv + the pip deps of the selected decoupled apps
#      (WORKER_DEPS) — CPU torch first when a selected app needs it, and
#      opencv-python-headless forced to win over ultralytics' opencv-python
#      (the GUI build needs libGL, absent on servers). Idempotent: the venv is
#      reused and pip only re-runs when the selection or a requirements.txt
#      changes. A pip failure warns but never aborts the core deploy.
#   4. point the systemd unit at the Go binary via a drop-in
#      (/etc/systemd/system/<service>.service.d/10-go-core.conf) — idempotent,
#      and it converts a 2.x Node unit (`node dist/main.js`) in place: same
#      User, same EnvironmentFile, same DATA_DIR (the Go core opens the 2.x
#      SQLite schema as-is). The old dist/ + node_modules/ are left in place, so
#      rolling back = delete the drop-in + daemon-reload + restart. When the
#      venv exists it also sets PLUGIN_PYTHON=<APP_DIR>/venv/bin/python.
#   5. systemctl restart the service, then wait for /api/v1/health
#
# Usage:
#   deploy/deploy-core.sh <streamhub-core-<ver>-linux-amd64.tar.gz>
#   CORE_TARBALL=/tmp/core.tgz deploy/deploy-core.sh
#   APP_DIR=/opt/skyline-core SERVICE_NAME=skyline deploy/deploy-core.sh core.tgz
#
# Build the bundle with:  deploy/make-core-bundle.sh   (→ dist/streamhub-core-*.tar.gz)
#
# Flags:  --tarball FILE   same as the positional arg / CORE_TARBALL
#         --skip-backup    skip step 2 (NOT recommended)
#         --no-restart     do everything except the systemctl restart
#         --no-unit        don't write the systemd drop-in (unit managed elsewhere)
#         --worker-deps L  same as WORKER_DEPS
#         --no-venv        skip step 3b (no venv; an existing one stays in use)
#
# Env:  APP_DIR (default /opt/skyline-core) · SERVICE_NAME (default skyline)
#       BACKUP_DATA_DIR (default: the .env DATA_DIR, else APP_DIR) · PORT (default: .env PORT, else 3020)
#       WORKER_DEPS — which vendored apps get their worker pip deps: a comma
#         list of app ids ("deface,people-counter"), "all", or "0" (venv only,
#         no app deps). Default "deface", like the image's
#         INSTALL_VENDORED_WORKER_DEPS (torch-based apps are ~1GB+, opt-in).
#
# Exit codes: 0 ok · 1 usage · 2 preflight · 3 backup failed · 4 install failed
#             · 5 service/health failed.
# =============================================================================
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/skyline-core}"
SERVICE_NAME="${SERVICE_NAME:-skyline}"
CORE_TARBALL="${CORE_TARBALL:-}"
SKIP_BACKUP=0
NO_RESTART=0
NO_UNIT=0
NO_VENV=0
WORKER_DEPS="${WORKER_DEPS:-deface}"

log()  { printf '[deploy %s] %s\n'  "$(date -u +%H:%M:%S)" "$*"; }
warn() { printf '[deploy %s] WARN: %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
die()  { printf '[deploy %s] ERROR: %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; exit "${2:-1}"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --tarball)     CORE_TARBALL="${2:-}"; shift 2 ;;
    --skip-backup) SKIP_BACKUP=1; shift ;;
    --no-restart)  NO_RESTART=1; shift ;;
    --no-unit)     NO_UNIT=1; shift ;;
    --worker-deps) WORKER_DEPS="${2:-}"; shift 2 ;;
    --no-venv)     NO_VENV=1; shift ;;
    -h|--help) sed -n '2,64p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) die "unknown flag: $1 (see --help)" 1 ;;
    *) CORE_TARBALL="$1"; shift ;;
  esac
done

# where THIS script lives, so we can call its sibling backup.sh
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# value of KEY in APP_DIR/.env (last wins, surrounding quotes stripped)
env_get() {
  grep -E "^$1=" "$APP_DIR/.env" 2>/dev/null | tail -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//"
}

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}';
  else shasum -a 256 "$1" | awk '{print $1}'; fi
}

# --- 1. preflight ------------------------------------------------------------
[ -n "$CORE_TARBALL" ] || die "no tarball given (pass a path or set CORE_TARBALL)" 1
[ -f "$CORE_TARBALL" ] || die "tarball not found: $CORE_TARBALL" 2
if [ "$NO_RESTART" = "0" ] || [ "$NO_UNIT" = "0" ]; then
  command -v systemctl >/dev/null 2>&1 || die "systemctl not found (this path is for systemd hosts; --no-unit --no-restart to only install files)" 2
fi
[ -d "$APP_DIR" ] || die "APP_DIR does not exist: $APP_DIR" 2

if [ ! -f "$APP_DIR/.env" ]; then
  die "no .env in $APP_DIR — this script does not create secrets. Run install.sh for first-time setup, or place a filled .env there first." 2
fi
PORT="${PORT:-$(env_get PORT)}"
PORT="${PORT:-3020}"
DATA_DIR="$(env_get DATA_DIR)"
DATA_DIR="${DATA_DIR:-$APP_DIR}"   # the core's default DATA_DIR is its working dir
log "APP_DIR=$APP_DIR SERVICE_NAME=$SERVICE_NAME DATA_DIR=$DATA_DIR (reusing existing .env)"

# --- 2. backup ---------------------------------------------------------------
if [ "$SKIP_BACKUP" = "0" ]; then
  export BACKUP_DATA_DIR="${BACKUP_DATA_DIR:-$DATA_DIR}"   # the core's DATA_DIR (from .env)
  if [ -x "$SCRIPT_DIR/backup.sh" ]; then
    log "backing up before deploy (BACKUP_DATA_DIR=$BACKUP_DATA_DIR)"
    "$SCRIPT_DIR/backup.sh" || die "pre-deploy backup failed — aborting (override with --skip-backup)" 3
  else
    warn "backup.sh not executable/found next to this script; skipping backup"
  fi
else
  warn "--skip-backup: no pre-deploy backup taken"
fi

# --- 3. unpack + verify + swap in ---------------------------------------------
STAGE="$(mktemp -d "$APP_DIR/.deploy-XXXXXX")"   # same filesystem → atomic renames
trap 'rm -rf "$STAGE"' EXIT
log "unpacking $CORE_TARBALL"
tar -xzf "$CORE_TARBALL" -C "$STAGE" || die "failed to extract $CORE_TARBALL" 4
[ -f "$STAGE/streamhub-core" ] || die "bundle has no streamhub-core binary — build it with deploy/make-core-bundle.sh" 4
if [ -f "$STAGE/streamhub-core.sha256" ]; then
  want="$(awk '{print $1}' "$STAGE/streamhub-core.sha256")"
  [ "$(sha256 "$STAGE/streamhub-core")" = "$want" ] || die "streamhub-core checksum mismatch — corrupt bundle" 4
fi
chmod 755 "$STAGE/streamhub-core"
"$STAGE/streamhub-core" version >/dev/null 2>&1 || die "the new binary does not run on this host (wrong arch?)" 4

# owner of the app dir (the service user) keeps owning what we install
OWNER="$(stat -c '%u:%g' "$APP_DIR" 2>/dev/null || stat -f '%u:%g' "$APP_DIR")"

# directories: replace wholesale (rename-swap, old copy removed after)
for d in web plugins-vendor adaptor-dist; do
  [ -d "$STAGE/$d" ] || continue
  rm -rf "$APP_DIR/.$d.old"
  [ -e "$APP_DIR/$d" ] && mv "$APP_DIR/$d" "$APP_DIR/.$d.old"
  mv "$STAGE/$d" "$APP_DIR/$d"
  rm -rf "$APP_DIR/.$d.old"
done
for f in VERSION LICENSE; do
  [ -f "$STAGE/$f" ] && mv -f "$STAGE/$f" "$APP_DIR/$f"
done
mv -f "$STAGE/streamhub-core" "$APP_DIR/streamhub-core"   # atomic: the running process keeps its inode
chown -R "$OWNER" "$APP_DIR/streamhub-core" "$APP_DIR/web" "$APP_DIR/plugins-vendor" \
  "$APP_DIR/adaptor-dist" "$APP_DIR/VERSION" 2>/dev/null || true
# The stream-health worker is now the core's own `health-worker`
# subcommand: drop the Node worker an older bundle installed.
if [ -d "$APP_DIR/health-worker" ]; then
  rm -rf "$APP_DIR/health-worker"
  log "removed the old Node health-worker/ (now built into streamhub-core)"
fi

# publish the browser SDK where /sdk/* is served from (<DATA_DIR>/sdk)
if [ -d "$APP_DIR/adaptor-dist" ]; then
  mkdir -p "$DATA_DIR/sdk"
  cp -f "$APP_DIR"/adaptor-dist/*.global.js "$DATA_DIR/sdk/" 2>/dev/null || true
  chown -R "$OWNER" "$DATA_DIR/sdk" 2>/dev/null || true
fi
log "installed core $("$APP_DIR/streamhub-core" version)"

# --- 3b. Python worker runtime (venv + vendored app deps) ----------------------
# needsWorker apps spawn `$PLUGIN_PYTHON -m <worker>`; without this the system
# python3 is used and every decoupled app dies on `import cv2`.
VENV="$APP_DIR/venv"
VENV_OK=0
provision_venv() {
  command -v python3 >/dev/null 2>&1 || { warn "python3 not found — skipping the worker venv (decoupled apps cannot run)"; return 0; }
  if ! python3 -c 'import venv, ensurepip' >/dev/null 2>&1 && command -v apt-get >/dev/null 2>&1; then
    log "installing python3-venv"
    apt-get install -y -qq python3-venv >/dev/null 2>&1 || warn "could not install python3-venv"
  fi
  if [ ! -x "$VENV/bin/python" ]; then
    python3 -m venv "$VENV" || { warn "could not create $VENV — skipping the worker venv"; return 0; }
    log "worker venv created: $VENV"
  fi
  VENV_OK=1
  local py="$VENV/bin/python" plog="$APP_DIR/logs/worker-venv-pip.log"
  mkdir -p "$APP_DIR/logs"

  # selected requirements files, in app-id order (the image's glob order)
  local reqs=() req id
  if [ "$WORKER_DEPS" != "0" ]; then
    for req in "$APP_DIR"/plugins-vendor/*/worker/requirements.txt; do
      [ -f "$req" ] || continue
      id="$(basename "$(dirname "$(dirname "$req")")")"
      case ",$WORKER_DEPS," in *,all,*|*",$id,"*) reqs+=("$req") ;; esac
    done
  fi
  # skip pip when nothing changed since the last successful run
  local stamp="$VENV/.streamhub-worker-deps" want
  want="$( { echo "sel=$WORKER_DEPS py=$("$py" -V 2>&1)"; for req in "${reqs[@]+"${reqs[@]}"}"; do echo "$req $(sha256 "$req")"; done; } > "$VENV/.stamp.tmp"; sha256 "$VENV/.stamp.tmp"; rm -f "$VENV/.stamp.tmp")"
  if [ -f "$stamp" ] && [ "$(cat "$stamp")" = "$want" ]; then
    log "worker venv up to date (WORKER_DEPS=$WORKER_DEPS)"
    return 0
  fi
  if [ "${#reqs[@]}" -gt 0 ]; then
    log "installing worker deps for: $(for r in "${reqs[@]}"; do basename "$(dirname "$(dirname "$r")")"; done | paste -sd, -) (log: $plog)"
  fi
  : > "$plog"
  "$py" -m pip install --upgrade pip >>"$plog" 2>&1 || true
  local failed=0
  # CPU torch FIRST (CPU index) when a selected app pulls it in (ultralytics),
  # so pip doesn't resolve the multi-GB CUDA build as a transitive dependency.
  if [ "${#reqs[@]}" -gt 0 ] && grep -qiE '^[[:space:]]*(ultralytics|torch)' "${reqs[@]}"; then
    "$py" -m pip install --no-input torch torchvision --index-url https://download.pytorch.org/whl/cpu >>"$plog" 2>&1 \
      || { warn "CPU torch install failed (see $plog)"; failed=1; }
  fi
  for req in "${reqs[@]+"${reqs[@]}"}"; do
    "$py" -m pip install --no-input -r "$req" >>"$plog" 2>&1 \
      || { warn "pip failed for $req (see $plog)"; failed=1; }
  done
  # ultralytics depends on the GUI opencv-python, which shares the cv2 package
  # with opencv-python-headless and needs libGL: drop it and make headless win.
  if "$py" -m pip show opencv-python >/dev/null 2>&1; then
    log "replacing opencv-python with opencv-python-headless"
    "$py" -m pip uninstall -y opencv-python >>"$plog" 2>&1 || true
    "$py" -m pip install --no-input --force-reinstall --no-deps opencv-python-headless >>"$plog" 2>&1 \
      || { warn "could not reinstall opencv-python-headless (see $plog)"; failed=1; }
  fi
  if [ "$failed" = "0" ]; then
    echo "$want" > "$stamp"
    log "worker venv ready (WORKER_DEPS=$WORKER_DEPS)"
  else
    warn "worker deps incomplete — the core deploy continues; re-run once pip/egress works"
  fi
}
if [ "$NO_VENV" = "0" ]; then
  provision_venv
  if [ -d "$VENV" ]; then chown -R "$OWNER" "$VENV" "$APP_DIR/logs" 2>/dev/null || true; fi
else
  if [ -x "$VENV/bin/python" ]; then VENV_OK=1; fi   # keep pointing at an existing venv
  log "--no-venv: skipping the worker venv"
fi

# --- 4. systemd drop-in → the Go binary ----------------------------------------
if [ "$NO_UNIT" = "0" ]; then
  DROPIN_DIR="/etc/systemd/system/$SERVICE_NAME.service.d"
  DROPIN="$DROPIN_DIR/10-go-core.conf"
  TMP="$(mktemp)"
  cat > "$TMP" <<EOF
# Written by deploy/deploy-core.sh — runs the Go core (3.x) instead of the
# Node core. Remove this file + daemon-reload to roll back to a 2.x unit.
[Service]
WorkingDirectory=$APP_DIR
ExecStart=
ExecStart=$APP_DIR/streamhub-core
UMask=0002
EOF
  if [ "$VENV_OK" = "1" ]; then echo "Environment=PLUGIN_PYTHON=$VENV/bin/python" >> "$TMP"; fi
  if ! cmp -s "$TMP" "$DROPIN" 2>/dev/null; then
    mkdir -p "$DROPIN_DIR"
    install -m 644 "$TMP" "$DROPIN" || die "cannot write $DROPIN (run as root, or --no-unit)" 4
    systemctl daemon-reload
    log "systemd drop-in written: $DROPIN"
  fi
  rm -f "$TMP"
elif [ "$VENV_OK" = "1" ]; then
  log "--no-unit: set PLUGIN_PYTHON=$VENV/bin/python in the service environment yourself"
fi

# --- 5. restart + health -----------------------------------------------------
if [ "$NO_RESTART" = "1" ]; then
  log "--no-restart: skipping systemctl restart. Done (installed only)."
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
