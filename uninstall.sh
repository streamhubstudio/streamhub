#!/usr/bin/env bash
# =============================================================================
# StreamHub node uninstaller — companion to install.sh. Tears a node down so
# you can re-test the one-liner installer as many times as needed.
#
#   curl -fsSL https://www.streamhub.studio/uninstall.sh | sudo bash            # interactive
#   curl -fsSL https://www.streamhub.studio/uninstall.sh | sudo bash -s -- --yes
#   curl -fsSL https://www.streamhub.studio/uninstall.sh | sudo bash -s -- --yes --purge
#
# Default (safe for repeat tests): stops + removes the docker stack (containers
# + named volumes), deletes the install dir (/opt/streamhub incl. its data),
# and removes the installer's logs + sysctl drop-in. It KEEPS docker itself,
# nginx + its server block, the ufw rules, and — importantly — the Let's
# Encrypt certificate (LE rate-limits ~5 certs/week/domain; keeping it lets the
# next install reuse it instead of re-issuing). Re-running install.sh after this
# is a clean rebuild that reuses the cert.
#
# Flags:
#   --dir <path>     Install dir to remove (default /opt/streamhub).
#   --keep-data      Keep <dir>/data (recordings/HLS/db) — remove only the code.
#   --purge          Also prune docker images + build cache (truly fresh rebuild
#                    next time), remove the nginx server block + sysctl drop-in.
#   --purge-tls      Also `certbot delete` the domain cert (only when you really
#                    want it gone — costs a re-issue against LE rate limits).
#   --domain <fqdn>  Domain for nginx-site / cert removal (else read from .env).
#   --yes | -y       Don't prompt (non-interactive).
#   --help
#
# Target OS: Ubuntu 24.04/26.04 LTS x86_64 (same as install.sh). Idempotent:
# safe to run when nothing (or only part) is installed.
# =============================================================================
set -euo pipefail

INSTALL_DIR="${STREAMHUB_DIR:-/opt/streamhub}"
KEEP_DATA=0
PURGE=0
PURGE_TLS=0
ASSUME_YES="${STREAMHUB_UNINSTALL_YES:-0}"
DOMAIN_OVERRIDE=""

c_info='\033[1;36m'; c_ok='\033[1;32m'; c_warn='\033[1;33m'; c_err='\033[1;31m'; c_off='\033[0m'
log()  { printf "${c_info}[uninstall]${c_off} %s\n" "$*"; }
ok()   { printf "${c_ok}[uninstall]${c_off} %s\n" "$*"; }
warn() { printf "${c_warn}[uninstall]${c_off} %s\n" "$*"; }
die()  { printf "${c_err}[uninstall] ERROR:${c_off} %s\n" "$*" >&2; exit 1; }

usage() { sed -n '2,40p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//' ; exit 0; }

while [ $# -gt 0 ]; do
  case "$1" in
    --dir)        INSTALL_DIR="${2?--dir requires a value}"; shift 2 ;;
    --keep-data)  KEEP_DATA=1; shift ;;
    --purge)      PURGE=1; shift ;;
    --purge-tls)  PURGE_TLS=1; shift ;;
    --domain)     DOMAIN_OVERRIDE="${2?--domain requires a value}"; shift 2 ;;
    -y|--yes)     ASSUME_YES=1; shift ;;
    -h|--help)    usage ;;
    *)            die "unknown flag: $1 (see --help)" ;;
  esac
done

[ "$(id -u)" = "0" ] || die "run as root:  curl -fsSL https://www.streamhub.studio/uninstall.sh | sudo bash"

# Resolve the domain (for nginx site / cert) from .env when not overridden.
DOMAIN="$DOMAIN_OVERRIDE"
if [ -z "$DOMAIN" ] && [ -f "$INSTALL_DIR/.env" ]; then
  DOMAIN="$(grep -E '^STREAMHUB_DOMAIN=' "$INSTALL_DIR/.env" 2>/dev/null | head -1 | cut -d= -f2- || true)"
fi

echo
warn "About to REMOVE StreamHub from this machine:"
echo "  install dir : $INSTALL_DIR  (data: $([ "$KEEP_DATA" = 1 ] && echo KEPT || echo removed))"
echo "  docker stack: containers + named volumes  $([ "$PURGE" = 1 ] && echo '+ images + build cache' || echo '(images kept)')"
echo "  nginx site  : $([ "$PURGE" = 1 ] && echo "removed ($DOMAIN)" || echo 'kept')"
echo "  TLS cert    : $([ "$PURGE_TLS" = 1 ] && echo "DELETED ($DOMAIN)" || echo 'kept (reused on reinstall)')"
echo "  docker/nginx/ufw packages: kept"
echo
if [ "$ASSUME_YES" != "1" ]; then
  if [ -r /dev/tty ]; then
    read -r -p "Proceed? [y/N] " ans < /dev/tty || true
    case "${ans:-}" in y|Y|yes|YES) ;; *) die "aborted." ;; esac
  else
    die "no TTY — pass --yes to confirm non-interactively."
  fi
