#!/usr/bin/env bash
# =============================================================================
# StreamHub node installer — self-hosted LiveKit media server, one-liner.
#
#   curl -fsSL https://www.streamhub.studio/install.sh | sudo bash
#   curl -fsSL https://www.streamhub.studio/install.sh | sudo bash -s -- \
#       --non-interactive --domain media.example.com --email you@example.com
#
#   Join an existing cluster as an edge/media node (day-1):
#   curl -fsSL https://www.streamhub.studio/install.sh | sudo bash -s -- \
#       --join --cluster-token <token> --origin-ip <ip> [--origin-url https://app.example.com]
#
# Target OS: Ubuntu Server 24.04 LTS or 26.04 LTS, x86_64 ONLY (validated, aborts
# otherwise). Idempotent: safe to re-run — it keeps your .env secrets, updates the
# code, and restarts services. `--help` lists every flag; every flag also has a
# STREAMHUB_* env-var equivalent so `--non-interactive` runs need no TTY at all.
#
# What a full (origin) install provisions:
#   docker + compose plugin, the StreamHub repo in /opt/streamhub, a .env with
#   strong random secrets, the whole stack (redis + livekit + ingress + egress +
#   core), nginx + certbot TLS on your domain (or --proxy caddy for auto-TLS),
#   the seeded sk_ API token, and a cluster token so edges can join later.
# =============================================================================

# ---- POSIX prologue: `| sudo sh` lands here under dash — re-exec under bash.
# (stdin is already consumed by the pipe, so we re-download from the canonical
# URL; if that's impossible, tell the user to pipe to bash instead.)
if [ -z "${BASH_VERSION:-}" ]; then
  SELF_URL="${STREAMHUB_INSTALL_URL:-https://www.streamhub.studio/install.sh}"
  if command -v bash >/dev/null 2>&1; then
    case "$0" in *install*.sh) [ -f "$0" ] && exec bash "$0" "$@" ;; esac
    if command -v curl >/dev/null 2>&1; then
      _body="$(curl -fsSL "$SELF_URL")" && [ -n "$_body" ] && exec bash -c "$_body" bash "$@"
    fi
  fi
  echo "streamhub-install: please run with bash: curl -fsSL $SELF_URL | sudo bash" >&2
  exit 1
fi

set -euo pipefail

VERSION="2.0.0"
REPO_URL="${STREAMHUB_REPO_URL:-https://github.com/streamhubstudio/streamhub.git}"
INSTALL_DIR="${STREAMHUB_DIR:-/opt/streamhub}"
SELF_URL="${STREAMHUB_INSTALL_URL:-https://www.streamhub.studio/install.sh}"

c_info='\033[1;36m'; c_ok='\033[1;32m'; c_warn='\033[1;33m'; c_err='\033[1;31m'; c_off='\033[0m'
log()  { printf "${c_info}[streamhub]${c_off} %s\n" "$*"; }
ok()   { printf "${c_ok}[streamhub]${c_off} %s\n" "$*"; }
warn() { printf "${c_warn}[streamhub]${c_off} %s\n" "$*"; }
die()  { printf "${c_err}[streamhub] ERROR:${c_off} %s\n" "$*" >&2; exit 1; }
rand() { openssl rand -base64 96 | tr -dc 'A-Za-z0-9' | head -c "${1:-40}"; }

