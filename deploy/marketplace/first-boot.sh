#!/usr/bin/env bash
# =============================================================================
# StreamHub marketplace image — first-boot setup  (/opt/streamhub/first-boot.sh)
#
# Turns an image baked with `install.sh --prepare-image` (deps + source +
# pre-pulled images, NO secrets) into a running origin node: it gets the public
# domain + ACME email, then runs the installer over the baked source, which
# generates every secret into /opt/streamhub/.env (exactly the ones a normal
# install generates) and brings the stack up.
#
# Idempotent: once the setup succeeded it only prints the status; a failed or
# interrupted run is simply re-run (the installer keeps any .env it wrote).
#
# Where the values come from (first match wins):
#   1. flags                  --domain <fqdn|ip> --email <addr> [--proxy caddy|nginx]
#   2. environment            STREAMHUB_DOMAIN, STREAMHUB_ACME_EMAIL (or ACME_EMAIL),
#                             STREAMHUB_PROXY
#   3. /etc/streamhub/first-boot.env   KEY=value lines (e.g. cloud-config write_files)
#   4. cloud-init user-data   KEY=value / KEY: value lines anywhere in it
#                             (parsed as text, never executed by this script)
#   5. an interactive prompt  — the first SSH login as root runs this script
#                             (/etc/profile.d/streamhub-first-boot.sh)
# STREAMHUB_DOMAIN=ip means "use this server's public IP, plain HTTP, no TLS".
#
# Modes
#   (default)     interactive when a terminal is attached, else like --cloud-init
#   --cloud-init  run by streamhub-first-boot.service after cloud-final: never
#                 prompts; without a domain it leaves the setup PENDING (MOTD +
#                 login prompt take over)
#   --login       run from the login hook: interactive, can be postponed
#   --status      print the setup state and exit (also used by the MOTD)
#   --force       run the installer again even when the setup is done
# =============================================================================
set -euo pipefail

INSTALL_DIR="${STREAMHUB_DIR:-/opt/streamhub}"
STATE_DIR="${STREAMHUB_STATE_DIR:-/var/lib/streamhub}"
DONE_FILE="$STATE_DIR/first-boot.done"
RUN_FILE="$STATE_DIR/first-boot.running"
LOCK_FILE="$STATE_DIR/first-boot.lock"
CONF_FILE="${STREAMHUB_FIRST_BOOT_ENV:-/etc/streamhub/first-boot.env}"
LOG_FILE="${STREAMHUB_FIRST_BOOT_LOG:-/var/log/streamhub-first-boot.log}"
MARKER="$INSTALL_DIR/.image-prepared"
SELF="$INSTALL_DIR/first-boot.sh"

c_info='\033[1;36m'; c_ok='\033[1;32m'; c_warn='\033[1;33m'; c_err='\033[1;31m'; c_off='\033[0m'
log()  { printf "${c_info}[first-boot]${c_off} %s\n" "$*"; }
ok()   { printf "${c_ok}[first-boot]${c_off} %s\n" "$*"; }
warn() { printf "${c_warn}[first-boot]${c_off} %s\n" "$*"; }
die()  { printf "${c_err}[first-boot] ERROR:${c_off} %s\n" "$*" >&2; exit 1; }

MODE="auto"; FORCE=0
ARG_DOMAIN=""; ARG_EMAIL=""; ARG_PROXY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --domain)      ARG_DOMAIN="${2?$1 requires a value}"; shift 2 ;;
    --email)       ARG_EMAIL="${2?$1 requires a value}"; shift 2 ;;
    --proxy)       ARG_PROXY="${2?$1 requires a value}"; shift 2 ;;
    --cloud-init|--non-interactive) MODE="cloud-init"; shift ;;
    --login)       MODE="login"; shift ;;
    --status|--motd) MODE="status"; shift ;;
    --force)       FORCE=1; shift ;;
    -h|--help)     sed -n '2,36p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)             die "unknown flag: $1 (see --help)" ;;
  esac
done
if [ "$MODE" = "auto" ]; then
  if [ -t 0 ] && [ -t 1 ]; then MODE="interactive"; else MODE="cloud-init"; fi
fi
INTERACTIVE=0
case "$MODE" in interactive|login) [ -t 0 ] && [ -t 1 ] && INTERACTIVE=1 ;; esac