fi

# ---- 1. docker stack --------------------------------------------------------
if command -v docker >/dev/null 2>&1; then
  if [ -f "$INSTALL_DIR/docker-compose.yml" ]; then
    log "stopping + removing the docker stack (containers + named volumes)"
    DOWN_ARGS="down -v --remove-orphans"
    [ "$PURGE" = 1 ] && DOWN_ARGS="down -v --remove-orphans --rmi all"
    # shellcheck disable=SC2086
    docker compose --project-directory "$INSTALL_DIR" -f "$INSTALL_DIR/docker-compose.yml" $DOWN_ARGS 2>/dev/null \
      || warn "compose down reported an issue (continuing)"
  fi
  # Belt-and-suspenders: kill any lingering streamhub-named containers.
  LINGER="$(docker ps -aq --filter 'name=streamhub' 2>/dev/null || true)"
  [ -n "$LINGER" ] && { log "removing lingering streamhub containers"; docker rm -f $LINGER >/dev/null 2>&1 || true; }
  if [ "$PURGE" = 1 ]; then
    log "pruning docker build cache + dangling images (fresh rebuild next time)"
    docker builder prune -af >/dev/null 2>&1 || true
    docker image prune -af  >/dev/null 2>&1 || true
  fi
else
  warn "docker not present — skipping stack teardown"
fi

# ---- 2. install dir ---------------------------------------------------------
if [ -d "$INSTALL_DIR" ]; then
  if [ "$KEEP_DATA" = 1 ] && [ -d "$INSTALL_DIR/data" ]; then
    log "removing $INSTALL_DIR (keeping data/)"
    find "$INSTALL_DIR" -mindepth 1 -maxdepth 1 ! -name data -exec rm -rf {} + 2>/dev/null || true
  else
    log "removing $INSTALL_DIR"
    rm -rf "$INSTALL_DIR"
  fi
fi

# ---- 3. nginx site (only with --purge) --------------------------------------
if [ "$PURGE" = 1 ] && [ -n "$DOMAIN" ] && [ "$DOMAIN" != "localhost" ] && command -v nginx >/dev/null 2>&1; then
  if [ -f "/etc/nginx/sites-available/$DOMAIN" ] || [ -L "/etc/nginx/sites-enabled/$DOMAIN" ]; then
    log "removing nginx server block for $DOMAIN"
    rm -f "/etc/nginx/sites-enabled/$DOMAIN" "/etc/nginx/sites-available/$DOMAIN"
    nginx -t >/dev/null 2>&1 && systemctl reload nginx >/dev/null 2>&1 || warn "nginx reload skipped"
  fi
fi

# ---- 4. TLS cert (only with --purge-tls) ------------------------------------
if [ "$PURGE_TLS" = 1 ] && [ -n "$DOMAIN" ] && [ "$DOMAIN" != "localhost" ] && command -v certbot >/dev/null 2>&1; then
  if [ -d "/etc/letsencrypt/live/$DOMAIN" ]; then
    warn "deleting Let's Encrypt cert for $DOMAIN (re-issue counts against LE rate limits)"
    certbot delete --cert-name "$DOMAIN" --non-interactive 2>/dev/null || warn "certbot delete failed"
  fi
fi

# ---- 5. installer leftovers -------------------------------------------------
rm -f /var/log/streamhub-install.log /var/log/streamhub-regen.log /root/sh-run.sh /root/regen.sh 2>/dev/null || true
if [ "$PURGE" = 1 ]; then
  log "removing sysctl WebRTC drop-in"
  rm -f /etc/sysctl.d/99-streamhub-webrtc.conf 2>/dev/null || true
fi

echo
ok "============================================================"
ok "StreamHub removed from this node."
echo "  Kept: docker + nginx + ufw packages$([ "$PURGE_TLS" = 1 ] && echo '' || echo " + TLS cert for ${DOMAIN:-<none>}")"
[ "$PURGE" = 1 ] || echo "  (docker images/cache kept — add --purge for a fully fresh rebuild)"
echo "  Reinstall: curl -fsSL https://www.streamhub.studio/install.sh | sudo bash"
ok "============================================================"