usage() {
  cat <<'USAGE'
StreamHub node installer — Ubuntu 24.04/26.04 LTS x86_64.

  curl -fsSL https://www.streamhub.studio/install.sh | sudo bash [-s -- FLAGS]

Modes
  --standalone           Day-0: full StreamHub master/standalone node (DEFAULT).
  --join                 Day-1: media/edge node registered on an existing master
                         VIA ITS API (needs --master-token and --master-ip; the
                         LiveKit keys/redis flow back in the join response — no
                         manual key sharing).
  --dry-run              Validate OS/ports/flags and print the plan; change nothing.

Origin flags (all optional; prompted unless --non-interactive)
  --domain <fqdn>        Public domain (DNS A record must point here). Empty = localhost test mode.
  --email <email>        Let's Encrypt/ACME + admin contact email.
  --admin-user <u>       Break-glass dashboard user            (default: admin)
  --admin-pass <p>       Break-glass dashboard password        (default: generated)
  --superadmin-email <e> Email whose magic-link login is superadmin.
  --smtp-host <h> --smtp-port <p> --smtp-user <u> --smtp-pass <p> --smtp-from <f>
                         SMTP for magic-link/reset emails (optional but recommended).
  --proxy nginx|caddy    TLS/reverse proxy. nginx+certbot (default) or the compose
                         Caddy service (auto-TLS, no host packages).
  --no-tls               Skip certbot (e.g. behind your own proxy/LB).
  --cluster-redis-bind <ip>
                         Prepare this origin for edges: also bind Redis on <ip>
                         (a PRIVATE address), protect it with a generated password
                         and advertise redis://:<pass>@<ip>:6379 to joining nodes.
                         Then allow each edge manually: ufw allow from <edge-ip> to any port 6379.

Join flags
  --master-token <t>     Cluster join token of the master (printed by its install;
                         lives in its .env as STREAMHUB_CLUSTER_TOKEN). Alias: --cluster-token.
  --master-ip <ip>       Master's IP — edges share its Redis (redis://<ip>:6379). Alias: --origin-ip.
  --master-url <url>     Master's API base for registration + webhooks (e.g.
                         https://app.example.com; default http://<master-ip>:3020). Alias: --origin-url.
  --node-name <name>     This node's name in the registry (default: hostname).
  --region <region>      Optional region label for the registry.

General
  --dir <path>           Install dir (default /opt/streamhub).
  --non-interactive      Never prompt; missing values = generated or defaults.
  --version | --help

Every flag has an env equivalent: STREAMHUB_DOMAIN, ACME_EMAIL, ADMIN_USER,
ADMIN_PASS, STREAMHUB_SUPERADMIN_EMAIL, STREAMHUB_SMTP_{HOST,PORT,USER,PASS,FROM},
STREAMHUB_PROXY, STREAMHUB_NO_TLS, STREAMHUB_CLUSTER_REDIS_BIND, STREAMHUB_JOIN,
STREAMHUB_MASTER_TOKEN, STREAMHUB_MASTER_IP, STREAMHUB_MASTER_URL (o los legacy
STREAMHUB_CLUSTER_TOKEN/ORIGIN_IP/ORIGIN_URL), STREAMHUB_NODE_NAME,
STREAMHUB_REGION, STREAMHUB_DIR, STREAMHUB_NON_INTERACTIVE=1.
Re-runs: flags/env update their .env keys; generated secrets are never rotated.
USAGE
}

# ---- flags ------------------------------------------------------------------
MODE="origin"
DRY_RUN=0
NONINTERACTIVE="${STREAMHUB_NON_INTERACTIVE:-0}"
PROXY="${STREAMHUB_PROXY:-nginx}"
NO_TLS="${STREAMHUB_NO_TLS:-0}"
JOIN="${STREAMHUB_JOIN:-0}"
CLUSTER_TOKEN="${STREAMHUB_MASTER_TOKEN:-${STREAMHUB_CLUSTER_TOKEN:-}}"
ORIGIN_IP="${STREAMHUB_MASTER_IP:-${STREAMHUB_ORIGIN_IP:-}}"
ORIGIN_URL="${STREAMHUB_MASTER_URL:-${STREAMHUB_ORIGIN_URL:-}}"
NODE_NAME="${STREAMHUB_NODE_NAME:-$(hostname -s 2>/dev/null || echo node)}"
REGION="${STREAMHUB_REGION:-}"
CLUSTER_REDIS_BIND="${STREAMHUB_CLUSTER_REDIS_BIND:-}"