env_val() { # env_val KEY → value from $INSTALL_DIR/.env ('' if absent)
  { grep -E "^$1=" "$INSTALL_DIR/.env" 2>/dev/null | head -1 | cut -d= -f2- ; } || true
}
done_val() { # done_val KEY → value from the done file
  { sed -n "s/^$1=//p" "$DONE_FILE" 2>/dev/null | head -1 ; } || true
}

print_status() {
  if [ -f "$DONE_FILE" ]; then
    printf '  StreamHub %s is set up: %s\n' "$(head -1 "$INSTALL_DIR/VERSION" 2>/dev/null || echo '?')" "$(done_val URL)"
    printf '  Manage: streamhub status | logs -f | doctor | upgrade   ·   config: %s/.env\n' "$INSTALL_DIR"
    printf "  Credentials: sudo grep -E '^(ADMIN_USER|ADMIN_PASS|STREAMHUB_API_TOKEN)=' %s/.env\n" "$INSTALL_DIR"
  elif [ -f "$RUN_FILE" ]; then
    printf '  StreamHub setup is RUNNING (started %s).\n' "$(cat "$RUN_FILE" 2>/dev/null || echo '?')"
    printf '  Follow it: sudo tail -f %s\n' "$LOG_FILE"
  else
    printf '  StreamHub is NOT configured yet. Run:  sudo %s\n' "$SELF"
    printf '  (or launch the server with STREAMHUB_DOMAIN / STREAMHUB_ACME_EMAIL in its user-data)\n'
  fi
}

if [ "$MODE" = "status" ]; then print_status; exit 0; fi

[ "$(id -u)" = "0" ] || die "run as root:  sudo $SELF"
mkdir -p "$STATE_DIR"

# One run at a time (the cloud-init unit and a login can race): the loser just
# points at the log of the run in progress.
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  warn "a StreamHub setup run is already in progress — follow it: tail -f $LOG_FILE"
  exit 0
fi

if [ -f "$DONE_FILE" ] && [ "$FORCE" != "1" ]; then
  ok "already set up."
  print_status
  exit 0
fi
# Installed by hand (install.sh removed the image marker and wrote .env): adopt it.
if [ ! -f "$MARKER" ] && [ -s "$INSTALL_DIR/.env" ] && [ -s "$INSTALL_DIR/VERSION" ] && [ "$FORCE" != "1" ]; then
  d="$(env_val STREAMHUB_PUBLIC_URL)"
  printf 'URL=%s/\nDOMAIN=%s\nDATE=%s\nSOURCE=existing-install\n' "${d:-?}" "$(env_val STREAMHUB_DOMAIN)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$DONE_FILE"
  ok "an existing install was found in $INSTALL_DIR — marking the first-boot setup done."
  print_status
  exit 0
fi

# ---- gather the values ---------------------------------------------------------
# kv KEY... < text → the first value of any KEY, from `KEY=value`, `export
# KEY=value` or `KEY: value` lines (optionally quoted). Text only — nothing is
# sourced or evaluated, so a hostile user-data can't run code through here.
kv() {
  local text k v
  text="$(cat)"
  for k in "$@"; do
    v="$(printf '%s\n' "$text" \
      | sed -nE "s/^[[:space:]]*(-[[:space:]]+)?(export[[:space:]]+)?${k}[[:space:]]*[:=][[:space:]]*[\"']?([^\"'[:space:]#]+)[\"']?.*$/\3/p" \
      | head -1)"
    [ -n "$v" ] && { printf '%s' "$v"; return 0; }
  done
  return 0
}
user_data() {
  if command -v cloud-init >/dev/null 2>&1 && cloud-init query userdata 2>/dev/null; then return 0; fi
  cat /var/lib/cloud/instance/user-data.txt 2>/dev/null || true
}