while [ $# -gt 0 ]; do
  case "$1" in
    --domain)            STREAMHUB_DOMAIN="${2?$1 requires a value}"; shift 2 ;;
    --email)             ACME_EMAIL="${2?$1 requires a value}"; shift 2 ;;
    --admin-user)        ADMIN_USER="${2?$1 requires a value}"; shift 2 ;;
    --admin-pass)        ADMIN_PASS="${2?$1 requires a value}"; shift 2 ;;
    --superadmin-email)  STREAMHUB_SUPERADMIN_EMAIL="${2?$1 requires a value}"; shift 2 ;;
    --smtp-host)         STREAMHUB_SMTP_HOST="${2?$1 requires a value}"; shift 2 ;;
    --smtp-port)         STREAMHUB_SMTP_PORT="${2?$1 requires a value}"; shift 2 ;;
    --smtp-user)         STREAMHUB_SMTP_USER="${2?$1 requires a value}"; shift 2 ;;
    --smtp-pass)         STREAMHUB_SMTP_PASS="${2?$1 requires a value}"; shift 2 ;;
    --smtp-from)         STREAMHUB_SMTP_FROM="${2?$1 requires a value}"; shift 2 ;;
    --proxy)             PROXY="${2?$1 requires a value}"; shift 2 ;;
    --cluster-redis-bind) CLUSTER_REDIS_BIND="${2?$1 requires a value}"; shift 2 ;;
    --no-tls)            NO_TLS=1; shift ;;
    --standalone)        JOIN=0; MODE="origin"; shift ;;
    --join)              JOIN=1; MODE="join"; shift ;;
    --master-token|--cluster-token) CLUSTER_TOKEN="${2?$1 requires a value}"; shift 2 ;;
    --master-ip|--origin-ip)        ORIGIN_IP="${2?$1 requires a value}"; shift 2 ;;
    --master-url|--origin-url)      ORIGIN_URL="${2?$1 requires a value}"; shift 2 ;;
    --node-name)         NODE_NAME="${2?$1 requires a value}"; shift 2 ;;
    --region)            REGION="${2?$1 requires a value}"; shift 2 ;;
    --dir)               INSTALL_DIR="${2?$1 requires a value}"; shift 2 ;;
    --non-interactive)   NONINTERACTIVE=1; shift ;;
    --dry-run)           DRY_RUN=1; shift ;;
    --version)           echo "streamhub-install $VERSION"; exit 0 ;;
    -h|--help)           usage; exit 0 ;;
    *)                   die "unknown flag: $1 (see --help)" ;;
  esac
done
[ "$JOIN" = "1" ] && MODE="join"
case "$PROXY" in nginx|caddy) ;; *) die "--proxy must be nginx or caddy" ;; esac

# ---- 0. root + OS gate ------------------------------------------------------
[ "$(id -u)" = "0" ] || die "run as root:  curl -fsSL $SELF_URL | sudo bash"

if [ "${STREAMHUB_SKIP_OS_CHECK:-0}" != "1" ]; then
  ARCH="$(uname -m)"
  [ "$ARCH" = "x86_64" ] || die "unsupported architecture '$ARCH' — StreamHub targets x86_64 (amd64) only."
  [ -r /etc/os-release ] || die "cannot read /etc/os-release — unsupported OS. Target: Ubuntu 24.04/26.04 LTS x64."
  # shellcheck disable=SC1091
  . /etc/os-release
  if [ "${ID:-}" != "ubuntu" ]; then
    die "unsupported OS '${PRETTY_NAME:-unknown}' — StreamHub supports Ubuntu Server 24.04 LTS and 26.04 LTS (x64)."
  fi
  case "${VERSION_ID:-}" in
    24.04|26.04) ok "OS check: Ubuntu ${VERSION_ID} LTS x86_64" ;;
    *) die "unsupported Ubuntu ${VERSION_ID:-?} — supported: 24.04 LTS and 26.04 LTS. (STREAMHUB_SKIP_OS_CHECK=1 overrides at your own risk.)" ;;
  esac
else
  warn "STREAMHUB_SKIP_OS_CHECK=1 — skipping the OS gate (unsupported territory)."
fi

export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a

# ---- 1. port preflight ------------------------------------------------------
# Ubuntu Server ships iproute2 (ss); minimal containers/chroots may not.
if ! command -v ss >/dev/null 2>&1; then
  apt-get update -qq >/dev/null 2>&1 || true
  apt-get install -y -qq iproute2 >/dev/null 2>&1 || true
fi
command -v ss >/dev/null 2>&1 || warn "ss unavailable — skipping the port preflight"
# A port is OK if free OR already held by us (re-run): docker-proxy/containers,
# nginx, or caddy. Anything else aborts with the offending process named.
check_port() { # check_port <port> <proto>
  local p="$1" proto="${2:-tcp}" owner
  if [ "$proto" = "udp" ]; then owner=$(ss -Hlnpu "( sport = :$p )" 2>/dev/null | awk 'NR==1{print $NF}')
  else owner=$(ss -Hlnpt "( sport = :$p )" 2>/dev/null | awk 'NR==1{print $NF}'); fi
  [ -z "$owner" ] && return 0
  case "$owner" in
    *docker*|*nginx*|*caddy*|*livekit*|*ingress*|*egress*|*redis*|*node*) return 0 ;;  # ours on re-run
    *) echo "$owner"; return 1 ;;
  esac
}
PORTS_TCP="1935 7880 7881 8080"
PORTS_UDP="7882"
if [ "$MODE" = "origin" ]; then PORTS_TCP="80 443 3020 6379 $PORTS_TCP"; fi
PORT_FAIL=0
for p in $PORTS_TCP; do
  if ! o=$(check_port "$p" tcp); then warn "port $p/tcp is busy: $o"; PORT_FAIL=1; fi
done
for p in $PORTS_UDP; do
  if ! o=$(check_port "$p" udp); then warn "port $p/udp is busy: $o"; PORT_FAIL=1; fi
done
[ "$PORT_FAIL" = "1" ] && die "free the ports above (or stop the services holding them) and re-run."
ok "port preflight passed"

if [ "$DRY_RUN" = "1" ]; then
  ok "dry-run: OS + ports OK. Plan: mode=$MODE proxy=$PROXY dir=$INSTALL_DIR domain=${STREAMHUB_DOMAIN:-<ask>} tls=$([ "$NO_TLS" = 1 ] && echo off || echo on)"
  exit 0
fi

# ---- 2. dependencies (idempotent) -------------------------------------------
log "installing dependencies (apt)"
apt-get update -qq
apt-get install -y -qq ca-certificates curl git openssl python3 >/dev/null

if ! command -v docker >/dev/null 2>&1; then
  log "installing Docker (get.docker.com)"
  curl -fsSL https://get.docker.com | sh
else
  ok "docker already installed: $(docker --version)"
fi
# docker-compose-plugin lives in Docker's repo; Ubuntu's own archive (docker.io
# preinstalled images) ships it as docker-compose-v2 — try both.
docker compose version >/dev/null 2>&1 || {
  log "installing the docker compose plugin"
  apt-get install -y -qq docker-compose-plugin >/dev/null 2>&1 \
    || apt-get install -y -qq docker-compose-v2 >/dev/null 2>&1 \
    || die "could not install a docker compose plugin (tried docker-compose-plugin, docker-compose-v2)"
}
systemctl enable --now docker >/dev/null 2>&1 || true

if [ "$MODE" = "origin" ] && [ "$PROXY" = "nginx" ]; then
  if ! command -v nginx >/dev/null 2>&1; then
    log "installing nginx + certbot"
    apt-get install -y -qq nginx certbot python3-certbot-nginx >/dev/null
  else
    ok "nginx already installed"
    command -v certbot >/dev/null 2>&1 || apt-get install -y -qq certbot python3-certbot-nginx >/dev/null
  fi
fi

# Kernel UDP buffers: LiveKit recommends >=16MB for WebRTC under load (default
# 4MB drops packets when several publishers/subscribers saturate the socket).
if [ "$(sysctl -n net.core.rmem_max 2>/dev/null || echo 0)" -lt 16777216 ]; then
  log "raising kernel UDP buffers to 16MB (net.core.rmem_max/wmem_max)"
  printf 'net.core.rmem_max=16777216\nnet.core.wmem_max=16777216\n' > /etc/sysctl.d/99-streamhub-webrtc.conf
  sysctl -p /etc/sysctl.d/99-streamhub-webrtc.conf >/dev/null || warn "sysctl apply failed — check /etc/sysctl.d/99-streamhub-webrtc.conf"
fi

# ufw: open ONLY the public-facing ports (never 3020/6379 — those stay
# loopback/private; cluster redis access is a manual allow-from rule, see docs)
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  log "ufw active — allowing StreamHub public ports"
  PORTS_TCP_UFW="1935 7880 7881 8080"
  [ "$MODE" = "origin" ] && PORTS_TCP_UFW="80 443 $PORTS_TCP_UFW"
  for p in $PORTS_TCP_UFW; do ufw allow "$p/tcp" >/dev/null || true; done
  for p in $PORTS_UDP; do ufw allow "$p/udp" >/dev/null || true; done
fi

# ---- 3. source ----------------------------------------------------------------
# git clone is the fast path (public repo / configured credentials); the hosted
# tarball is the fallback so the one-liner works even while the repo is private.
# GIT_TERMINAL_PROMPT=0: a private repo must fail fast, never hang on a prompt.
SRC_URL="${STREAMHUB_SRC_URL:-https://www.streamhub.studio/streamhub-src.tar.gz}"
fetch_tarball() {
  log "downloading StreamHub source ($SRC_URL)"
  mkdir -p "$INSTALL_DIR"
  curl -fsSL -m180 "$SRC_URL" -o /tmp/streamhub-src.tgz || return 1
  tar xzf /tmp/streamhub-src.tgz -C "$INSTALL_DIR" && rm -f /tmp/streamhub-src.tgz
}
if [ -d "$INSTALL_DIR/.git" ]; then
  log "updating existing checkout in $INSTALL_DIR"
  GIT_TERMINAL_PROMPT=0 git -C "$INSTALL_DIR" pull --ff-only \
    || warn "git pull failed — continuing with the current checkout"