DOMAIN="${ARG_DOMAIN:-${STREAMHUB_DOMAIN:-}}"
EMAIL="${ARG_EMAIL:-${STREAMHUB_ACME_EMAIL:-${ACME_EMAIL:-}}}"
PROXY="${ARG_PROXY:-${STREAMHUB_PROXY:-}}"
if [ -r "$CONF_FILE" ]; then
  [ -n "$DOMAIN" ] || DOMAIN="$(kv STREAMHUB_DOMAIN < "$CONF_FILE")"
  [ -n "$EMAIL" ]  || EMAIL="$(kv STREAMHUB_ACME_EMAIL ACME_EMAIL < "$CONF_FILE")"
  [ -n "$PROXY" ]  || PROXY="$(kv STREAMHUB_PROXY < "$CONF_FILE")"
fi
if [ -z "$DOMAIN" ] || [ -z "$EMAIL" ]; then
  UD="$(user_data | tr -d '\r' || true)"
  [ -n "$DOMAIN" ] || DOMAIN="$(printf '%s' "$UD" | kv STREAMHUB_DOMAIN)"
  [ -n "$EMAIL" ]  || EMAIL="$(printf '%s' "$UD" | kv STREAMHUB_ACME_EMAIL ACME_EMAIL)"
  [ -n "$PROXY" ]  || PROXY="$(printf '%s' "$UD" | kv STREAMHUB_PROXY)"
fi
[ -n "$PROXY" ] || PROXY="$({ sed -n 's/^STREAMHUB_IMAGE_PROXY=//p' "$MARKER" 2>/dev/null | head -1; } || true)"
[ -n "$PROXY" ] || PROXY="caddy"
case "$PROXY" in nginx|caddy) ;; *) die "proxy must be caddy or nginx (got '$PROXY')" ;; esac

public_ip() {
  local ip=""
  ip="$(curl -fsS -m5 https://api.ipify.org 2>/dev/null || true)"
  case "$ip" in *[!0-9.]*|'') ip="$(hostname -I 2>/dev/null | awk '{print $1}')" ;; esac
  printf '%s' "$ip"
}
valid_host()  { case "$1" in ''|*[!A-Za-z0-9.:-]*|-*|.*) return 1 ;; esac; [ "${#1}" -le 253 ]; }
valid_email() { printf '%s' "$1" | grep -Eq '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$'; }
is_ip() { case "$1" in *:*) return 0 ;; ''|*[!0-9.]*) return 1 ;; *.*.*.*) return 0 ;; *) return 1 ;; esac; }
resolve4() { getent ahostsv4 "$1" 2>/dev/null | awk 'NR==1{print $1}'; }

PUBIP=""
[ "$DOMAIN" = "ip" ] && { PUBIP="$(public_ip)"; DOMAIN="$PUBIP"; }

if [ -z "$DOMAIN" ] && [ "$INTERACTIVE" = "1" ]; then
  PUBIP="$(public_ip)"
  echo
  ok "Welcome to StreamHub — let's finish setting up this server (one time)."
  echo "  This server's public IP: ${PUBIP:-unknown}"
  echo "  Point a DNS A record for your domain at it (DNS only — no CDN proxy: WebRTC media is UDP)."
  echo
  while :; do
    read -r -p "Domain (e.g. media.example.com), 'ip' to use the bare IP without TLS, or 'later': " ans || ans="later"
    ans="$(printf '%s' "$ans" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')"
    case "$ans" in
      later|'') echo "OK — run  sudo $SELF  whenever you're ready."; exit 0 ;;
      ip) DOMAIN="$PUBIP"; break ;;
    esac
    valid_host "$ans" || { warn "'$ans' doesn't look like a hostname — try again."; continue; }
    if ! is_ip "$ans"; then
      res="$(resolve4 "$ans" || true)"
      if [ -n "$PUBIP" ] && [ "$res" != "$PUBIP" ]; then
        warn "$ans resolves to '${res:-nothing}', not to this server ($PUBIP)."
        warn "TLS issuance will fail until DNS points here (Caddy keeps retrying on its own; with nginx re-run the installer)."
        read -r -p "Continue anyway? [y/N] " yn || yn=""
        case "$yn" in y|Y|yes|YES) ;; *) continue ;; esac
      fi
    fi
    DOMAIN="$ans"; break
  done
  if [ -z "$EMAIL" ] && ! is_ip "$DOMAIN"; then
    while :; do
      read -r -p "Email for Let's Encrypt + admin contact [admin@$DOMAIN]: " EMAIL || EMAIL=""
      EMAIL="${EMAIL:-admin@$DOMAIN}"
      valid_email "$EMAIL" && break
      warn "'$EMAIL' doesn't look like an email address."; EMAIL=""
    done
  fi
  echo
  echo "  domain=$DOMAIN  email=${EMAIL:-<none>}  proxy=$PROXY  tls=$(is_ip "$DOMAIN" && echo off || echo on)"
  read -r -p "Install StreamHub with these settings? [Y/n] " yn || yn="n"
  case "$yn" in n|N|no|NO) echo "Nothing changed — run  sudo $SELF  again when ready."; exit 0 ;; esac