elif [ -f "$INSTALL_DIR/docker-compose.yml" ]; then
  log "refreshing $INSTALL_DIR from the source tarball (tarball install)"
  fetch_tarball || warn "tarball refresh failed — continuing with the current copy"
else
  log "fetching StreamHub into $INSTALL_DIR"
  if ! GIT_TERMINAL_PROMPT=0 git clone --depth 1 "$REPO_URL" "$INSTALL_DIR" 2>/dev/null; then
    fetch_tarball || die "could not fetch the StreamHub source (git: $REPO_URL, tarball: $SRC_URL)"
  fi
fi
cd "$INSTALL_DIR"
[ -f docker-compose.yml ] || die "source fetch incomplete — docker-compose.yml missing in $INSTALL_DIR"

# ---- 4. configuration (.env: reuse existing values, fill the gaps) ----------
# Never overwrites a value that's already in .env — re-running keeps secrets.
# || true: a grep miss must NOT kill the script under pipefail (fresh .env).
env_get() { { grep -E "^$1=" .env 2>/dev/null | head -1 | cut -d= -f2- ; } || true ; }
env_put() { # env_put KEY VALUE  (fill-if-missing — generated secrets never rotate)
  grep -qE "^$1=" .env 2>/dev/null || printf '%s=%s\n' "$1" "$2" >> .env
}
env_set() { # env_set KEY VALUE  (replace-or-append — operator-provided values win)
  if grep -qE "^$1=" .env 2>/dev/null; then
    { grep -vE "^$1=" .env > .env.tmp || true; }
    printf '%s=%s\n' "$1" "$2" >> .env.tmp && mv .env.tmp .env
  else
    printf '%s=%s\n' "$1" "$2" >> .env
  fi
}
TTY_DEV=/dev/tty
ask() { # ask VAR "Prompt" "default"   (no-op if var already set or non-interactive)
  local __var="$1" __prompt="$2" __default="${3:-}" __ans=""
  [ -n "${!__var:-}" ] && return 0
  if [ "$NONINTERACTIVE" = "1" ] || [ ! -r "$TTY_DEV" ]; then printf -v "$__var" '%s' "$__default"; return 0; fi
  read -r -p "$__prompt " __ans < "$TTY_DEV" || true
  printf -v "$__var" '%s' "${__ans:-$__default}"
}

umask 077
touch .env

if [ "$MODE" = "origin" ]; then
  # pull anything a previous run already decided
  STREAMHUB_DOMAIN="${STREAMHUB_DOMAIN:-$(env_get STREAMHUB_DOMAIN)}"
  ADMIN_USER="${ADMIN_USER:-$(env_get ADMIN_USER)}"
  ADMIN_PASS="${ADMIN_PASS:-$(env_get ADMIN_PASS)}"
  ACME_EMAIL="${ACME_EMAIL:-$(env_get ACME_EMAIL)}"

  ask STREAMHUB_DOMAIN "Public domain (blank = localhost test install):" "localhost"
  [ "$STREAMHUB_DOMAIN" = "localhost" ] || ask ACME_EMAIL "Email for Let's Encrypt [admin@$STREAMHUB_DOMAIN]:" "admin@$STREAMHUB_DOMAIN"
  ask ADMIN_USER "Admin username [admin]:" "admin"
  [ -n "${ADMIN_PASS:-}" ] || ADMIN_PASS="$(rand 20)"
  : "${ACME_EMAIL:=admin@example.com}"

  if [ "$STREAMHUB_DOMAIN" = "localhost" ]; then
    PUBLIC_WS_URL="ws://127.0.0.1:7880"; RTMP_PUBLIC_HOST="127.0.0.1"; PUBLIC_URL="http://127.0.0.1:3020"
  else
    PUBLIC_WS_URL="wss://$STREAMHUB_DOMAIN"; RTMP_PUBLIC_HOST="$STREAMHUB_DOMAIN"; PUBLIC_URL="https://$STREAMHUB_DOMAIN"
  fi

  # env_set = operator-provided/derived values (flags win on re-run);
  # env_put = generated secrets (NEVER rotated by a re-run).
  env_set STREAMHUB_DOMAIN        "$STREAMHUB_DOMAIN"
  env_set ACME_EMAIL              "$ACME_EMAIL"
  env_put LIVEKIT_API_KEY         "API$(rand 12)"
  env_put LIVEKIT_API_SECRET      "$(rand 48)"
  env_put HOST                    "127.0.0.1"
  env_put PORT                    "3020"
  env_put LIVEKIT_URL             "ws://127.0.0.1:7880"
  env_set PUBLIC_WS_URL           "$PUBLIC_WS_URL"
  env_set RTMP_PUBLIC_HOST        "$RTMP_PUBLIC_HOST"
  env_put STREAMHUB_JWT_SECRET    "$(rand 48)"
  env_set ADMIN_USER              "$ADMIN_USER"
  env_set ADMIN_PASS              "$ADMIN_PASS"
  env_put STREAMHUB_API_TOKEN     "sk_$(rand 43)"
  env_put METRICS_TOKEN           "mtk_$(rand 28)"
  env_put STREAMHUB_AUTHZ_ENFORCE "log"
  env_set STREAMHUB_PUBLIC_URL    "$PUBLIC_URL"
  env_set STREAMHUB_APP_URL       "$PUBLIC_URL"
  env_put STREAMHUB_CLUSTER_TOKEN "clt_$(rand 32)"
  env_put DATA_DIR                "/data"
  env_put STREAMHUB_HOST_DATA_DIR "./data"
  env_put LOG_LEVEL               "info"
  env_put NODE_ENV                "production"
  if [ -n "${STREAMHUB_SUPERADMIN_EMAIL:-}" ]; then
    env_set STREAMHUB_SUPERADMIN_EMAIL "$STREAMHUB_SUPERADMIN_EMAIL"
  fi
  if [ -n "${STREAMHUB_SMTP_HOST:-}" ]; then
    env_set STREAMHUB_SMTP_HOST "$STREAMHUB_SMTP_HOST"
    env_set STREAMHUB_SMTP_PORT "${STREAMHUB_SMTP_PORT:-587}"
    [ -n "${STREAMHUB_SMTP_USER:-}" ] && env_set STREAMHUB_SMTP_USER "$STREAMHUB_SMTP_USER"
    [ -n "${STREAMHUB_SMTP_PASS:-}" ] && env_set STREAMHUB_SMTP_PASS "$STREAMHUB_SMTP_PASS"
    env_set STREAMHUB_SMTP_FROM "${STREAMHUB_SMTP_FROM:-StreamHub <no-reply@$STREAMHUB_DOMAIN>}"
  fi

  # Cluster-ready origin: also bind redis on a PRIVATE ip, password-protect it,
  # and advertise that URL to joining edges (cluster/join hands it out).
  if [ -n "$CLUSTER_REDIS_BIND" ]; then
    env_put REDIS_PASSWORD "$(rand 32)"
    RP="$(env_get REDIS_PASSWORD)"
    env_set REDIS_BIND                 "127.0.0.1 $CLUSTER_REDIS_BIND"
    env_set LIVEKIT_REDIS_PASSWORD     "$RP"
    env_set REDIS_URL                  "redis://:$RP@127.0.0.1:6379"
    env_set STREAMHUB_CLUSTER_REDIS_URL "redis://:$RP@$CLUSTER_REDIS_BIND:6379"
    warn "redis will also listen on $CLUSTER_REDIS_BIND:6379 (password-protected)."
    warn "allow each edge explicitly, e.g.: ufw allow from <edge-ip> to any port 6379 proto tcp"
  else
    env_put REDIS_URL "redis://127.0.0.1:6379"
  fi
  ok ".env ready (existing values preserved; flags update their keys)"