fi

if [ -z "$DOMAIN" ]; then
  log "no STREAMHUB_DOMAIN in flags/env/$CONF_FILE/user-data — setup left PENDING."
  log "it will be asked on the first SSH login as root (or run: sudo $SELF)."
  exit 0
fi
valid_host "$DOMAIN" || die "invalid domain '$DOMAIN'"
if [ -n "$EMAIL" ]; then valid_email "$EMAIL" || die "invalid email '$EMAIL'"; fi
if [ -z "$EMAIL" ] && ! is_ip "$DOMAIN"; then EMAIL="admin@$DOMAIN"; fi

# ---- run the installer over the baked source -----------------------------------
# The image's installer copy (/usr/local/lib/streamhub/install.sh) is the one the
# image was prepared with; the source tree's copy is the fallback.
INSTALLER="${STREAMHUB_INSTALLER:-}"
for cand in "$INSTALLER" /usr/local/lib/streamhub/install.sh "$INSTALL_DIR/install.sh"; do
  [ -n "$cand" ] && [ -r "$cand" ] && { INSTALLER="$cand"; break; }
done
[ -r "$INSTALLER" ] || die "installer not found (looked in /usr/local/lib/streamhub and $INSTALL_DIR)"

date -u +%Y-%m-%dT%H:%M:%SZ > "$RUN_FILE"
trap 'rm -f "$RUN_FILE"' EXIT
touch "$LOG_FILE"; chmod 600 "$LOG_FILE"

args=(--non-interactive --proxy "$PROXY" --domain "$DOMAIN")
[ -n "$EMAIL" ] && args+=(--email "$EMAIL")
log "installing StreamHub: domain=$DOMAIN proxy=$PROXY (log: $LOG_FILE)"
# --non-interactive: every value is decided above, and the installer then
# redacts secrets from its output (this log stays credential-free).
rc=0
if [ "$INTERACTIVE" = "1" ]; then
  STREAMHUB_DIR="$INSTALL_DIR" ADMIN_USER="${ADMIN_USER:-admin}" \
    bash "$INSTALLER" "${args[@]}" 2>&1 | tee -a "$LOG_FILE" || rc=$?   # pipefail: the installer's rc
else
  STREAMHUB_DIR="$INSTALL_DIR" ADMIN_USER="${ADMIN_USER:-admin}" \
    bash "$INSTALLER" "${args[@]}" || rc=$?
fi
if [ "$rc" != "0" ]; then
  warn "the installer failed (exit $rc) — see $LOG_FILE and $INSTALL_DIR/logs/install.log."
  warn "fix the cause (DNS, ports, disk) and re-run:  sudo $SELF"
  exit "$rc"
fi

URL="$(env_val STREAMHUB_PUBLIC_URL)"
( umask 022; printf 'URL=%s/\nDOMAIN=%s\nPROXY=%s\nDATE=%s\nSOURCE=%s\n' \
    "${URL:-?}" "$DOMAIN" "$PROXY" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$MODE" > "$DONE_FILE" )
echo
ok "StreamHub is up: ${URL:-?}/"
if [ "$INTERACTIVE" = "1" ]; then
  # Shown on the operator's terminal only — never written to a log.
  echo "  Dashboard login : $(env_val ADMIN_USER) / $(env_val ADMIN_PASS)"
  echo "  API token       : $(env_val STREAMHUB_API_TOKEN)   (Authorization: Bearer …)"
  echo "  These live in $INSTALL_DIR/.env (mode 600). Store them somewhere safe."
else
  echo "  Credentials: sudo grep -E '^(ADMIN_USER|ADMIN_PASS|STREAMHUB_API_TOKEN)=' $INSTALL_DIR/.env"
fi