else # ---- join mode config ---------------------------------------------------
  [ -n "$CLUSTER_TOKEN" ] || die "--join needs --cluster-token (see the origin's install summary or its .env STREAMHUB_CLUSTER_TOKEN)"
  [ -n "$ORIGIN_IP" ]     || die "--join needs --origin-ip <ip-of-origin>"
  API_BASE="${ORIGIN_URL:-http://$ORIGIN_IP:3020}"

  # Re-run guard: a fully-configured edge must survive an origin that is down
  # or a rotated token — re-register when we can, keep working when we can't.
  ALREADY_JOINED=0
  if [ -n "$(env_get LIVEKIT_API_KEY)" ] && [ -n "$(env_get LIVEKIT_REDIS_ADDRESS)" ]; then
    ALREADY_JOINED=1
  fi

  log "registering node '$NODE_NAME' on the origin ($API_BASE)"
  MY_IP="$(curl -fsS -m5 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')"
  JOIN_BODY=$(printf '{"name":"%s","ip":"%s","region":"%s"}' "$NODE_NAME" "$MY_IP" "$REGION")
  JOIN_OK=1
  JOIN_RESP=$(curl -fsS -m15 -X POST "$API_BASE/api/v1/cluster/join" \
      -H "Content-Type: application/json" -H "X-Cluster-Token: $CLUSTER_TOKEN" \
      -d "$JOIN_BODY" 2>&1) || JOIN_OK=0
  if [ "$JOIN_OK" = "0" ]; then
    if [ "$ALREADY_JOINED" = "1" ]; then
      warn "cluster join call failed ($API_BASE) — node was already joined, reusing the existing .env. Response: $JOIN_RESP"
    else
      die "cluster join failed against $API_BASE — check --cluster-token/--origin-url. Response: $JOIN_RESP"
    fi
  else
    jget() { printf '%s' "$JOIN_RESP" | python3 -c "import sys,json;d=json.load(sys.stdin).get('data',{});v=d$1;print(v if v is not None else '')" 2>/dev/null || true; }
    LK_KEY="$(jget "['livekit']['apiKey']")"
    LK_SECRET="$(jget "['livekit']['apiSecret']")"
    REDIS_FROM_ORIGIN="$(jget "['redisUrl']")"
    NODE_ID="$(jget "['nodeId']")"
    if [ -z "$LK_KEY" ] || [ -z "$LK_SECRET" ]; then
      [ "$ALREADY_JOINED" = "1" ] || die "origin did not return LiveKit keys — is its core up to date? Response: $JOIN_RESP"
      warn "origin did not return LiveKit keys — keeping the existing ones"
    else
      ok "registered as node '$NODE_NAME' (id: ${NODE_ID:-?})"
      REDIS_URL_VAL="${REDIS_FROM_ORIGIN:-redis://$ORIGIN_IP:6379}"
      # split redis://[:pass@]host:port into address + optional password
      REDIS_STRIPPED="${REDIS_URL_VAL#redis://}"
      REDIS_PASS_PART=""
      REDIS_ADDR_PART="$REDIS_STRIPPED"
      case "$REDIS_STRIPPED" in
        *@*) REDIS_PASS_PART="${REDIS_STRIPPED%%@*}"; REDIS_PASS_PART="${REDIS_PASS_PART#:}"
             REDIS_ADDR_PART="${REDIS_STRIPPED##*@}" ;;
      esac
      # env_set: a successful (re-)join always wins — rotated keys are honored
      env_set LIVEKIT_API_KEY        "$LK_KEY"
      env_set LIVEKIT_API_SECRET     "$LK_SECRET"
      env_set REDIS_URL              "$REDIS_URL_VAL"
      env_set LIVEKIT_REDIS_ADDRESS  "$REDIS_ADDR_PART"
      env_set LIVEKIT_REDIS_PASSWORD "$REDIS_PASS_PART"
      # room events must reach the ORIGIN's core (no core runs on an edge)
      env_set LIVEKIT_WEBHOOK_URL    "$API_BASE/api/v1/webhooks/livekit"
    fi
  fi

  env_put DATA_DIR           "/data"
  env_put STREAMHUB_HOST_DATA_DIR "./data"
  env_put STREAMHUB_DOMAIN   "join-$NODE_NAME"
  env_put ACME_EMAIL         "none@localhost"
  ok ".env ready (edge node — shares the origin's Redis at $(env_get LIVEKIT_REDIS_ADDRESS))"
fi

DATA_HOST_DIR="$(env_get STREAMHUB_HOST_DATA_DIR)"
mkdir -p "${DATA_HOST_DIR:-./data}"

# ---- 5. start services -------------------------------------------------------
if [ "$MODE" = "origin" ]; then
  if [ "$PROXY" = "caddy" ]; then
    log "building + starting the full stack (with Caddy auto-TLS)"
    docker compose up -d --build
  else
    log "building + starting the stack (redis livekit ingress egress core — nginx fronts it)"
    docker compose up -d --build redis livekit ingress egress core
  fi

  log "waiting for streamhub-core health..."
  for i in $(seq 1 60); do
    if curl -fsS "http://127.0.0.1:3020/api/v1/health" >/dev/null 2>&1; then ok "core is healthy"; break; fi
    [ "$i" = 60 ] && { docker compose logs --tail=40 core || true; die "core did not become healthy in time"; }
    sleep 3
  done

  log "seeding the global API token (idempotent)"
  # stdin ("-"): the sk_ token must never ride an argv (visible in ps/cmdline)
  printf '%s' "$(env_get STREAMHUB_API_TOKEN)" \
    | docker compose exec -T core node deploy/seed-token.js - bootstrap \
    || warn "token seed skipped (probably already seeded)"

  # ---- TLS: nginx server-block + certbot ------------------------------------
  DOMAIN="$(env_get STREAMHUB_DOMAIN)"
  if [ "$PROXY" = "nginx" ] && [ "$DOMAIN" != "localhost" ]; then
    AVAIL="/etc/nginx/sites-available/$DOMAIN"
    if [ ! -f "$AVAIL" ]; then
      log "writing nginx server block for $DOMAIN"
      sed "s/streamhub.example.com/$DOMAIN/" deploy/nginx-streamhub.conf > "$AVAIL"
      ln -sf "$AVAIL" "/etc/nginx/sites-enabled/$DOMAIN"
      rm -f /etc/nginx/sites-enabled/default
      nginx -t && systemctl reload nginx
    else
      ok "nginx server block for $DOMAIN already present"
    fi
    if [ "$NO_TLS" = "1" ]; then
      warn "--no-tls: skipping certbot ($DOMAIN stays plain HTTP on :80)"
    elif [ -d "/etc/letsencrypt/live/$DOMAIN" ]; then
      ok "Let's Encrypt cert for $DOMAIN already present (auto-renews via certbot.timer)"
    else
      log "requesting Let's Encrypt cert for $DOMAIN"
      certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --redirect -m "$(env_get ACME_EMAIL)" \
        || warn "certbot failed — check the DNS A record for $DOMAIN and re-run this installer"
    fi
  fi
else
  # --no-deps: an edge must NOT start a local redis (depends_on would) — it
  # coordinates through the ORIGIN's redis set in LIVEKIT_REDIS_ADDRESS.
  log "starting media services (livekit ingress egress) against the origin's Redis"
  docker compose up -d --no-deps livekit ingress egress
fi

# ---- 6. summary ---------------------------------------------------------------
# Secrets are shown only on an interactive TTY: under cloud-init/CI, stdout is
# persisted to logs — point at .env instead.
reveal() {
  if [ -t 1 ] && [ "$NONINTERACTIVE" != "1" ]; then printf '%s' "$1"; else printf '(see %s/.env)' "$INSTALL_DIR"; fi
}
echo
ok "============================================================"
if [ "$MODE" = "origin" ]; then
  DOMAIN="$(env_get STREAMHUB_DOMAIN)"; SCHEME="https"; [ "$DOMAIN" = "localhost" ] && { SCHEME="http"; DOMAIN="127.0.0.1:3020"; }
  ok "StreamHub origin node is running."
  echo "  Dashboard     : $SCHEME://$DOMAIN/          (login: $(env_get ADMIN_USER) / $(reveal "$(env_get ADMIN_PASS)"))"
  echo "  API + Swagger : $SCHEME://$DOMAIN/api/v1/docs"
  echo "  API token     : $(reveal "$(env_get STREAMHUB_API_TOKEN)")    (Authorization: Bearer ...)"
  echo "  RTMP publish  : rtmp://$(env_get RTMP_PUBLIC_HOST):1935/x  ·  WHIP: :8080  ·  HLS: /hls/<app>/<room>/index.m3u8"
  echo "  Cluster token : $(reveal "$(env_get STREAMHUB_CLUSTER_TOKEN)")"
  echo "  Join an edge  : curl -fsSL $SELF_URL | sudo bash -s -- --join \\"
  echo "                    --master-token $(reveal "$(env_get STREAMHUB_CLUSTER_TOKEN)") --master-ip <THIS_SERVER_IP> --master-url $SCHEME://$DOMAIN"
  echo "  Config        : $INSTALL_DIR/.env   ·   Data: $INSTALL_DIR/data"
  echo "  Logs          : docker compose -f $INSTALL_DIR/docker-compose.yml logs -f core"
  if [ "$DOMAIN" != "127.0.0.1:3020" ]; then
    echo
    warn "DNS: A record '$(env_get STREAMHUB_DOMAIN)' -> this server's public IP (DNS-only, no CDN proxy)."
    warn "Firewall: open 80,443,1935,7880,7881/tcp and 7882/udp."
  fi
else
  ok "StreamHub edge node '$NODE_NAME' is running and registered."
  echo "  Sharing Redis : $(env_get REDIS_URL)   (LiveKit room affinity via the origin)"
  echo "  Media ports   : 7880-7882, RTMP 1935, WHIP 8080"
  echo "  Note          : the origin's Redis must be reachable from this node"
  echo "                  (private network/VPN recommended; see streamhub-docs/operations/INSTALL-NODE.md)"
fi
ok "Re-running this installer is safe: it keeps .env, updates code, restarts services."
ok "============================================================"
