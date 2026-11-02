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
#   Lightweight HLS cache node (nginx only — no Docker/LiveKit):
#   curl -fsSL https://www.streamhub.studio/install.sh | sudo bash -s -- \
#       --cdn-edge --master-token <token> --master-ip <ip> [--edge-url http://<public-ip>]
#
# Target OS: Ubuntu Server 24.04/26.04 LTS or Debian 12 (bookworm) / 13 (trixie),
# x86_64 ONLY (validated, aborts otherwise; STREAMHUB_SKIP_OS_CHECK=1 overrides).
# Idempotent: safe to re-run — it keeps your .env secrets, updates the
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

VERSION="2.2.0"                       # installer format version (this script)
REPO_URL="${STREAMHUB_REPO_URL:-https://gitlab.com/digitalhub_com_ar/vision-media-server.git}"
INSTALL_DIR="${STREAMHUB_DIR:-/opt/streamhub}"
SELF_URL="${STREAMHUB_INSTALL_URL:-https://www.streamhub.studio/install.sh}"
# Read-only manifest of the latest published release (version/tarball/sha256).
# Used only to PREVIEW the target version under --dry-run; the authoritative
# TARGET is the VERSION file bundled in the freshly fetched source.
LATEST_URL="${STREAMHUB_LATEST_URL:-https://www.streamhub.studio/latest.json}"

# MediaMTX single-port RTMP front (OPT-IN, STREAMHUB_MEDIAMTX_ENABLE=true). Pinned
# binary for the bare-node systemd unit — the compose path uses the matching
# bluenviron/mediamtx:<ver>-ffmpeg image tag. Bump both together. amd64 only.
MEDIAMTX_VERSION="${STREAMHUB_MEDIAMTX_VERSION:-1.19.2}"
MEDIAMTX_SHA256="${STREAMHUB_MEDIAMTX_SHA256:-f9c601cc303ceca8fad2883917b022882672c5bc56311e92dbceb16e5f20c60c}"

c_info='\033[1;36m'; c_ok='\033[1;32m'; c_warn='\033[1;33m'; c_err='\033[1;31m'; c_off='\033[0m'
log()  { printf "${c_info}[streamhub]${c_off} %s\n" "$*"; }
ok()   { printf "${c_ok}[streamhub]${c_off} %s\n" "$*"; }
warn() { printf "${c_warn}[streamhub]${c_off} %s\n" "$*"; }
die()  { printf "${c_err}[streamhub] ERROR:${c_off} %s\n" "$*" >&2; exit 1; }
rand() { openssl rand -base64 96 | tr -dc 'A-Za-z0-9' | head -c "${1:-40}"; }

# True when the argument looks like a bare IP literal (IPv4 or IPv6) rather than
# a DNS name — Let's Encrypt can't issue a cert for an IP, and nginx wants a
# catch-all server block instead of a name-based vhost.
is_ip() {
  case "${1:-}" in
    *:*) return 0 ;;             # IPv6 (contains colons)
    ''|*[!0-9.]*) return 1 ;;    # empty, or has a non-[0-9.] char → a name
    *.*.*.*) return 0 ;;         # four dotted groups → IPv4
    *) return 1 ;;
  esac
}

# Normalize a base URL to scheme://host[:port] (no path, no trailing slash) —
# what nginx's proxy_pass and the registry `url` want. Fails on anything else
# (also keeps sed-special characters out of the nginx template).
norm_base_url() {
  local u="${1%/}"
  [[ "$u" =~ ^https?://[A-Za-z0-9._-]+(:[0-9]{1,5})?$ || "$u" =~ ^https?://\[[0-9A-Fa-f:]+\](:[0-9]{1,5})?$ ]] || return 1
  printf '%s' "$u"
}

# ---- semver (X.Y.Z) comparison ----------------------------------------------
# One numeric field, base-10, non-digit suffix stripped (so 2.2.0-rc1 → 2 2 0).
_ver_field() { local f="${1%%[!0-9]*}"; printf '%s' "$(( 10#${f:-0} ))"; }
# ver_cmp A B → prints -1 (A<B), 0 (A==B) or 1 (A>B). A leading 'v' is ignored.
ver_cmp() {
  local a="${1#v}" b="${2#v}" i x y
  local -a A B
  IFS='.' read -r -a A <<<"$a"
  IFS='.' read -r -a B <<<"$b"
  for i in 0 1 2; do
    x="$(_ver_field "${A[i]:-0}")"; y="$(_ver_field "${B[i]:-0}")"
    if [ "$x" -gt "$y" ]; then printf '1';  return; fi
    if [ "$x" -lt "$y" ]; then printf -- '-1'; return; fi
  done
  printf '0'
}
ver_gt() { [ "$(ver_cmp "$1" "$2")" = "1" ]; }   # A > B

# ---- pre-upgrade DB backup + migration evidence -----------------------------
# Read a SQLite DB's schema version (evidence the boot migration advanced it).
sqlite_user_version() { # <db-file>
  local f="$1"
  [ -f "$f" ] || { printf 'n/a'; return; }
  if command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 "$f" 'PRAGMA user_version;' 2>/dev/null || printf '?'
  else
    printf 'sqlite3-unavailable'
  fi
}

# Copy every SQLite DB (global + per-app) into a timestamped backup dir BEFORE
# the rebuild/restart that triggers boot migrations. sqlite3 `.backup` is a
# consistent hot copy (WAL-safe); without sqlite3 we fall back to `cp` (the
# stack is not yet (re)started at this point, so the files are quiescent).
backup_databases() { # <backup-dir> <data-host-dir>
  local dest="$1" data="$2" db rel
  mkdir -p "$dest"
  local -a dbs=()
  [ -f "$data/data/streamhub.db" ] && dbs+=("$data/data/streamhub.db")
  if [ -d "$data/apps" ]; then
    while IFS= read -r db; do dbs+=("$db"); done \
      < <(find "$data/apps" -maxdepth 2 -name 'app.db' -type f 2>/dev/null)
  fi
  if [ "${#dbs[@]}" -eq 0 ]; then
    warn "no SQLite DBs found under $data — nothing to back up (fresh data dir?)"
    return 0
  fi
  for db in "${dbs[@]}"; do
    rel="${db#"$data"/}"                 # e.g. data/streamhub.db, apps/live/app.db
    mkdir -p "$dest/$(dirname "$rel")"
    if command -v sqlite3 >/dev/null 2>&1; then
      sqlite3 "$db" ".backup '$dest/$rel'" 2>/dev/null || cp -p "$db" "$dest/$rel"
    else
      cp -p "$db" "$dest/$rel"
    fi
  done
  ok "backed up ${#dbs[@]} database(s) → $dest"
}

# ---- TCP reachability preflight ---------------------------------------------
# bash /dev/tcp connect with a hard timeout. 0 = connected. Used before an edge
# brings up LiveKit/ingress/egress against the origin's shared Redis: a refused
# connect there is the AWS-POC2 finding #2 crash-loop, so we fail fast instead.
preflight_tcp() { # host port [timeout_sec]
  local host="$1" port="$2" t="${3:-5}"
  timeout "$t" bash -c "exec 3<>/dev/tcp/$host/$port" 2>/dev/null
}

# ---- cloud 1:1 NAT detection (LiveKit node_ip) -------------------------------
# On AWS/GCP/Azure the public IP is NOT on any interface (the provider NATs it
# 1:1 onto the private one). LiveKit's use_external_ip then advertises the
# STUN-detected PUBLIC IP, which the egress' headless Chrome inside the VPC can't
# reach (black / no HLS — LT3 + LT4 on AWS); the fix is node_ip=<private IP> +
# use_external_ip=false. Every probe is capped at 1s and failures are silent: a
# host without metadata just isn't detected, the install never fails here.
# STREAMHUB_METADATA_HOST / STREAMHUB_PUBLIC_IP_URL are test hooks.
is_ipv4() { [[ "${1:-}" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; }
local_ipv4s() { # every IPv4 on a local interface, one per line
  { ip -o -4 addr show 2>/dev/null | awk '{split($4,a,"/"); print a[1]}'
    hostname -I 2>/dev/null | tr ' ' '\n'; } | grep -E '^[0-9.]+$' | sort -u || true
}
default_route_ipv4() { ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p' | head -1 || true; }
_meta_get() { # _meta_get <url> [header] → body ('' on any error), ≤1s
  if [ -n "${2:-}" ]; then curl -fsS --connect-timeout 1 -m 1 -H "$2" "$1" 2>/dev/null || true
  else curl -fsS --connect-timeout 1 -m 1 "$1" 2>/dev/null || true; fi
}
# Prints "<private-ip> <public-ip> <source>" when this host is behind a 1:1 NAT,
# nothing otherwise.
detect_nat_ips() {
  local mh="${STREAMHUB_METADATA_HOST:-169.254.169.254}" mport=80 m tok priv="" pub="" src="" az lip
  case "$mh" in *:*) mport="${mh##*:}" ;; esac
  m="http://$mh"
  # One TCP probe first: off-cloud the link-local metadata IP doesn't answer, so
  # this bounds the whole detection to ~1s there.
  if preflight_tcp "${mh%%:*}" "$mport" 1; then
    # AWS IMDSv2 (session token), then IMDSv1 for instances that still allow it.
    tok="$(curl -fsS --connect-timeout 1 -m 1 -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' "$m/latest/api/token" 2>/dev/null || true)"
    if [ -n "$tok" ]; then
      priv="$(_meta_get "$m/latest/meta-data/local-ipv4" "X-aws-ec2-metadata-token: $tok")"
      pub="$(_meta_get "$m/latest/meta-data/public-ipv4" "X-aws-ec2-metadata-token: $tok")"
    else
      priv="$(_meta_get "$m/latest/meta-data/local-ipv4")"
      is_ipv4 "$priv" && pub="$(_meta_get "$m/latest/meta-data/public-ipv4")"
    fi
    is_ipv4 "$priv" && src="aws-imds"
    if [ -z "$src" ]; then   # GCP
      priv="$(_meta_get "$m/computeMetadata/v1/instance/network-interfaces/0/ip" 'Metadata-Flavor: Google')"
      if is_ipv4 "$priv"; then
        src="gcp-metadata"
        pub="$(_meta_get "$m/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip" 'Metadata-Flavor: Google')"
      fi
    fi
    if [ -z "$src" ]; then   # Azure IMDS
      az="$m/metadata/instance/network/interface/0/ipv4/ipAddress/0"
      priv="$(_meta_get "$az/privateIpAddress?api-version=2021-02-01&format=text" 'Metadata: true')"
      if is_ipv4 "$priv"; then
        src="azure-imds"
        pub="$(_meta_get "$az/publicIpAddress?api-version=2021-02-01&format=text" 'Metadata: true')"
      fi
    fi
  fi
  # The advertised IP must be one this host actually has.
  if ! is_ipv4 "$priv" || ! local_ipv4s | grep -qxF "$priv"; then priv="$(default_route_ipv4)"; fi
  # No metadata: compare the public IP an echo service sees with the interfaces.
  # (A cloud that answered but has NO public IP is a private-only box: no change.)
  if [ -z "$src" ]; then
    pub="$(curl -fsS -m3 "${STREAMHUB_PUBLIC_IP_URL:-https://api.ipify.org}" 2>/dev/null | tr -d '[:space:]' || true)"
    src="public-ip-not-local"
  fi
  is_ipv4 "$priv" && is_ipv4 "$pub" || return 0
  [ "$priv" != "$pub" ] || return 0
  while IFS= read -r lip; do [ "$lip" = "$pub" ] && return 0; done < <(local_ipv4s)
  printf '%s %s %s\n' "$priv" "$pub" "$src"
}

usage() {
  cat <<'USAGE'
StreamHub node installer — Ubuntu 24.04/26.04 LTS or Debian 12/13, x86_64.

  curl -fsSL https://www.streamhub.studio/install.sh | sudo bash [-s -- FLAGS]

Modes
  --standalone           Day-0: full StreamHub master/standalone node (DEFAULT).
  --join                 Day-1: media/edge node registered on an existing master
                         VIA ITS API (needs --master-token and --master-ip; the
                         LiveKit keys/redis flow back in the join response — no
                         manual key sharing).
  --dry-run              Validate OS/ports/flags and print the plan; change nothing.
  --prepare-image        Marketplace/golden-image build (Packer): install the deps,
                         fetch the source, pre-pull the stack images and pre-build
                         the core image — then STOP. No .env, no secrets, no domain,
                         nothing started. The first real run on the booted image
                         (deploy/marketplace/first-boot.sh) installs from that baked
                         source without re-fetching (STREAMHUB_IMAGE_REFRESH=1 forces
                         a fetch). See streamhub-docs/operations/MARKETPLACE.md.

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
  --no-tls               Skip certbot (e.g. behind your own proxy/LB). Without a
                         --domain, nginx gets a catch-all vhost on :80 to the core.
  --turn                 Enable LiveKit's embedded TURN/TLS relay (5349/tcp +
                         3478/udp) so clients behind symmetric NAT / VPN / strict
                         firewalls (Safari/iOS worst) connect. nginx shape + a real
                         TLS domain only; issues a cert for the turn domain and
                         opens the ports. ORIGIN-only in v1 (serves the whole mesh).
  --turn-domain <fqdn>   TURN domain (needs its own DNS A record → this host).
                         Default: turn.<domain>. Implies --turn.
  --samples-domain <fqdn>
                         Serve the per-app sample pages from their OWN origin
                         (needs its own DNS A record → this host). Sets
                         STREAMHUB_SAMPLES_URL; installs its nginx vhost + cert
                         (or the Caddy site). Recommended for multi-tenant use.
  --no-plugins           Bare media server: disable the plugin framework in the
                         core (empty catalog, plugin routes 404, no workers) and
                         skip baking the deface worker into the image. Reversible
                         by editing STREAMHUB_PLUGINS_ENABLE in .env + rebuilding.
  --mediamtx             Single public RTMP port (:1935) via a MediaMTX front:
                         moves the LiveKit ingress to the internal :11935 and
                         routes live/* → LiveKit, <app>/<key> → passthrough remux.
                         Opt-in (installs a pinned mediamtx binary + systemd unit).
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
  --node-type <t>        common (full media node, DEFAULT) or edge (Vision Edge
                         worker/compute node: joins + heartbeats + dials the WS
                         control channel, runs NO public media plane).
  --with-egress          Run egress on this joined COMMON node. DEFAULT is OFF
                         (egress affinity): recordings/HLS must land on the ORIGIN's
                         disk or cross-node artifacts break (~50%). Opt in only if
                         you accept that limitation — fix ships with S3 transport
                         (architecture/CLUSTER-ROADMAP.md). Alias off: --no-egress.
  --region <region>      Optional region label for the registry.
  --node-ip <ip|auto|off>
                         IP LiveKit advertises (origin + common joins). DEFAULT
                         off: STUN public-IP detection (internet browsers reach
                         WebRTC directly). auto: on a cloud 1:1-NAT host (AWS/GCP/
                         Azure metadata, or public IP not on any interface) LiveKit
                         gets node_ip=<private IP> + use_external_ip=false — for
                         clusters whose media ports are closed to the internet
                         (browsers then need TURN). <ip> forces. Persisted.

CDN edge (lightweight HLS cache — nginx only, no Docker/LiveKit)
  --cdn-edge             = --join --node-type cdn-edge: nginx caching /hls from the
                         origin (deploy/nginx-hls-edge.conf), registered + heartbeating
                         (conns/req/tx Mbps). Needs --master-token + --master-ip.
  --edge-url <url>       Public base URL viewers use for this edge (registered as
                         its `url`). Default: http://<detected public IP>.
  --cdn-origin-url <url> Where the edge pulls /hls from. Default: the master URL the
                         join succeeded against (http://<master-ip> or --master-url).
  --edge-cache-tmpfs <size>
                         Mount the HLS cache dir as tmpfs (e.g. 4g / 2048m);
                         nginx's max_size is set to 90% of it. off = disk cache.

General
  --dir <path>           Install dir (default /opt/streamhub).
  --non-interactive      Never prompt; missing values = generated or defaults.
  --force-reinstall      Re-run the upgrade steps (backup + rebuild + re-stamp)
                         even when already at the target version.
  --version | --help

Every flag has an env equivalent: STREAMHUB_DOMAIN, ACME_EMAIL, ADMIN_USER,
ADMIN_PASS, STREAMHUB_SUPERADMIN_EMAIL, STREAMHUB_SMTP_{HOST,PORT,USER,PASS,FROM},
STREAMHUB_PROXY, STREAMHUB_NO_TLS, STREAMHUB_CLUSTER_REDIS_BIND, STREAMHUB_JOIN,
STREAMHUB_MASTER_TOKEN, STREAMHUB_MASTER_IP, STREAMHUB_MASTER_URL (o los legacy
STREAMHUB_CLUSTER_TOKEN/ORIGIN_IP/ORIGIN_URL), STREAMHUB_NODE_NAME,
STREAMHUB_REGION, STREAMHUB_DIR, STREAMHUB_NON_INTERACTIVE=1,
STREAMHUB_FORCE_REINSTALL=1, STREAMHUB_MEDIAMTX_ENABLE=1 (--mediamtx),
STREAMHUB_NO_PLUGINS=1 (--no-plugins), STREAMHUB_TURN_ENABLE=1 (--turn) +
STREAMHUB_TURN_DOMAIN (--turn-domain), STREAMHUB_NODE_EGRESS=1 (--with-egress),
STREAMHUB_SAMPLES_DOMAIN (--samples-domain), STREAMHUB_PREPARE_IMAGE=1
(--prepare-image), STREAMHUB_NODE_IP (--node-ip), STREAMHUB_CDN_EDGE=1
(--cdn-edge), STREAMHUB_EDGE_URL (--edge-url), STREAMHUB_CDN_ORIGIN_URL
(--cdn-origin-url), STREAMHUB_EDGE_CACHE_TMPFS (--edge-cache-tmpfs).
Re-runs: idempotent. If a newer VERSION is fetched, an UPGRADE runs (pre-upgrade
DB backup → rebuild → migrate on boot → verify → re-stamp $INSTALL_DIR/VERSION).
Flags/env update their .env keys; generated secrets are never rotated.
USAGE
}

# ---- flags ------------------------------------------------------------------
MODE="origin"
DRY_RUN=0
PREPARE_IMAGE="${STREAMHUB_PREPARE_IMAGE:-0}"
case "$PREPARE_IMAGE" in 1|true|on|yes|TRUE|On|Yes) PREPARE_IMAGE=1 ;; *) PREPARE_IMAGE=0 ;; esac
FORCE_REINSTALL="${STREAMHUB_FORCE_REINSTALL:-0}"
NONINTERACTIVE="${STREAMHUB_NON_INTERACTIVE:-0}"
PROXY="${STREAMHUB_PROXY:-nginx}"
# Only an operator choice (flag/env) may override the proxy persisted in
# .install-profile — a bare re-run / `streamhub upgrade` of a caddy origin must
# NOT silently turn into an nginx one (it would also drop its caddy container).
EXPLICIT_PROXY=0; [ -n "${STREAMHUB_PROXY:-}" ] && EXPLICIT_PROXY=1
NO_TLS="${STREAMHUB_NO_TLS:-0}"
NO_PLUGINS="${STREAMHUB_NO_PLUGINS:-0}"
JOIN="${STREAMHUB_JOIN:-0}"
# Track whether the operator CHOSE a mode/node-type this run (flag or env) —
# only then may it override a persisted .join-profile (see the resume block).
EXPLICIT_MODE=0; [ -n "${STREAMHUB_JOIN:-}" ] && EXPLICIT_MODE=1
EXPLICIT_NODE_TYPE=0; [ -n "${STREAMHUB_NODE_TYPE:-}" ] && EXPLICIT_NODE_TYPE=1
EXPLICIT_NODE_NAME=0; [ -n "${STREAMHUB_NODE_NAME:-}" ] && EXPLICIT_NODE_NAME=1
CLUSTER_TOKEN="${STREAMHUB_MASTER_TOKEN:-${STREAMHUB_CLUSTER_TOKEN:-}}"
ORIGIN_IP="${STREAMHUB_MASTER_IP:-${STREAMHUB_ORIGIN_IP:-}}"
ORIGIN_URL="${STREAMHUB_MASTER_URL:-${STREAMHUB_ORIGIN_URL:-}}"
NODE_NAME="${STREAMHUB_NODE_NAME:-$(hostname -s 2>/dev/null || echo node)}"
NODE_TYPE="${STREAMHUB_NODE_TYPE:-common}"
REGION="${STREAMHUB_REGION:-}"
CLUSTER_REDIS_BIND="${STREAMHUB_CLUSTER_REDIS_BIND:-}"
# MediaMTX single-port :1935 RTMP front (opt-in). Accept the common truthy forms.
MEDIAMTX_ENABLE="${STREAMHUB_MEDIAMTX_ENABLE:-0}"
case "$MEDIAMTX_ENABLE" in 1|true|on|yes|TRUE|On|Yes) MEDIAMTX_ENABLE=1 ;; *) MEDIAMTX_ENABLE=0 ;; esac

# TURN relay (embedded LiveKit TURN/TLS on 5349) — OFF by default, origin + nginx
# shape only. STREAMHUB_TURN_DOMAIN defaults to turn.<domain> when enabled.
TURN_ENABLE="${STREAMHUB_TURN_ENABLE:-0}"
case "$TURN_ENABLE" in 1|true|on|yes|TRUE|On|Yes) TURN_ENABLE=1 ;; *) TURN_ENABLE=0 ;; esac
TURN_DOMAIN="${STREAMHUB_TURN_DOMAIN:-}"

# Samples origin (features/samples.md) — OFF by default, origin only. A second
# hostname for the tenant-editable sample pages, so they never run on the
# dashboard's origin. Persisted as STREAMHUB_SAMPLES_URL (+ SAMPLES_DOMAIN for Caddy).
SAMPLES_DOMAIN="${STREAMHUB_SAMPLES_DOMAIN:-}"

# Egress affinity: a joined COMMON node does NOT run egress unless it opts in
# (--with-egress / STREAMHUB_NODE_EGRESS=1), so recording/HLS artifacts land on
# the ORIGIN's disk (cross-node egress is broken for artifacts until S3 transport
# — see architecture/CLUSTER-ROADMAP.md). Origin always runs egress (unaffected).
WITH_EGRESS="${STREAMHUB_NODE_EGRESS:-0}"
case "$WITH_EGRESS" in 1|true|on|yes|TRUE|On|Yes) WITH_EGRESS=1 ;; *) WITH_EGRESS=0 ;; esac
# Track whether the operator CHOSE egress this run (flag or env) — only then may
# it override the persisted .join-profile choice on a bare re-run / upgrade.
EXPLICIT_EGRESS=0; [ -n "${STREAMHUB_NODE_EGRESS:-}" ] && EXPLICIT_EGRESS=1

# LiveKit advertised IP (cloud 1:1 NAT, see resolve_node_ip): off (DEFAULT — keep
# use_external_ip STUN detection, so internet browsers reach WebRTC directly),
# auto (detect via instance metadata; for clusters whose media ports are NOT open
# to the internet) or an explicit IP. Persisted as STREAMHUB_PROFILE_NODE_IP.
NODE_IP_MODE="${STREAMHUB_NODE_IP:-off}"
EXPLICIT_NODE_IP=0; [ -n "${STREAMHUB_NODE_IP:-}" ] && EXPLICIT_NODE_IP=1

# CDN edge (--cdn-edge = --join --node-type cdn-edge): nginx HLS cache only.
# Empty values fall back to what a previous run stored in .env (section 4).
case "${STREAMHUB_CDN_EDGE:-0}" in
  1|true|on|yes|TRUE|On|Yes) JOIN=1; NODE_TYPE="cdn-edge"; EXPLICIT_MODE=1; EXPLICIT_NODE_TYPE=1 ;;
esac
EDGE_URL="${STREAMHUB_EDGE_URL:-}"
CDN_ORIGIN_URL="${STREAMHUB_CDN_ORIGIN_URL:-}"
EDGE_CACHE_TMPFS="${STREAMHUB_EDGE_CACHE_TMPFS:-}"

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
    --proxy)             PROXY="${2?$1 requires a value}"; EXPLICIT_PROXY=1; shift 2 ;;
    --cluster-redis-bind) CLUSTER_REDIS_BIND="${2?$1 requires a value}"; shift 2 ;;
    --mediamtx)          MEDIAMTX_ENABLE=1; shift ;;
    --no-mediamtx)       MEDIAMTX_ENABLE=0; shift ;;
    --turn)              TURN_ENABLE=1; shift ;;
    --turn-domain)       TURN_DOMAIN="${2?$1 requires a value}"; TURN_ENABLE=1; shift 2 ;;
    --samples-domain)    SAMPLES_DOMAIN="${2?$1 requires a value}"; shift 2 ;;
    --with-egress)       WITH_EGRESS=1; EXPLICIT_EGRESS=1; shift ;;
    --no-egress)         WITH_EGRESS=0; EXPLICIT_EGRESS=1; shift ;;
    --no-tls)            NO_TLS=1; shift ;;
    --no-plugins)        NO_PLUGINS=1; shift ;;
    --standalone)        JOIN=0; MODE="origin"; EXPLICIT_MODE=1; shift ;;
    --join)              JOIN=1; MODE="join"; EXPLICIT_MODE=1; shift ;;
    --master-token|--cluster-token) CLUSTER_TOKEN="${2?$1 requires a value}"; shift 2 ;;
    --master-ip|--origin-ip)        ORIGIN_IP="${2?$1 requires a value}"; shift 2 ;;
    --master-url|--origin-url)      ORIGIN_URL="${2?$1 requires a value}"; shift 2 ;;
    --node-name)         NODE_NAME="${2?$1 requires a value}"; EXPLICIT_NODE_NAME=1; shift 2 ;;
    --node-type)         NODE_TYPE="${2?$1 requires a value}"; EXPLICIT_NODE_TYPE=1; shift 2 ;;
    --region)            REGION="${2?$1 requires a value}"; shift 2 ;;
    --node-ip)           NODE_IP_MODE="${2?$1 requires a value}"; EXPLICIT_NODE_IP=1; shift 2 ;;
    --cdn-edge)          JOIN=1; MODE="join"; NODE_TYPE="cdn-edge"; EXPLICIT_MODE=1; EXPLICIT_NODE_TYPE=1; shift ;;
    --edge-url)          EDGE_URL="${2?$1 requires a value}"; shift 2 ;;
    --cdn-origin-url)    CDN_ORIGIN_URL="${2?$1 requires a value}"; shift 2 ;;
    --edge-cache-tmpfs)  EDGE_CACHE_TMPFS="${2?$1 requires a value}"; shift 2 ;;
    --dir)               INSTALL_DIR="${2?$1 requires a value}"; shift 2 ;;
    --non-interactive)   NONINTERACTIVE=1; shift ;;
    --dry-run)           DRY_RUN=1; shift ;;
    --prepare-image)     PREPARE_IMAGE=1; shift ;;
    --force-reinstall)   FORCE_REINSTALL=1; shift ;;
    --version)           echo "streamhub-install $VERSION"; exit 0 ;;
    -h|--help)           usage; exit 0 ;;
    *)                   die "unknown flag: $1 (see --help)" ;;
  esac
done
[ "$JOIN" = "1" ] && MODE="join"

# ---- join-mode resume (.join-profile) ----------------------------------------
# `streamhub upgrade` (and any bare installer re-run) does NOT re-pass --join or
# its params, so without this a joined node would silently re-run in ORIGIN mode
# and try to rebuild the full master stack on it. Every successful join persists
# its role + params (mode 600 — it holds the cluster token); a re-run without an
# explicit --standalone/--join adopts them. Explicit flags always win.
if [ "$EXPLICIT_MODE" = "0" ] && [ -r "$INSTALL_DIR/.join-profile" ]; then
  # shellcheck disable=SC1091
  . "$INSTALL_DIR/.join-profile"
  JOIN=1; MODE="join"
  [ -n "$CLUSTER_TOKEN" ] || CLUSTER_TOKEN="${STREAMHUB_PROFILE_CLUSTER_TOKEN:-}"
  [ -n "$ORIGIN_IP" ]     || ORIGIN_IP="${STREAMHUB_PROFILE_ORIGIN_IP:-}"
  [ -n "$ORIGIN_URL" ]    || ORIGIN_URL="${STREAMHUB_PROFILE_ORIGIN_URL:-}"
  [ "$EXPLICIT_NODE_TYPE" = "1" ] || NODE_TYPE="${STREAMHUB_PROFILE_NODE_TYPE:-$NODE_TYPE}"
  # Preserve the egress-affinity choice so an upgrade / bare re-run doesn't
  # silently start (or drop) egress on a joined node.
  [ "$EXPLICIT_EGRESS" = "1" ] || WITH_EGRESS="${STREAMHUB_PROFILE_EGRESS:-$WITH_EGRESS}"
  # Keep the registered identity too — otherwise a bare upgrade re-registers
  # under the hostname and duplicates the node in the registry.
  [ "$EXPLICIT_NODE_NAME" = "1" ] || NODE_NAME="${STREAMHUB_PROFILE_NODE_NAME:-$NODE_NAME}"
  log "existing join detected ($INSTALL_DIR/.join-profile) — resuming as a '$NODE_TYPE' node '$NODE_NAME' of ${ORIGIN_URL:-$ORIGIN_IP} (pass --standalone to override)"
fi

# ---- profile resume (.install-profile): proxy + LiveKit node IP ---------------
# Written by every successful run (origin and joins). A bare re-run keeps the
# previous choices; an explicit flag/env always wins.
if [ -r "$INSTALL_DIR/.install-profile" ]; then
  _prof_proxy="$(sed -n 's/^STREAMHUB_PROFILE_PROXY=//p' "$INSTALL_DIR/.install-profile" 2>/dev/null | head -1)"
  _prof_nodeip="$(sed -n 's/^STREAMHUB_PROFILE_NODE_IP=//p' "$INSTALL_DIR/.install-profile" 2>/dev/null | head -1)"
  if [ "$EXPLICIT_PROXY" = "0" ] && [ "$MODE" = "origin" ] && [ -n "$_prof_proxy" ]; then
    PROXY="$_prof_proxy"
  fi
  [ "$EXPLICIT_NODE_IP" = "1" ] || NODE_IP_MODE="${_prof_nodeip:-$NODE_IP_MODE}"
fi

case "$PROXY" in nginx|caddy) ;; *) die "--proxy must be nginx or caddy" ;; esac
# --prepare-image bakes an ORIGIN image (a joined node needs a live master).
[ "$PREPARE_IMAGE" = "1" ] && [ "$MODE" = "join" ] && die "--prepare-image builds an origin image; it can't be combined with --join"
case "$NODE_TYPE" in common|edge|cdn-edge) ;; *) die "--node-type must be common, edge or cdn-edge" ;; esac
# A CDN edge runs nginx only: no Docker, no LiveKit, no compose stack.
CDN_EDGE=0; [ "$MODE" = "join" ] && [ "$NODE_TYPE" = "cdn-edge" ] && CDN_EDGE=1
[ "$NODE_TYPE" = "cdn-edge" ] && [ "$MODE" != "join" ] && die "--node-type cdn-edge is a join (use --cdn-edge with --master-token/--master-ip)"
case "$NODE_IP_MODE" in
  auto|off) ;;
  *) is_ip "$NODE_IP_MODE" || die "--node-ip must be an IP address, auto or off (got '$NODE_IP_MODE')" ;;
esac

# ---- TURN gating (resolve BEFORE the port preflight / ufw so both see it) -----
# TURN v1 is ORIGIN-ONLY (LiveKit's TURN on the origin serves the whole mesh) and
# needs on-disk letsencrypt PEMs → the nginx shape only. Reject/skip elsewhere.
if [ "$MODE" = "join" ] && [ "$TURN_ENABLE" = "1" ]; then
  warn "--turn is origin-only in v1 (the origin's LiveKit TURN serves the mesh) — ignoring on this join node."
  TURN_ENABLE=0
fi
if [ "$TURN_ENABLE" = "1" ] && [ "$PROXY" = "caddy" ]; then
  warn "TURN v1 requires the nginx shape (LiveKit needs the on-disk letsencrypt PEMs; Caddy keeps certs in its own store)."
  warn "Skipping TURN. Use --proxy nginx, or drop fullchain.pem+privkey.pem into ./data/certs/turn and set STREAMHUB_TURN_* by hand."
  TURN_ENABLE=0
fi
# Existing origin with TURN already enabled: honor it on a bare re-run / upgrade
# so the firewall + cert steps stay idempotent even without --turn re-passed.
if [ "$MODE" = "origin" ] && [ "$TURN_ENABLE" != "1" ] && [ -r "$INSTALL_DIR/.env" ] \
   && grep -qE '^STREAMHUB_TURN_ENABLE=true' "$INSTALL_DIR/.env" 2>/dev/null; then
  TURN_ENABLE=1
  [ -n "$TURN_DOMAIN" ] || TURN_DOMAIN="$({ grep -E '^STREAMHUB_TURN_DOMAIN=' "$INSTALL_DIR/.env" | head -1 | cut -d= -f2- ; } 2>/dev/null || true)"
fi

# ---- 0. root + OS gate ------------------------------------------------------
[ "$(id -u)" = "0" ] || die "run as root:  curl -fsSL $SELF_URL | sudo bash"

# ---- 0a. detect an existing install (BEFORE the fetch overwrites VERSION) ----
# INSTALLED = the version currently deployed here; absent VERSION on a dir that
# already has a compose file ⇒ a pre-2.2.0 legacy install (treat as older).
EXISTING_INSTALL=0
INSTALLED_VERSION=""
if [ -f "$INSTALL_DIR/docker-compose.yml" ] || [ -f "$INSTALL_DIR/VERSION" ]; then
  EXISTING_INSTALL=1
  if [ -r "$INSTALL_DIR/VERSION" ]; then
    INSTALLED_VERSION="$(head -1 "$INSTALL_DIR/VERSION" 2>/dev/null | tr -d '[:space:]')"
  fi
  [ -n "$INSTALLED_VERSION" ] || INSTALLED_VERSION="0.0.0"   # legacy, pre-VERSION
fi
# A marketplace image built with --prepare-image carries the source + pre-pulled
# images but was never INSTALLED (no .env, no data): its first real run is a
# FRESH install from that baked source. The marker is removed once the install
# succeeds (install_app_scaffolding), so later runs are ordinary re-runs.
IMAGE_PREPARED=0
IMAGE_MARKER="$INSTALL_DIR/.image-prepared"
IMAGE_CHANNEL=""   # telemetry channel of the image (e.g. marketplace-digitalocean)
if [ -f "$IMAGE_MARKER" ]; then
  IMAGE_PREPARED=1
  EXISTING_INSTALL=0
  INSTALLED_VERSION=""
  IMAGE_CHANNEL="$(sed -n 's/^STREAMHUB_IMAGE_CHANNEL=//p' "$IMAGE_MARKER" 2>/dev/null | head -1)"
fi

# ---- 0b. install log (tee everything below) ----------------------------------
# Everything the app owns lives under $INSTALL_DIR: bin/ (the streamhub CLI),
# logs/ (this install log + `streamhub logs --save`), backups/ (pre-upgrade DB
# snapshots), data/ (runtime), .env (config), VERSION (stamped).
# Start teeing to logs/install.log NOW only for an EXISTING install — creating
# any file in $INSTALL_DIR before the source fetch would break a fresh `git
# clone` (which needs an empty target). Fresh installs start teeing right after
# the fetch (see below). Both skip under --dry-run.
LOG_ACTIVE=0
INSTALL_LOG="$INSTALL_DIR/logs/install.log"
setup_install_log() { # tee stdout+stderr to the credential-free install log
  [ "$DRY_RUN" = "1" ] && return 0
  [ "$PREPARE_IMAGE" = "1" ] && return 0   # an image build must not bake a log
  [ "$LOG_ACTIVE" = "1" ] && return 0
  mkdir -p "$INSTALL_DIR/logs" 2>/dev/null || return 0
  if : >> "$INSTALL_LOG" 2>/dev/null; then
    chmod 600 "$INSTALL_LOG" 2>/dev/null || true
    # Secrets are NOT printed here (reveal() gates on an interactive TTY, which a
    # pipe is not) — the log stays credential-free.
    exec > >(tee -a "$INSTALL_LOG") 2>&1
    LOG_ACTIVE=1
    log "install log → $INSTALL_LOG  ($(date -u +%Y-%m-%dT%H:%M:%SZ))"
  fi
}
[ "$EXISTING_INSTALL" = "1" ] && setup_install_log

if [ "${STREAMHUB_SKIP_OS_CHECK:-0}" != "1" ]; then
  ARCH="$(uname -m)"
  [ "$ARCH" = "x86_64" ] || die "unsupported architecture '$ARCH' — StreamHub targets x86_64 (amd64) only."
  [ -r /etc/os-release ] || die "cannot read /etc/os-release — unsupported OS. Target: Ubuntu 24.04/26.04 LTS or Debian 12/13 (x64)."
  # shellcheck disable=SC1091
  . /etc/os-release
  # Ubuntu and Debian share the apt/docker/certbot toolchain; get.docker.com
  # (used below) auto-selects the right Docker repo per ID. Gate on the tested
  # ID + version pairs; STREAMHUB_SKIP_OS_CHECK=1 overrides for anything else.
  case "${ID:-}" in
    ubuntu)
      case "${VERSION_ID:-}" in
        24.04|26.04) ok "OS check: Ubuntu ${VERSION_ID} LTS x86_64" ;;
        *) die "unsupported Ubuntu ${VERSION_ID:-?} — supported: 24.04 LTS and 26.04 LTS. (STREAMHUB_SKIP_OS_CHECK=1 overrides at your own risk.)" ;;
      esac
      ;;
    debian)
      # Debian 12 = bookworm, 13 = trixie.
      case "${VERSION_ID:-}" in
        12|13) ok "OS check: Debian ${VERSION_ID} (${VERSION_CODENAME:-?}) x86_64" ;;
        *) die "unsupported Debian ${VERSION_ID:-?} — supported: 12 (bookworm) and 13 (trixie). (STREAMHUB_SKIP_OS_CHECK=1 overrides at your own risk.)" ;;
      esac
      ;;
    *)
      die "unsupported OS '${PRETTY_NAME:-unknown}' — StreamHub supports Ubuntu Server 24.04/26.04 LTS and Debian 12/13 (x64)."
      ;;
  esac
else
  warn "STREAMHUB_SKIP_OS_CHECK=1 — skipping the OS gate (unsupported territory)."
fi

export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a

# ---- 1. port preflight ------------------------------------------------------
# Ubuntu/Debian Server ships iproute2 (ss); minimal containers/chroots may not.
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
    # "streamhub-core" = the host-network Go core (3.x); "node"/"MainThread" =
    # the 2.x Node core as it names its main thread (seen on in-place origin
    # upgrades). A foreign process squatting the port under one of these names
    # would still fail loudly at compose up.
    *docker*|*nginx*|*caddy*|*livekit*|*ingress*|*egress*|*redis*|*streamhub-core*|*node*|*mediamtx*|*MainThread*) return 0 ;;  # ours on re-run
    *) echo "$owner"; return 1 ;;
  esac
}
PORTS_TCP="1935 7880 7881 8080"
PORTS_UDP="7882"
if [ "$MODE" = "origin" ]; then PORTS_TCP="80 443 3020 6379 $PORTS_TCP"; fi
# TURN (origin + nginx): the TLS relay (5349/tcp) + UDP relay (3478/udp).
if [ "$MODE" = "origin" ] && [ "$TURN_ENABLE" = "1" ]; then PORTS_TCP="5349 $PORTS_TCP"; PORTS_UDP="3478 $PORTS_UDP"; fi
# CDN edge: only nginx on :80 (no media plane).
if [ "$CDN_EDGE" = "1" ]; then PORTS_TCP="80"; PORTS_UDP=""; fi
PORT_FAIL=0
for p in $PORTS_TCP; do
  if ! o=$(check_port "$p" tcp); then warn "port $p/tcp is busy: $o"; PORT_FAIL=1; fi
done
for p in $PORTS_UDP; do
  if ! o=$(check_port "$p" udp); then warn "port $p/udp is busy: $o"; PORT_FAIL=1; fi
done
[ "$PORT_FAIL" = "1" ] && die "free the ports above (or stop the services holding them) and re-run."
ok "port preflight passed"

# Best-effort peek at the latest published version (read-only) for the dry-run
# plan; the real TARGET is the VERSION bundled in the fetched source.
remote_target_version() {
  command -v curl >/dev/null 2>&1 || return 1
  curl -fsSL -m8 "$LATEST_URL" 2>/dev/null \
    | grep -o '"version"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | cut -d'"' -f4
}

if [ "$DRY_RUN" = "1" ]; then
  ok "dry-run: OS + ports OK."
  [ "$PREPARE_IMAGE" = "1" ] && echo "  action: PREPARE IMAGE (deps + source + pre-pulled images + pre-built core; no .env, nothing started)"
  echo "  mode=$MODE proxy=$PROXY dir=$INSTALL_DIR domain=${STREAMHUB_DOMAIN:-<ask>} tls=$([ "$NO_TLS" = 1 ] && echo off || echo on) turn=$([ "$TURN_ENABLE" = 1 ] && echo on || echo off)$([ "$MODE" = join ] && { [ "$WITH_EGRESS" = 1 ] && echo ' egress=on' || echo ' egress=off(affinity)'; }) node-ip=$NODE_IP_MODE$([ "$CDN_EDGE" = 1 ] && echo " node-type=cdn-edge edge-url=${EDGE_URL:-<detected>} cache-tmpfs=${EDGE_CACHE_TMPFS:-off}")"
  if [ "$EXISTING_INSTALL" = "0" ]; then
    echo "  action: FRESH INSTALL (no existing install at $INSTALL_DIR)"
  else
    RTARGET="$(remote_target_version || true)"
    echo "  installed: ${INSTALLED_VERSION:-unknown}   latest(published): ${RTARGET:-unknown}"
    if [ "$FORCE_REINSTALL" = "1" ]; then
      echo "  action: FORCE REINSTALL (backup → rebuild → re-stamp), --force-reinstall"
    elif [ -n "$RTARGET" ] && ver_gt "$RTARGET" "$INSTALLED_VERSION"; then
      echo "  action: UPGRADE ${INSTALLED_VERSION} → ${RTARGET} (pre-upgrade DB backup, migrate on boot, verify, re-stamp)"
    elif [ -n "$RTARGET" ] && [ "$RTARGET" = "$INSTALLED_VERSION" ]; then
      echo "  action: UP-TO-DATE (idempotent reconcile only; no backup, no migration)"
    else
      echo "  action: RE-RUN (up-to-date or upgrade — decided from the VERSION bundled in the fetched source)"
    fi
  fi
  exit 0
fi

# ---- 2. dependencies (idempotent) -------------------------------------------
log "installing dependencies (apt)"
apt-get update -qq
# sqlite3: consistent pre-upgrade DB `.backup` + reading PRAGMA user_version as
# migration evidence (falls back to cp if it somehow isn't present).
apt-get install -y -qq ca-certificates curl git openssl python3 sqlite3 >/dev/null

if [ "$CDN_EDGE" = "1" ]; then
  # CDN edge: nginx is the whole node (no Docker, no compose stack).
  if ! command -v nginx >/dev/null 2>&1; then
    log "installing nginx (CDN edge)"
    apt-get install -y -qq nginx >/dev/null
  else
    ok "nginx already installed"
  fi
elif ! command -v docker >/dev/null 2>&1; then
  log "installing Docker (get.docker.com)"
  # get.docker.com reads /etc/os-release and picks the matching Docker apt repo
  # automatically (download.docker.com/linux/{ubuntu,debian}) — no per-distro
  # branching needed here.
  curl -fsSL https://get.docker.com | sh
else
  ok "docker already installed: $(docker --version)"
fi
# docker-compose-plugin lives in Docker's repo; the distro's own archive (the
# docker.io package) ships it as docker-compose-v2 — try both.
if [ "$CDN_EDGE" != "1" ]; then
  docker compose version >/dev/null 2>&1 || {
    log "installing the docker compose plugin"
    apt-get install -y -qq docker-compose-plugin >/dev/null 2>&1 \
      || apt-get install -y -qq docker-compose-v2 >/dev/null 2>&1 \
      || die "could not install a docker compose plugin (tried docker-compose-plugin, docker-compose-v2)"
  }
  systemctl enable --now docker >/dev/null 2>&1 || true
fi

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
# The full set of media-server kernel/limit knobs (somaxconn, udp_mem, ephemeral
# port range, fs.file-max, swappiness, THP) and their remedies live in
# streamhub-docs/operations/OS-TUNING.md; the running host's applied/not-applied
# posture is reported read-only at GET /api/v1/system/os-tuning (Server settings
# -> OS tuning panel).
if [ "$CDN_EDGE" != "1" ] && [ "$(sysctl -n net.core.rmem_max 2>/dev/null || echo 0)" -lt 16777216 ]; then
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
  [ "$CDN_EDGE" = "1" ] && PORTS_TCP_UFW="80 443"   # $PORTS_UDP is empty here
  # TURN (origin + nginx only): 5349/tcp (TLS) + 3478/udp. $PORTS_UDP already
  # carries 3478 when TURN is enabled (set in the port preflight above).
  [ "$MODE" = "origin" ] && [ "$TURN_ENABLE" = "1" ] && PORTS_TCP_UFW="5349 $PORTS_TCP_UFW"
  for p in $PORTS_TCP_UFW; do ufw allow "$p/tcp" >/dev/null || true; done
  for p in $PORTS_UDP; do ufw allow "$p/udp" >/dev/null || true; done
fi

# ---- 3. source ----------------------------------------------------------------
# git clone is the fast path (public repo / configured credentials); the hosted
# tarball is the fallback so the one-liner works even while the repo is private.
# GIT_TERMINAL_PROMPT=0: a private repo must fail fast, never hang on a prompt.
SRC_URL="${STREAMHUB_SRC_URL:-https://www.streamhub.studio/streamhub-src.tar.gz}"

# rsync is the surgical mirror path; ensure it, fall back to find+cp otherwise.
ensure_rsync() {
  command -v rsync >/dev/null 2>&1 && return 0
  log "installing rsync (for a clean source refresh)"
  apt-get install -y -qq rsync >/dev/null 2>&1 || true
  command -v rsync >/dev/null 2>&1
}

# Extract the tarball into a FRESH temp dir and MIRROR it over the install dir
# with deletion semantics, so files removed upstream (a deleted page/plugin dir)
# disappear here too. A plain `tar x` on top resurrects them and breaks the
# docker build (e.g. a stale streamhub-web/src/pages/*.tsx failing `tsc -b`).
# PRESERVED (never touched): .env secrets, the bind-mounted data/ tree (sqlite,
# recordings, HLS, redis, models, sdk), operator *.local overrides, .git, and the
# app's own runtime dirs (bin/ CLI, logs/, backups/, .install-profile).
# Works for a first install (empty dir → nothing to delete) and is idempotent.
fetch_tarball() {
  log "downloading StreamHub source ($SRC_URL)"
  mkdir -p "$INSTALL_DIR"
  local tgz tmp src rc=0
  tgz="$(mktemp)"
  tmp="$(mktemp -d)"

  if ! curl -fsSL -m180 "$SRC_URL" -o "$tgz"; then
    rc=1
  elif ! tar xzf "$tgz" -C "$tmp"; then
    rc=1
  else
    # Source root: tarball is usually flat (docker-compose.yml at top) but may be
    # wrapped in a single dir — accept either.
    if [ -f "$tmp/docker-compose.yml" ]; then
      src="$tmp"
    else
      src="$(find "$tmp" -mindepth 1 -maxdepth 1 -type d -exec test -f '{}/docker-compose.yml' ';' -print 2>/dev/null | head -1)"
    fi
    if [ -z "${src:-}" ] || [ ! -f "$src/docker-compose.yml" ]; then
      warn "tarball layout unexpected — docker-compose.yml not found in the archive"
      rc=1
    else
      # Capture the TARGET version from the fetched source, then STRIP the file
      # so the mirror never advances $INSTALL_DIR/VERSION — VERSION is stamped
      # only after the post-health check passes (a failed build must leave the
      # old VERSION so a re-run retries the upgrade). See the stamp in section 5b.
      [ -r "$src/VERSION" ] && FETCHED_VERSION="$(head -1 "$src/VERSION" 2>/dev/null | tr -d '[:space:]')"
      rm -f "$src/VERSION"
      # Defensive: a stray state file inside the archive must never clobber real
      # state (the excludes below also cover this, but strip it for find+cp too).
      rm -f "$src/.env" "$src/.env.local"
      find "$src" -maxdepth 1 -name '*.local' -exec rm -f {} + 2>/dev/null || true
      if ensure_rsync; then
        log "mirroring source over $INSTALL_DIR (rsync --delete — removed files pruned; .env/data/bin/logs/backups/VERSION/.git kept)"
        rsync -a --delete \
          --exclude='/.env' --exclude='/.env.local' --exclude='*.local' \
          --exclude='/data/' --exclude='/.git/' \
          --exclude='/bin/' --exclude='/logs/' --exclude='/backups/' \
          --exclude='/.install-profile' --exclude='/.join-profile' --exclude='/.install_id' --exclude='/.image-prepared' --exclude='/VERSION' \
          "$src"/ "$INSTALL_DIR"/ || rc=1
      else
        warn "rsync unavailable — using a find-based mirror (delete stale top-level, then copy)"
        # Remove every top-level entry that isn't preserved state, then lay the
        # fresh tree down. Nested stale files vanish because their whole
        # top-level dir (e.g. streamhub-web/) is removed and re-copied from src.
        find "$INSTALL_DIR" -mindepth 1 -maxdepth 1 \
          ! -name .env ! -name '.env.local' ! -name '*.local' \
          ! -name data ! -name .git \
          ! -name bin ! -name logs ! -name backups \
          ! -name .install-profile ! -name .join-profile ! -name .install_id ! -name .image-prepared ! -name VERSION \
          -exec rm -rf {} + 2>/dev/null || true
        cp -a "$src"/. "$INSTALL_DIR"/ || rc=1
      fi
    fi
  fi

  rm -rf "$tgz" "$tmp"
  return "$rc"
}
# FETCHED_VERSION = the TARGET version from the source we fetch this run. The
# tarball path sets it inside fetch_tarball (and leaves $INSTALL_DIR/VERSION
# untouched); the git paths read it from the pulled/cloned tree.
FETCHED_VERSION=""
if [ "$IMAGE_PREPARED" = "1" ] && [ "${STREAMHUB_IMAGE_REFRESH:-0}" != "1" ]; then
  # Prepared image: install exactly the version that was baked (no network fetch,
  # no rebuild drift). STREAMHUB_IMAGE_REFRESH=1 falls through to a normal fetch.
  FETCHED_VERSION="$(sed -n 's/^STREAMHUB_IMAGE_VERSION=//p' "$IMAGE_MARKER" 2>/dev/null | head -1 | tr -d '[:space:]')"
  log "prepared image detected — installing the baked source v${FETCHED_VERSION:-?} (STREAMHUB_IMAGE_REFRESH=1 re-fetches)"
elif [ -d "$INSTALL_DIR/.git" ]; then
  log "updating existing checkout in $INSTALL_DIR"
  GIT_TERMINAL_PROMPT=0 git -C "$INSTALL_DIR" pull --ff-only \
    || warn "git pull failed — continuing with the current checkout"
  [ -r "$INSTALL_DIR/VERSION" ] && FETCHED_VERSION="$(head -1 "$INSTALL_DIR/VERSION" 2>/dev/null | tr -d '[:space:]')"
elif [ -f "$INSTALL_DIR/docker-compose.yml" ]; then
  log "refreshing $INSTALL_DIR from the source tarball (mirror + prune removed files)"
  fetch_tarball || warn "tarball refresh failed — continuing with the current copy"
else
  log "fetching StreamHub into $INSTALL_DIR"
  if GIT_TERMINAL_PROMPT=0 git clone --depth 1 "$REPO_URL" "$INSTALL_DIR" 2>/dev/null; then
    [ -r "$INSTALL_DIR/VERSION" ] && FETCHED_VERSION="$(head -1 "$INSTALL_DIR/VERSION" 2>/dev/null | tr -d '[:space:]')"
  else
    fetch_tarball || die "could not fetch the StreamHub source (git: $REPO_URL, tarball: $SRC_URL)"
  fi
fi
cd "$INSTALL_DIR"
[ -f docker-compose.yml ] || die "source fetch incomplete — docker-compose.yml missing in $INSTALL_DIR"

# App folder layout now that the source is in place (bin/ CLI, logs/, backups/).
# For a fresh install this is also where teeing to the log begins (the dir now
# exists, so we no longer risk breaking the earlier `git clone`).
mkdir -p "$INSTALL_DIR/bin" "$INSTALL_DIR/logs" "$INSTALL_DIR/backups" 2>/dev/null || true
setup_install_log

# ---- 3b. version decision: fresh vs upgrade vs up-to-date --------------------
# TARGET = the VERSION bundled in the source we just fetched (FETCHED_VERSION —
# the fetch deliberately does NOT write $INSTALL_DIR/VERSION). INSTALLED was
# captured BEFORE the fetch. Decide the plan and, for an upgrade, take a
# pre-upgrade DB backup NOW — before the rebuild/restart that boots the core and
# applies migrations (the only moment the DBs mutate). VERSION on disk stays at
# the RUNNING (old) value until the post-health stamp in section 5b, so a failed
# build leaves the old VERSION and a re-run retries the upgrade.
TARGET_VERSION="${FETCHED_VERSION:-}"
# Fallback: if the source carried no VERSION (older tarball), read whatever is on
# disk; absent ⇒ 0.0.0.
if [ -z "$TARGET_VERSION" ]; then
  [ -r "$INSTALL_DIR/VERSION" ] && TARGET_VERSION="$(head -1 "$INSTALL_DIR/VERSION" 2>/dev/null | tr -d '[:space:]')"
fi
[ -n "$TARGET_VERSION" ] || TARGET_VERSION="0.0.0"

DO_UPGRADE=0
BACKUP_DIR=""
UV_BEFORE="n/a"
# env_get is defined later (section 4); read the one value we need directly.
DATA_HOST_DIR_EARLY="$(grep -E '^STREAMHUB_HOST_DATA_DIR=' "$INSTALL_DIR/.env" 2>/dev/null | head -1 | cut -d= -f2- || true)"
: "${DATA_HOST_DIR_EARLY:=./data}"

if [ "$EXISTING_INSTALL" = "0" ]; then
  log "fresh install → v${TARGET_VERSION}"
elif [ "$FORCE_REINSTALL" = "1" ]; then
  DO_UPGRADE=1
  log "--force-reinstall: re-running upgrade steps at v${TARGET_VERSION} (installed: ${INSTALLED_VERSION})"
elif ver_gt "$TARGET_VERSION" "$INSTALLED_VERSION"; then
  DO_UPGRADE=1
  log "UPGRADE detected: ${INSTALLED_VERSION} → ${TARGET_VERSION}"
else
  # INSTALLED >= TARGET: idempotent re-run. Reconcile services, don't back up.
  ok "already at v${INSTALLED_VERSION} (target v${TARGET_VERSION}) — up to date; reconciling services only."
fi

if [ "$DO_UPGRADE" = "1" ] && [ "$MODE" = "origin" ]; then
  BACKUP_DIR="$INSTALL_DIR/backups/$(date -u +%Y%m%dT%H%M%SZ)-v${INSTALLED_VERSION}"
  UV_BEFORE="$(sqlite_user_version "$DATA_HOST_DIR_EARLY/data/streamhub.db")"
  log "pre-upgrade backup (global user_version=${UV_BEFORE}) → $BACKUP_DIR"
  backup_databases "$BACKUP_DIR" "$DATA_HOST_DIR_EARLY" \
    || warn "pre-upgrade DB backup reported an issue — review before proceeding"
fi

# ---- 3c. --prepare-image: bake the images, then stop -------------------------
# Everything that is slow and secret-free: pull the pinned stack images and build
# the core image (its layers stay in the Docker cache, so the first boot's
# `compose up --build` is a cache hit). NO .env is left behind (compose needs the
# env_file to exist while it parses, so an empty one lives only for this step),
# nothing is started and the install-id/telemetry never run — every instance
# booted from the image generates its own secrets on first boot.
if [ "$PREPARE_IMAGE" = "1" ]; then
  log "--prepare-image: pre-pulling the stack images + pre-building the core (v${TARGET_VERSION})"
  [ "$TARGET_VERSION" != "0.0.0" ] && printf '%s\n' "$TARGET_VERSION" > VERSION
  TMP_ENV=0
  [ -e .env ] || { : > .env; TMP_ENV=1; }
  PREP_OK=1
  # caddy is pulled even for an nginx image (small) so first boot can pick either.
  # (the empty LiveKit keys only silence compose's "variable is not set" noise)
  LIVEKIT_API_KEY="" LIVEKIT_API_SECRET="" \
    docker compose --profile caddy pull -q redis livekit ingress egress caddy || PREP_OK=0
  if [ "$PREP_OK" = "1" ]; then
    LIVEKIT_API_KEY="" LIVEKIT_API_SECRET="" docker compose build core || PREP_OK=0
  fi
  [ "$TMP_ENV" = "1" ] && rm -f .env
  [ "$PREP_OK" = "1" ] || die "--prepare-image: image pull/build failed (see above)"
  # STREAMHUB_IMAGE_CHANNEL (Packer: marketplace-<builder>) becomes the telemetry
  # channel of the first boot's install ping → installs counted per channel.
  IMG_CH="$(printf '%s' "${STREAMHUB_IMAGE_CHANNEL:-image}" | tr -cd 'A-Za-z0-9._-')"
  ( umask 022; printf 'STREAMHUB_IMAGE_VERSION=%s\nSTREAMHUB_IMAGE_PROXY=%s\nSTREAMHUB_IMAGE_CHANNEL=%s\nSTREAMHUB_IMAGE_BUILT=%s\n' \
      "$TARGET_VERSION" "$PROXY" "${IMG_CH:-image}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$IMAGE_MARKER" )
  ok "image prepared: v${TARGET_VERSION}, proxy=${PROXY} — no .env/secrets written, nothing started."
  ok "first boot: $INSTALL_DIR/first-boot.sh (or install.sh --domain … --email …) installs from the baked source."
  exit 0
fi

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
env_del() { # env_del KEY  (drop the key; no-op when absent)
  grep -qE "^$1=" .env 2>/dev/null || return 0
  { grep -vE "^$1=" .env > .env.tmp || true; }
  mv .env.tmp .env
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

  # A bare IP can't get a Let's Encrypt cert → treat it as --no-tls so we don't
  # advertise broken wss://<ip> / https://<ip> URLs and don't attempt certbot.
  if [ "$STREAMHUB_DOMAIN" != "localhost" ] && is_ip "$STREAMHUB_DOMAIN" && [ "$NO_TLS" != "1" ]; then
    warn "domain '$STREAMHUB_DOMAIN' is an IP — TLS/Let's Encrypt not possible; using plain HTTP (--no-tls implied)."
    NO_TLS=1
  fi

  if [ "$STREAMHUB_DOMAIN" = "localhost" ]; then
    PUBLIC_WS_URL="ws://127.0.0.1:7880"; RTMP_PUBLIC_HOST="127.0.0.1"; PUBLIC_URL="http://127.0.0.1:3020"
  elif [ "$NO_TLS" = "1" ]; then
    # No TLS (IP-only, or behind your own LB): LiveKit signaling is reached
    # directly on :7880 (no proxy bridges wss→ws); the core/SPA is fronted by
    # nginx/caddy on :80. Plain ws/http so the advertised URLs actually resolve.
    PUBLIC_WS_URL="ws://$STREAMHUB_DOMAIN:7880"; RTMP_PUBLIC_HOST="$STREAMHUB_DOMAIN"; PUBLIC_URL="http://$STREAMHUB_DOMAIN"
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
  # "on" from the start — the tenancy guard's own code default is "on"; a
  # fresh install must not silently ship in log-only (audit found an
  # app-scoped token could read/write another tenant's app under "log").
  env_put STREAMHUB_AUTHZ_ENFORCE "on"
  env_set STREAMHUB_PUBLIC_URL    "$PUBLIC_URL"
  env_set STREAMHUB_APP_URL       "$PUBLIC_URL"
  # --no-plugins: ship a bare media server. Turn the plugin framework off in the
  # core (empty catalog, plugin routes 404, no worker spawns) and skip baking the
  # deface worker deps into the image (INSTALL_DEFACE_WORKER read by the compose
  # build). Only written when the flag is passed; unset = the default (plugins on).
  if [ "$NO_PLUGINS" = "1" ]; then
    env_set STREAMHUB_PLUGINS_ENABLE "false"
    env_set INSTALL_DEFACE_WORKER    "0"
    env_set INSTALL_VENDORED_WORKER_DEPS "0"
  fi
  # Caddy site address: unset → the compose default is the bare domain (auto-TLS,
  # unchanged). Under --no-tls we force the http:// scheme so Caddy serves plain
  # HTTP instead of trying to provision a cert it can't get / you don't want.
  if [ "$PROXY" = "caddy" ] && [ "$NO_TLS" = "1" ]; then
    env_set STREAMHUB_SITE_ADDRESS "http://$STREAMHUB_DOMAIN"
  fi
  # The compose `caddy` service only runs under its profile: list it in
  # COMPOSE_PROFILES (compose reads it from .env, so a raw `docker compose up -d`
  # does the right thing) on a caddy origin, and strip it on an nginx one —
  # where Caddy used to crash-loop against nginx on :80. Other profiles kept.
  _profiles=""
  IFS=',' read -r -a _plist <<<"$(env_get COMPOSE_PROFILES)"
  for _p in ${_plist[@]+"${_plist[@]}"}; do
    _p="$(printf '%s' "$_p" | tr -d '[:space:]')"
    [ -n "$_p" ] && [ "$_p" != "caddy" ] && _profiles="${_profiles:+$_profiles,}$_p"
  done
  [ "$PROXY" = "caddy" ] && _profiles="caddy${_profiles:+,$_profiles}"
  if [ -n "$_profiles" ]; then env_set COMPOSE_PROFILES "$_profiles"; else env_del COMPOSE_PROFILES; fi
  # TURN relay seams (compose reads STREAMHUB_TURN_ENABLE/_DOMAIN/_CERT_DIR). Only
  # written when enabled — otherwise .env stays untouched and the compose default
  # keeps enabled:false (zero behavior change). TURN needs a real TLS domain, so
  # localhost / an IP / --no-tls disable it with a warn. Caddy/join were
  # neutralized above.
  #
  # ORDERING: LiveKit loads cert_file at BOOT, so enabling TURN before the cert
  # exists would crash it. On a FRESH enable we write DOMAIN + CERT_DIR but keep
  # ENABLE=false; the certbot block below obtains the cert, then flips ENABLE=true
  # and recreates livekit. A re-run/upgrade where the cert already exists enables
  # it straight away.
  if [ "$TURN_ENABLE" = "1" ]; then
    if [ "$STREAMHUB_DOMAIN" = "localhost" ] || is_ip "$STREAMHUB_DOMAIN" || [ "$NO_TLS" = "1" ]; then
      warn "TURN needs a real domain with TLS (domain='$STREAMHUB_DOMAIN', no_tls=$NO_TLS) — skipping TURN."
      TURN_ENABLE=0
    else
      [ -n "$TURN_DOMAIN" ] || TURN_DOMAIN="turn.$STREAMHUB_DOMAIN"
      env_set STREAMHUB_TURN_DOMAIN   "$TURN_DOMAIN"
      env_set STREAMHUB_TURN_CERT_DIR "/etc/letsencrypt"
      if [ -r "/etc/letsencrypt/live/$TURN_DOMAIN/fullchain.pem" ]; then
        env_set STREAMHUB_TURN_ENABLE "true"
        ok "TURN enabled → turn:$TURN_DOMAIN:5349 (TLS) + :3478/udp (cert present)."
      else
        env_set STREAMHUB_TURN_ENABLE "false"
        ok "TURN will enable after its cert is issued → turn:$TURN_DOMAIN (see the certbot step below)."
      fi
    fi
  fi
  # Samples origin: only written when asked for — unset keeps samples on the
  # dashboard origin (and sample:write superadmin-only), zero behavior change.
  if [ -n "$SAMPLES_DOMAIN" ]; then
    if [ "$STREAMHUB_DOMAIN" = "localhost" ] || is_ip "$SAMPLES_DOMAIN" || [ "$SAMPLES_DOMAIN" = "$STREAMHUB_DOMAIN" ]; then
      warn "--samples-domain needs its own DNS name, distinct from the dashboard's (got '$SAMPLES_DOMAIN') — skipping."
    else
      SAMPLES_SCHEME="https"; [ "$NO_TLS" = "1" ] && SAMPLES_SCHEME="http"
      env_set STREAMHUB_SAMPLES_URL "$SAMPLES_SCHEME://$SAMPLES_DOMAIN"
      # Caddy site address (compose → SAMPLES_SITE_ADDRESS): bare = auto-TLS.
      if [ "$NO_TLS" = "1" ]; then env_set SAMPLES_DOMAIN "http://$SAMPLES_DOMAIN"; else env_set SAMPLES_DOMAIN "$SAMPLES_DOMAIN"; fi
      ok "samples origin → $SAMPLES_SCHEME://$SAMPLES_DOMAIN"
    fi
  fi
  env_put STREAMHUB_CLUSTER_TOKEN "clt_$(rand 32)"
  env_put DATA_DIR                "/data"
  env_put STREAMHUB_HOST_DATA_DIR "./data"
  env_put LOG_LEVEL               "info"
  env_put NODE_ENV                "production"
  # MediaMTX single-port :1935 RTMP front (opt-in, --mediamtx / STREAMHUB_MEDIAMTX_ENABLE).
  # Generate the shared hook secret (env_put = never rotated on re-run), flag the
  # core on, and move the LiveKit ingress to the INTERNAL :11935 so MediaMTX can
  # own the public :1935. The binary + systemd unit are installed later
  # (install_mediamtx, once the core is healthy). env_set so re-runs reconcile.
  if [ "$MEDIAMTX_ENABLE" = "1" ]; then
    env_put STREAMHUB_MEDIAMTX_HOOK_SECRET      "mtx_$(rand 40)"
    env_set STREAMHUB_MEDIAMTX_ENABLE           "true"
    env_set STREAMHUB_MEDIAMTX_RTMP_PORT        "1935"
    env_set STREAMHUB_LIVEKIT_INGRESS_RTMP_PORT "11935"
  fi
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
  # Per-node credential (3.3.4+): the cluster token is only the JOIN secret.
  # The master answers the join with this node's own nodeSecret, which is what
  # gets stored (.env + edge.env + heartbeat.env) — the cluster token is NOT
  # kept on the node. A re-run without --cluster-token therefore reuses the
  # existing join instead of re-registering (pass the token to re-register).
  NODE_SECRET="$(env_get STREAMHUB_NODE_SECRET)"
  NODE_ID="$(env_get STREAMHUB_NODE_ID)"
  if [ -z "$CLUSTER_TOKEN" ] && [ -z "$NODE_SECRET" ]; then
    die "--join needs --cluster-token (see the origin's install summary or its .env STREAMHUB_CLUSTER_TOKEN)"
  fi
  [ -n "$ORIGIN_IP" ]     || die "--join needs --origin-ip <ip-of-origin>"

  # Join target(s). The core binds 127.0.0.1:3020 — only the reverse proxy
  # (nginx/caddy) listens publicly, on :80/:443 — so the DEFAULT target is the
  # proxy on :80, NOT :3020 (that default was the AWS-POC2 finding #1 failure).
  # An explicit --origin-url wins outright; otherwise we try :80 then fall back
  # to :3020 for exotic setups that expose the core port directly.
  if [ -n "$ORIGIN_URL" ]; then
    JOIN_CANDIDATES=("$ORIGIN_URL")
  else
    JOIN_CANDIDATES=("http://$ORIGIN_IP" "http://$ORIGIN_IP:3020")
  fi

  # Re-run guard: a fully-configured edge must survive an origin that is down
  # or a rotated token — re-register when we can, keep working when we can't.
  ALREADY_JOINED=0
  if [ -n "$(env_get LIVEKIT_API_KEY)" ] && [ -n "$(env_get LIVEKIT_REDIS_ADDRESS)" ]; then
    ALREADY_JOINED=1
  fi
  # A CDN edge holds no LiveKit keys: its join record is the node id + secret.
  if [ "$CDN_EDGE" = "1" ] && [ -n "$NODE_ID" ] && [ -n "$(env_get STREAMHUB_CDN_ORIGIN_URL)" ]; then
    ALREADY_JOINED=1
  fi

  MY_IP="$(curl -fsS -m5 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')"
  JOIN_BODY=$(printf '{"name":"%s","ip":"%s","region":"%s","type":"%s"}' "$NODE_NAME" "$MY_IP" "$REGION" "$NODE_TYPE")
  if [ "$CDN_EDGE" = "1" ]; then
    # The public base URL viewers fetch /hls from (registered as the node `url`):
    # --edge-url, else what a previous run stored, else http://<public IP>.
    [ -n "$EDGE_URL" ] || EDGE_URL="$(env_get STREAMHUB_CDN_EDGE_URL)"
    [ -n "$EDGE_URL" ] || EDGE_URL="http://$MY_IP"
    EDGE_URL="$(norm_base_url "$EDGE_URL")" || die "--edge-url must be http(s)://host[:port] (got '$EDGE_URL')"
    # The master hands this URL to players: an http:// edge is blocked as mixed
    # content on an https page (and an IP can't carry a public TLS cert).
    if [[ "$EDGE_URL" == http://* ]]; then
      warn "edge URL $EDGE_URL is plain http: players on an https page (the dashboard, your site) block it as mixed content."
      warn "  Prefer --edge-url https://<public-name> (DNS → this host, TLS on the edge or an LB in front)."
    fi
    env_set STREAMHUB_CDN_EDGE_URL "$EDGE_URL"
    JOIN_BODY=$(printf '{"name":"%s","ip":"%s","region":"%s","type":"%s","url":"%s"}' "$NODE_NAME" "$MY_IP" "$REGION" "$NODE_TYPE" "$EDGE_URL")
  fi

  # Try each candidate: a connection-class failure moves to the next; an HTTP
  # error (server reachable but rejected — bad token) stops and is reported.
  JOIN_OK=0
  JOIN_RESP=""
  API_BASE=""
  if [ -z "$CLUSTER_TOKEN" ]; then
    # Re-run of a 3.3.4+ join: no cluster token on record, only the node
    # secret — skip the registration and keep the stored join (the heartbeat
    # agent's URL is the master base this node registered against).
    JOIN_CANDIDATES=()
    JOIN_RESP="no --cluster-token given (only the per-node secret is kept on the node) — pass --cluster-token to re-register"
    [ -r /etc/streamhub/heartbeat.env ] && API_BASE="$(sed -n 's/^STREAMHUB_HB_URL=//p' /etc/streamhub/heartbeat.env | head -1)"
    [ -n "$API_BASE" ] || API_BASE="${ORIGIN_URL:-http://$ORIGIN_IP}"
  fi
  for cand in ${JOIN_CANDIDATES[@]+"${JOIN_CANDIDATES[@]}"}; do
    log "registering node '$NODE_NAME' on the origin ($cand)"
    rc=0
    JOIN_RESP=$(curl -fsS -m15 -X POST "$cand/api/v1/cluster/join" \
        -H "Content-Type: application/json" -H "X-Cluster-Token: $CLUSTER_TOKEN" \
        -d "$JOIN_BODY" 2>&1) || rc=$?
    if [ "$rc" = "0" ]; then API_BASE="$cand"; JOIN_OK=1; break; fi
    case "$rc" in
      6|7|28|35|56)  # resolve/connect/timeout/TLS/recv — try the next candidate
        warn "could not connect to $cand (curl exit $rc) — trying the next join target…" ;;
      *)             # reachable but rejected (e.g. HTTP 401/403) — stop here
        API_BASE="$cand"; break ;;
    esac
  done
  [ -n "$API_BASE" ] || API_BASE="${JOIN_CANDIDATES[0]}"

  if [ "$JOIN_OK" = "0" ]; then
    [ -n "$CLUSTER_TOKEN" ] || [ "$ALREADY_JOINED" = "1" ] || die "$JOIN_RESP"
    if [ "$ALREADY_JOINED" = "1" ]; then
      warn "cluster join call failed ($API_BASE) — node was already joined, reusing the existing .env. Response: $JOIN_RESP"
    else
      die "cluster join failed (tried: ${JOIN_CANDIDATES[*]}) — check --cluster-token and that the origin's proxy is reachable (default target is http://$ORIGIN_IP on :80; pass --origin-url to override). Response: $JOIN_RESP"
    fi
  else
    # jget KEY → the string value of "KEY" in the join response ('' when absent
    # or null). Pure sed — the core binary isn't on this host yet, and no
    # python3/jq is needed. The keys are unique in the payload
    # ({data:{nodeId,name,redisUrl,publicWsUrl,livekit:{apiKey,apiSecret,wsUrl},nodeSecret}});
    # unescapes what Go's encoder emits for these values (\" \\ \/ & < >).
    jget() {
      printf '%s' "$JOIN_RESP" | tr -d '\n' \
        | sed -nE 's/.*"'"$1"'"[[:space:]]*:[[:space:]]*"(([^"\\]|\\.)*)".*/\1/p' | head -n1 \
        | sed -e 's/\\u0026/\&/g' -e 's/\\u003c/</g' -e 's/\\u003e/>/g' -e 's/\\\//\//g' -e 's/\\"/"/g' -e 's/\\\\/\\/g' || true
    }
    LK_KEY="$(jget apiKey)"
    LK_SECRET="$(jget apiSecret)"
    REDIS_FROM_ORIGIN="$(jget redisUrl)"
    NODE_ID="$(jget nodeId)"
    # This node's own credential (heartbeat, edge WS, grid). A pre-3.3.4
    # master vends none: the node then keeps using the cluster token (legacy).
    NODE_SECRET="$(jget nodeSecret)"
    if [ -n "$NODE_SECRET" ]; then
      env_set STREAMHUB_NODE_SECRET "$NODE_SECRET"
      [ -n "$NODE_ID" ] && env_set STREAMHUB_NODE_ID "$NODE_ID"
    else
      warn "origin vended no nodeSecret (core < 3.3.4) — this node keeps the shared cluster token (legacy); re-run with --cluster-token after upgrading the origin"
    fi
    if [ "$CDN_EDGE" = "1" ]; then
      # nginx-only node: keep NO LiveKit keys / redis URL here (least privilege).
      [ -n "$NODE_ID" ] || die "origin did not return a nodeId for the cdn-edge join — is its core up to date (cdn-edge node type)? Response: $JOIN_RESP"
      env_set STREAMHUB_NODE_ID "$NODE_ID"
      ok "registered as CDN edge '$NODE_NAME' (id: $NODE_ID, url: $EDGE_URL)"
    elif [ -z "$LK_KEY" ] || [ -z "$LK_SECRET" ]; then
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

  # What this node authenticates with from now on: its own secret, or — only
  # against a pre-3.3.4 origin — the shared cluster token (legacy).
  NODE_CRED="${NODE_SECRET:-$CLUSTER_TOKEN}"

  env_put DATA_DIR           "/data"
  env_put STREAMHUB_HOST_DATA_DIR "./data"
  env_put STREAMHUB_DOMAIN   "join-$NODE_NAME"
  env_put ACME_EMAIL         "none@localhost"
  if [ "$CDN_EDGE" = "1" ]; then
    # Where nginx pulls /hls from: --cdn-origin-url, else the stored one, else the
    # master base the join just used (the origin's proxy, which serves /hls).
    [ -n "$CDN_ORIGIN_URL" ] || CDN_ORIGIN_URL="$(env_get STREAMHUB_CDN_ORIGIN_URL)"
    [ -n "$CDN_ORIGIN_URL" ] || CDN_ORIGIN_URL="$API_BASE"
    CDN_ORIGIN_URL="$(norm_base_url "$CDN_ORIGIN_URL")" || die "--cdn-origin-url must be http(s)://host[:port] (got '$CDN_ORIGIN_URL')"
    env_set STREAMHUB_CDN_ORIGIN_URL "$CDN_ORIGIN_URL"
    [ -n "$EDGE_CACHE_TMPFS" ] || EDGE_CACHE_TMPFS="$(env_get STREAMHUB_EDGE_CACHE_TMPFS)"
    case "${EDGE_CACHE_TMPFS:-off}" in off|none|0|'') EDGE_CACHE_TMPFS="off" ;; esac
    env_set STREAMHUB_EDGE_CACHE_TMPFS "$EDGE_CACHE_TMPFS"
    ok ".env ready (CDN edge — pulls /hls from $CDN_ORIGIN_URL, serves $(env_get STREAMHUB_CDN_EDGE_URL))"
  else
    ok ".env ready (edge node — shares the origin's Redis at $(env_get LIVEKIT_REDIS_ADDRESS))"
  fi
fi

# ---- 4a. LiveKit advertised IP (cloud 1:1 NAT) — origin + common joins -------
# auto: detect (detect_nat_ips) and, behind a 1:1 NAT, pin node_ip to the private
# IP with use_external_ip=false; a run that detects nothing keeps what an earlier
# run wrote (a transient metadata blip must not flip LiveKit back). off: STUN
# public-IP detection (the compose default). <ip>: forced. Nodes without LiveKit
# (cdn-edge, Vision edge) skip it.
apply_node_ip() {
  local det nip npub nsrc
  case "$NODE_IP_MODE" in
    off)
      if [ -n "$(env_get LIVEKIT_NODE_IP)" ] || [ "$(env_get LIVEKIT_USE_EXTERNAL_IP)" = "false" ]; then
        log "--node-ip off: LiveKit back to use_external_ip (STUN public-IP detection)"
      fi
      env_del LIVEKIT_NODE_IP; env_del LIVEKIT_USE_EXTERNAL_IP ;;
    auto)
      det="$(detect_nat_ips)"
      if [ -n "$det" ]; then
        read -r nip npub nsrc <<<"$det"
        env_set LIVEKIT_USE_EXTERNAL_IP "false"
        env_set LIVEKIT_NODE_IP         "$nip"
        warn "1:1 NAT detected ($nsrc: public $npub is not on any interface) → LiveKit node_ip=$nip, use_external_ip=false."
        warn "  Egress/ingress and nodes in the private network reach LiveKit; WebRTC clients outside it need TURN (--turn) or a VPN."
        warn "  Override: --node-ip <ip>, or --node-ip off to keep STUN public-IP detection."
      elif [ -n "$(env_get LIVEKIT_NODE_IP)" ]; then
        log "no 1:1 NAT detected this run — keeping LIVEKIT_NODE_IP=$(env_get LIVEKIT_NODE_IP) from a previous run (--node-ip off resets)"
      else
        log "no cloud 1:1 NAT detected — LiveKit keeps use_external_ip (STUN)"
      fi ;;
    *)
      env_set LIVEKIT_USE_EXTERNAL_IP "false"
      env_set LIVEKIT_NODE_IP         "$NODE_IP_MODE"
      ok "LiveKit node_ip=$NODE_IP_MODE, use_external_ip=false (--node-ip)" ;;
  esac
}
if [ "$MODE" = "origin" ] || [ "$NODE_TYPE" = "common" ]; then apply_node_ip; fi

DATA_HOST_DIR="$(env_get STREAMHUB_HOST_DATA_DIR)"
if [ "$CDN_EDGE" != "1" ]; then   # a CDN edge has no data dir / egress (nginx only)
  mkdir -p "${DATA_HOST_DIR:-./data}/apps"
  # We run under umask 077 (for .env) — that would leave data/ mode 700 and the
  # egress worker (uid 1001, gid 0) could not even traverse it to write HLS/MP4s.
  # 755 restores traversal; g+rwX on apps/ lets egress write AND traverse (core
  # creates new dirs group-writable itself via umask 002 in its entrypoint, but
  # dirs made by older cores — and edge nodes, which run no core — need this).
  chmod 755 "${DATA_HOST_DIR:-./data}"
  chmod -R g+rwX "${DATA_HOST_DIR:-./data}/apps" 2>/dev/null || true

  # ---- 4b. egress CPU cap: clamp to the host (both origin + edge) --------------
  # livekit-egress refuses room-composite (HLS/recording) below 4 available CPUs,
  # so the compose default is EGRESS_CPUS=4 — but `cpus: 4` HARD-FAILS
  # `docker compose up` on a host with fewer vCPUs ("range of CPUs is 0.01 to N"),
  # killing the install mid-join on a 2-vCPU edge. Clamp to min(4, nproc): below 4
  # the egress self-reports insufficient CPU and simply never claims room-composite
  # jobs (correct degraded behavior — live playback/WebRTC/ingest are unaffected).
  # env_put = fill-if-missing, so an operator's explicit EGRESS_CPUS is respected.
  CPU_COUNT="$(nproc 2>/dev/null || echo 1)"
  case "$CPU_COUNT" in ''|*[!0-9]*) CPU_COUNT=1 ;; esac
  [ "$CPU_COUNT" -ge 1 ] || CPU_COUNT=1
  if [ "$CPU_COUNT" -lt 4 ]; then EGRESS_CPUS_VAL="$CPU_COUNT"; else EGRESS_CPUS_VAL=4; fi
  env_put EGRESS_CPUS "$EGRESS_CPUS_VAL"
  [ "$EGRESS_CPUS_VAL" -lt 4 ] && warn "host has ${CPU_COUNT} vCPU(s) — EGRESS_CPUS=${EGRESS_CPUS_VAL} (<4: egress declines HLS/recording room-composite; live playback/WebRTC unaffected)."
fi

# ---- nginx limits (origin nginx + CDN edge) -----------------------------------
# Ubuntu/Debian ship worker_connections 768 — a CDN edge (or an origin serving
# viewers directly) runs out of connections long before CPU/NIC. Raise it (only
# upwards; the original value is kept in $NGINX_WC_ORIG so uninstall.sh can put
# it back) plus worker_rlimit_nofile (marked '# streamhub-tuning') and a systemd
# LimitNOFILE drop-in. Applies on the next reload (workers set their own rlimit).
NGINX_WORKER_CONNECTIONS="${STREAMHUB_NGINX_WORKER_CONNECTIONS:-65535}"
NGINX_WC_ORIG=/etc/nginx/.streamhub-worker-connections.orig
tune_nginx_limits() {
  local conf=/etc/nginx/nginx.conf want="$NGINX_WORKER_CONNECTIONS" cur
  case "$want" in ''|*[!0-9]*) want=65535 ;; esac
  [ -w "$conf" ] || { warn "$conf not writable — nginx limits not tuned"; return 0; }
  cur="$(sed -n 's/^[[:space:]]*worker_connections[[:space:]]\{1,\}\([0-9]\{1,\}\);.*/\1/p' "$conf" | head -1)"
  if [ -z "$cur" ]; then
    warn "no worker_connections line in $conf — not tuned"
  elif [ "$cur" -lt "$want" ]; then
    [ -e "$NGINX_WC_ORIG" ] || printf '%s\n' "$cur" > "$NGINX_WC_ORIG"
    sed -i -E "s/^([[:space:]]*worker_connections[[:space:]]+)[0-9]+;/\1$want;/" "$conf"
    log "nginx: worker_connections $cur → $want"
  fi
  if ! grep -qE '^[[:space:]]*worker_rlimit_nofile[[:space:]]' "$conf"; then
    # main context: right after worker_processes (or as the first line).
    if grep -qE '^[[:space:]]*worker_processes[[:space:]]' "$conf"; then
      awk -v l="worker_rlimit_nofile $(( want * 2 ));  # streamhub-tuning" \
        '{print} !d && /^[[:space:]]*worker_processes[[:space:]]/{print l; d=1}' "$conf" > "$conf.streamhub.tmp"
    else
      { printf 'worker_rlimit_nofile %s;  # streamhub-tuning\n' "$(( want * 2 ))"; cat "$conf"; } > "$conf.streamhub.tmp"
    fi
    cat "$conf.streamhub.tmp" > "$conf" && rm -f "$conf.streamhub.tmp"
    log "nginx: worker_rlimit_nofile $(( want * 2 ))"
  fi
  if command -v systemctl >/dev/null 2>&1; then
    mkdir -p /etc/systemd/system/nginx.service.d
    printf '# StreamHub (install.sh): file descriptors for many concurrent viewers.\n[Service]\nLimitNOFILE=%s\n' \
      "$(( want * 4 ))" > /etc/systemd/system/nginx.service.d/streamhub-limits.conf
    systemctl daemon-reload >/dev/null 2>&1 || true
  fi
}

# ---- CDN edge: nginx HLS cache (--cdn-edge nodes only) ------------------------
# Renders the repo's deploy/nginx-hls-edge.conf (the source of truth for the
# cache policy — only its two `>>>` markers are filled: the origin URL and the
# server_name) into conf.d, adds a 127.0.0.1-only stub_status for the heartbeat,
# drops nginx's default site and optionally puts the cache dir on tmpfs.
# Idempotent: everything is rewritten each run; a template that no longer
# carries the markers aborts instead of shipping example.com.
CDN_EDGE_CONF=/etc/nginx/conf.d/streamhub-hls-edge.conf
CDN_STATUS_CONF=/etc/nginx/conf.d/streamhub-stub-status.conf
CDN_STATUS_LISTEN="127.0.0.1:18081"
CDN_CACHE_DIR=""
CDN_FSTAB_TAG="# streamhub-cdn-edge cache (install.sh --edge-cache-tmpfs)"
size_to_mib() { # 4g / 2048m / 4G → MiB on stdout; fails on anything else or < 64m
  local v="${1,,}" n
  [[ "$v" =~ ^([0-9]+)([mg])$ ]] || return 1
  n="${BASH_REMATCH[1]}"; [ "${BASH_REMATCH[2]}" = "g" ] && n=$(( n * 1024 ))
  [ "$n" -ge 64 ] || return 1
  printf '%s' "$n"
}
install_cdn_edge() {
  local tpl="$INSTALL_DIR/deploy/nginx-hls-edge.conf" tmp sname host ngx_user uid gid mib="" opts
  [ -r "$tpl" ] || die "deploy/nginx-hls-edge.conf missing from the source — cannot configure the CDN edge"
  if [ "$EDGE_CACHE_TMPFS" != "off" ]; then
    mib="$(size_to_mib "$EDGE_CACHE_TMPFS")" || die "--edge-cache-tmpfs must be a size like 4g or 2048m (≥64m), or off (got '$EDGE_CACHE_TMPFS')"
  fi
  # server_name: the --edge-url host when it's a name; a catch-all for an IP.
  host="${EDGE_URL#*://}"; host="${host%%/*}"
  case "$host" in \[*) host="" ;; *) host="${host%%:*}" ;; esac
  if [ -n "$host" ] && ! is_ip "$host"; then sname="$host"; else sname="_"; fi
  CDN_CACHE_DIR="$(sed -n 's/^[[:space:]]*proxy_cache_path[[:space:]]\{1,\}\([^[:space:];]\{1,\}\).*/\1/p' "$tpl" | head -1)"
  : "${CDN_CACHE_DIR:=/var/cache/nginx/hls}"

  tmp="$(mktemp)"
  sed -E -e "s#https?://origin\.example\.com#$CDN_ORIGIN_URL#g" \
         -e "s#^([[:space:]]*server_name[[:space:]]+)edge\.example\.com;#\1$sname;#" "$tpl" > "$tmp"
  # tmpfs cache: keep nginx's max_size under the tmpfs size, or the cache fills
  # RAM to ENOSPC before the cache manager evicts anything.
  [ -n "$mib" ] && sed -i -E "s/max_size=[0-9]+[kKmMgG]?/max_size=$(( mib * 9 / 10 ))m/" "$tmp"
  if grep -vE '^[[:space:]]*#' "$tmp" | grep -qE '(origin|edge)\.example\.com' \
     || ! grep -vE '^[[:space:]]*#' "$tmp" | grep -qF "$CDN_ORIGIN_URL"; then
    rm -f "$tmp"
    die "deploy/nginx-hls-edge.conf no longer carries the expected markers (https://origin.example.com / server_name edge.example.com) — update install_cdn_edge"
  fi

  ngx_user="$(awk '$1=="user"{gsub(";","",$2); print $2; exit}' /etc/nginx/nginx.conf 2>/dev/null)"; : "${ngx_user:=www-data}"
  uid="$(id -u "$ngx_user" 2>/dev/null || echo 0)"; gid="$(id -g "$ngx_user" 2>/dev/null || echo 0)"
  # umask 022: the installer runs under 077 (for .env) — a 700 parent would
  # stop the nginx worker from even traversing to the cache (open() EACCES → 500).
  ( umask 022; mkdir -p "$CDN_CACHE_DIR" )
  chmod o+x "$(dirname "$CDN_CACHE_DIR")" 2>/dev/null || true

  # Cache on tmpfs (opt-in): one fstab line (tagged) so it survives reboots.
  if [ -w /etc/fstab ]; then
    { grep -vxF "$CDN_FSTAB_TAG" /etc/fstab | grep -vE "^tmpfs[[:space:]]+${CDN_CACHE_DIR}[[:space:]]" || true; } > /etc/fstab.streamhub.tmp
    if [ -n "$mib" ]; then
      opts="rw,nosuid,nodev,noexec,size=${mib}m,mode=0700,uid=$uid,gid=$gid"
      printf '%s\ntmpfs %s tmpfs %s 0 0\n' "$CDN_FSTAB_TAG" "$CDN_CACHE_DIR" "$opts" >> /etc/fstab.streamhub.tmp
    fi
    cat /etc/fstab.streamhub.tmp > /etc/fstab && rm -f /etc/fstab.streamhub.tmp
  fi
  if [ -n "$mib" ]; then
    if mountpoint -q "$CDN_CACHE_DIR" 2>/dev/null; then
      mount -o "remount,size=${mib}m" "$CDN_CACHE_DIR" 2>/dev/null || warn "could not resize the tmpfs at $CDN_CACHE_DIR"
    else
      mount "$CDN_CACHE_DIR" 2>/dev/null || warn "could not mount tmpfs at $CDN_CACHE_DIR — the cache stays on disk until the next boot"
    fi
    mountpoint -q "$CDN_CACHE_DIR" 2>/dev/null && ok "HLS cache on tmpfs ($EDGE_CACHE_TMPFS at $CDN_CACHE_DIR, nginx max_size $(( mib * 9 / 10 ))m)"
  elif mountpoint -q "$CDN_CACHE_DIR" 2>/dev/null && grep -qs "^tmpfs $CDN_CACHE_DIR " /proc/mounts; then
    if umount "$CDN_CACHE_DIR" 2>/dev/null; then log "HLS cache back on disk (tmpfs at $CDN_CACHE_DIR unmounted)"; fi
  fi
  chown "$uid:$gid" "$CDN_CACHE_DIR" 2>/dev/null || true
  chmod 0700 "$CDN_CACHE_DIR" 2>/dev/null || true

  install -m 0644 "$tmp" "$CDN_EDGE_CONF"; rm -f "$tmp"
  ( umask 022; cat > "$CDN_STATUS_CONF" <<EOF
# StreamHub CDN edge — nginx stub_status for the heartbeat agent (loopback only).
server {
    listen $CDN_STATUS_LISTEN;
    server_name localhost;
    access_log off;
    location = /nginx_status {
        stub_status;
        allow 127.0.0.1;
        deny all;
    }
    location / { return 404; }
}
EOF
  )
  # The edge is the only site on :80 (nginx's default site would win the catch-all).
  rm -f /etc/nginx/sites-enabled/default
  tune_nginx_limits
  if ! nginx -t >/dev/null 2>&1; then
    nginx -t 2>&1 | tail -5 || true
    mv -f "$CDN_EDGE_CONF" "$CDN_EDGE_CONF.rejected" 2>/dev/null || true
    die "nginx rejected the CDN edge config (kept as $CDN_EDGE_CONF.rejected) — see above"
  fi
  if command -v systemctl >/dev/null 2>&1; then
    systemctl enable nginx >/dev/null 2>&1 || true
    systemctl restart nginx >/dev/null 2>&1 || warn "could not restart nginx — check: journalctl -u nginx"
  else
    nginx -s reload 2>/dev/null || nginx 2>/dev/null || warn "could not (re)start nginx"
  fi
  ok "CDN edge nginx up: /hls → $CDN_ORIGIN_URL (server_name $sname, cache $CDN_CACHE_DIR)"
}

# ---- 4c. heartbeat agent (systemd timer, every 60s) --------------------------
# Without this, a node (edge OR origin) has no periodic liveness ping and goes
# `stale=true` in the registry 90s after boot — the join / self-register is the
# ONLY latch otherwise. Ships a tiny script + a systemd service+timer that POST
# cpu/mem/cores stats to the master's /api/v1/cluster/heartbeat with the node's
# own secret (3.3.4+; the origin pings its own core with the cluster token, and
# against a pre-3.3.4 origin a joined node still uses the token). Sent as
# X-Cluster-Token, which every core version reads — a 3.3.4+ master matches
# the per-node secret there too. Idempotent: files are rewritten and the timer
# re-enabled on every run.
install_heartbeat_agent() { # install_heartbeat_agent <api_base> <credential> <node_id> [role]
  local hb_url="$1" hb_token="$2" hb_node="$3" hb_role="${4:-}" hb_every
  # A CDN edge beats every 15s (the master's least-loaded edge selection reacts
  # to audience ramps from these stats); everything else every 60s.
  hb_every="${STREAMHUB_HB_INTERVAL:-}"
  case "$hb_every" in ''|*[!0-9]*) hb_every=60; [ "$hb_role" = "cdn-edge" ] && hb_every=15 ;; esac
  if ! command -v systemctl >/dev/null 2>&1; then
    warn "systemd not available — skipping the heartbeat timer (node goes stale after 90s without an external heartbeat)"
    return 0
  fi
  mkdir -p /etc/streamhub
  # Reuse a previously-stored node id when this run couldn't determine one
  # (e.g. a re-run while the master was unreachable).
  if [ -z "$hb_node" ] && [ -r /etc/streamhub/heartbeat.env ]; then
    hb_node="$(sed -n 's/^STREAMHUB_HB_NODE_ID=//p' /etc/streamhub/heartbeat.env | head -1)"
  fi
  # …and the stored credential (a 3.3.4+ re-run keeps no cluster token).
  if [ -z "$hb_token" ] && [ -r /etc/streamhub/heartbeat.env ]; then
    hb_token="$(sed -n 's/^STREAMHUB_HB_TOKEN=//p' /etc/streamhub/heartbeat.env | head -1)"
  fi
  if [ -z "$hb_url" ] || [ -z "$hb_token" ] || [ -z "$hb_node" ]; then
    warn "heartbeat agent not configured (missing url/token/node id) — skipping"
    return 0
  fi

  ( umask 077; cat > /etc/streamhub/heartbeat.env <<EOF
STREAMHUB_HB_URL=$hb_url
STREAMHUB_HB_TOKEN=$hb_token
STREAMHUB_HB_NODE_ID=$hb_node
EOF
    # CDN edge: the agent adds nginx stub_status + NIC throughput (cdn block).
    if [ "$hb_role" = "cdn-edge" ]; then
      printf 'STREAMHUB_HB_ROLE=cdn-edge\nSTREAMHUB_HB_CDN_STATUS_URL=http://%s/nginx_status\nSTREAMHUB_HB_CDN_CACHE_DIR=%s\n' \
        "$CDN_STATUS_LISTEN" "${CDN_CACHE_DIR:-/var/cache/nginx/hls}" >> /etc/streamhub/heartbeat.env
    fi
  )

  cat > /usr/local/bin/streamhub-heartbeat.sh <<'HBEOF'
#!/usr/bin/env bash
# StreamHub cluster heartbeat — POST liveness + cpu/mem/cores stats to the master.
# Config: /etc/streamhub/heartbeat.env (STREAMHUB_HB_URL / _TOKEN / _NODE_ID).
set -eu
[ -r /etc/streamhub/heartbeat.env ] && . /etc/streamhub/heartbeat.env
: "${STREAMHUB_HB_URL:?}"; : "${STREAMHUB_HB_TOKEN:?}"; : "${STREAMHUB_HB_NODE_ID:?}"

cores="$(nproc 2>/dev/null || echo 1)"
load="$(awk '{print $1}' /proc/loadavg 2>/dev/null || echo 0)"
# cpu = load normalized by core count (comparable across differently-sized nodes)
cpu="$(awk -v l="$load" -v c="$cores" 'BEGIN{ if (c>0) printf "%.3f", l/c; else print 0 }')"
memtotal="$(awk '/^MemTotal:/{print $2}' /proc/meminfo 2>/dev/null || echo 0)"
memavail="$(awk '/^MemAvailable:/{print $2}' /proc/meminfo 2>/dev/null || echo 0)"
memused="$(awk -v t="$memtotal" -v a="$memavail" 'BEGIN{ if (t>0) printf "%.3f", (t-a)/t; else print 0 }')"

# StreamHub Grid (GRID-4): advertise a GPU as a `grid` block so the origin can
# offload plugin workers (yolo/…) here. Detected via nvidia-smi; NO grid block
# when nvidia-smi is absent (the node stays CPU-only + never grid-selectable).
# Workload capabilities default to "cuda,yolo"; override with STREAMHUB_HB_GRID_CAPS.
grid=""
if command -v nvidia-smi >/dev/null 2>&1; then
  gpu_name="$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -1 | tr -cd '[:alnum:] .-')"
  vram_mib="$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>/dev/null | head -1 | tr -cd '0-9')"
  [ -n "$vram_mib" ] || vram_mib=0
  vram_gb=$(( vram_mib / 1024 ))
  caps="$(printf '%s' "${STREAMHUB_HB_GRID_CAPS:-cuda,yolo}" | tr -cd '[:alnum:],_-')"
  [ -n "$caps" ] || caps="cuda"
  caps_json="\"$(printf '%s' "$caps" | sed 's/,/","/g')\""
  grid="$(printf ',"grid":{"gpu":true,"vramGb":%s,"gpuName":"%s","capabilities":[%s]}' \
    "$vram_gb" "$gpu_name" "$caps_json")"
fi

# CDN edge (STREAMHUB_HB_ROLE=cdn-edge): nginx stub_status (127.0.0.1 only) +
# bytes sent on the default-route NIC, and Mbps since the previous beat (state in
# /run, so a reboot just restarts the delta). Never fails the beat: any probe
# that breaks reports 0.
cdn=""
if [ "${STREAMHUB_HB_ROLE:-}" = "cdn-edge" ]; then
  st="$(curl -fsS -m3 "${STREAMHUB_HB_CDN_STATUS_URL:-http://127.0.0.1:18081/nginx_status}" 2>/dev/null || true)"
  conns="$(printf '%s\n' "$st" | awk '/^Active connections:/{print $3; exit}')"
  reqs="$(printf '%s\n' "$st" | awk 'f{print $3; exit} /^server accepts handled requests/{f=1}')"
  case "$conns" in ''|*[!0-9]*) conns=0 ;; esac
  case "$reqs" in ''|*[!0-9]*) reqs=0 ;; esac
  [ "$conns" -gt 0 ] && conns=$(( conns - 1 ))   # minus this stub_status probe
  iface="$(awk '$2=="00000000"{print $1; exit}' /proc/net/route 2>/dev/null || true)"
  tx=""
  [ -n "$iface" ] && tx="$(sed 's/:/ /' /proc/net/dev 2>/dev/null | awk -v i="$iface" '$1==i{print $10; exit}')"
  case "$tx" in ''|*[!0-9]*) tx=0 ;; esac
  now="$(awk '{print $1}' /proc/uptime 2>/dev/null || echo 0)"
  state=/run/streamhub/hb-cdn.state
  mbps=0
  if [ -r "$state" ]; then
    pt=0; ptx=0
    read -r pt ptx < "$state" || true
    mbps="$(awk -v t="$now" -v pt="${pt:-0}" -v x="$tx" -v px="${ptx:-0}" \
      'BEGIN{ dt=t-pt; if (pt>0 && dt>0 && x>=px) printf "%.3f", (x-px)*8/dt/1000000; else print 0 }')"
  fi
  { mkdir -p /run/streamhub && printf '%s %s\n' "$now" "$tx" > "$state"; } 2>/dev/null || true
  cdir="$(printf '%s' "${STREAMHUB_HB_CDN_CACHE_DIR:-/var/cache/nginx/hls}" | tr -cd 'A-Za-z0-9/._-')"
  cdn="$(printf ',"role":"cdn-edge","cdn":{"conns":%s,"reqTotal":%s,"txBytes":%s,"txMbps":%s,"cacheDir":"%s"}' \
    "$conns" "$reqs" "$tx" "$mbps" "$cdir")"
fi

body="$(printf '{"nodeId":"%s","stats":{"cores":%s,"loadavg1":%s,"cpu":%s,"memTotalKb":%s,"memAvailKb":%s,"memUsedRatio":%s%s%s}}' \
  "$STREAMHUB_HB_NODE_ID" "$cores" "$load" "$cpu" "$memtotal" "$memavail" "$memused" "$grid" "$cdn")"

# A CDN edge always holds a per-node secret (3.4.0+ master): send it as
# X-Node-Secret too. Elsewhere X-Cluster-Token only (it may be the origin's
# cluster token, which is no node secret).
hdrs=(-H 'Content-Type: application/json' -H "X-Cluster-Token: $STREAMHUB_HB_TOKEN")
[ "${STREAMHUB_HB_ROLE:-}" = "cdn-edge" ] && hdrs+=(-H "X-Node-Secret: $STREAMHUB_HB_TOKEN")
curl -fsS -m10 -X POST "$STREAMHUB_HB_URL/api/v1/cluster/heartbeat" "${hdrs[@]}" -d "$body" >/dev/null
HBEOF
  chmod 0755 /usr/local/bin/streamhub-heartbeat.sh

  cat > /etc/systemd/system/streamhub-heartbeat.service <<'EOF'
[Unit]
Description=StreamHub cluster heartbeat (POST liveness + cpu/mem/cores to the master)
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
EnvironmentFile=-/etc/streamhub/heartbeat.env
ExecStart=/usr/local/bin/streamhub-heartbeat.sh
Nice=10
EOF

  cat > /etc/systemd/system/streamhub-heartbeat.timer <<EOF
[Unit]
Description=Run the StreamHub cluster heartbeat every ${hb_every}s

[Timer]
OnBootSec=30
OnUnitActiveSec=$hb_every
AccuracySec=5s
Unit=streamhub-heartbeat.service

[Install]
WantedBy=timers.target
EOF

  systemctl daemon-reload >/dev/null 2>&1 || true
  systemctl enable --now streamhub-heartbeat.timer >/dev/null 2>&1 \
    || warn "could not enable streamhub-heartbeat.timer"
  ok "heartbeat agent installed (systemd timer, ${hb_every}s → $hb_url, node '$hb_node')"
}

# ---- Vision Edge placeholder unit (edge nodes only) --------------------------
# An edge node runs NO public media plane; instead it dials the master's WS
# control channel and runs the Wave-2 vision-edge runtime. That runtime ships in
# Wave 2, so here we install an INERT systemd unit: ConditionPathExists gates it
# on the not-yet-installed binary, so the unit is enabled + harmless until the
# runtime lands. The edge's connection env is written for that runtime to read.
# Idempotent: files are rewritten every run. Best-effort — never aborts the install.
install_edge_placeholder_unit() { # install_edge_placeholder_unit <api_base> <node_credential> <node_id>
  local ed_url="$1" ed_token="$2" ed_node="$3"
  if ! command -v systemctl >/dev/null 2>&1; then
    warn "systemd not available — skipping the streamhub-edge unit"
    return 0
  fi
  mkdir -p /etc/streamhub
  # Re-run where the master was unreachable: keep the stored credential/id.
  if [ -r /etc/streamhub/edge.env ]; then
    [ -n "$ed_token" ] || ed_token="$(sed -n 's/^STREAMHUB_NODE_SECRET=//p' /etc/streamhub/edge.env | head -1)"
    [ -n "$ed_node" ]  || ed_node="$(sed -n 's/^STREAMHUB_NODE_ID=//p' /etc/streamhub/edge.env | head -1)"
  fi
  # STREAMHUB_NODE_SECRET is this node's own credential (3.3.4+). The same
  # value goes in STREAMHUB_CLUSTER_TOKEN ONLY as a compat alias for edge
  # runtimes that still read that name — it is NOT the shared cluster token
  # (the master accepts the node secret in X-Cluster-Token / ?token= too).
  ( umask 077; cat > /etc/streamhub/edge.env <<EOF
STREAMHUB_MASTER_URL=$ed_url
STREAMHUB_NODE_SECRET=$ed_token
STREAMHUB_CLUSTER_TOKEN=$ed_token
STREAMHUB_NODE_ID=$ed_node
VISION_EDGE_LOG=/var/log/streamhub-edge.log
EOF
  )
  cat > /etc/systemd/system/streamhub-edge.service <<'EOF'
[Unit]
Description=StreamHub Vision Edge runtime (dials the master WS control channel)
Wants=network-online.target
After=network-online.target
# INERT until the Wave-2 edge runtime binary is present — the unit stays a
# harmless no-op (condition failed, not an error) until then.
ConditionPathExists=/usr/local/bin/streamhub-vision-edge

[Service]
Type=simple
EnvironmentFile=-/etc/streamhub/edge.env
ExecStart=/usr/local/bin/streamhub-vision-edge
# stdout goes to VISION_EDGE_LOG so the master's node logs (edge log_tail)
# have something to read; stderr stays in journald.
StandardOutput=append:/var/log/streamhub-edge.log
Restart=on-failure
RestartSec=5
Nice=5

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload >/dev/null 2>&1 || true
  systemctl enable streamhub-edge.service >/dev/null 2>&1 || true
  ok "streamhub-edge.service installed (inert until the runtime lands at /usr/local/bin/streamhub-vision-edge)"
}

# ---- Vision Edge runtime provisioning (edge nodes only) ----------------------
# Turn the INERT edge unit into a RUNNING daemon: build a Python venv from the
# fetched vision-edge-runtime/ source, install it (CPU torch by DEFAULT —
# ultralytics + opencv are heavy), and drop the /usr/local/bin/streamhub-vision-edge
# shim the unit's ConditionPathExists gates on, so the daemon starts and dials
# the master's WS control channel.
#   - BEST-EFFORT: a pip failure warns loudly but NEVER aborts the join (the node
#     still heartbeats + registered; re-run once egress/deps are available).
#   - IDEMPOTENT: the venv is reused across re-runs/upgrades; the shim is rewritten.
#   - GPU: CPU wheels are installed even on a GPU box (they work everywhere);
#     when nvidia-smi is present we log how to switch to CUDA wheels — we do NOT
#     auto-install them (kept simple + deterministic).
#   - SKIP: STREAMHUB_NO_EDGE_RUNTIME=1 leaves the unit inert (no venv, no shim).
install_edge_runtime() {
  if [ "${STREAMHUB_NO_EDGE_RUNTIME:-0}" = "1" ]; then
    log "STREAMHUB_NO_EDGE_RUNTIME=1 — skipping Vision Edge runtime provisioning (unit stays inert)"
    return 0
  fi
  local src="$INSTALL_DIR/vision-edge-runtime"
  local venv="$INSTALL_DIR/vision-edge-venv"
  local shim="/usr/local/bin/streamhub-vision-edge"

  if [ ! -f "$src/pyproject.toml" ]; then
    warn "Vision Edge runtime source not found at $src — skipping runtime provisioning (unit stays inert)."
    return 0
  fi
  if ! command -v python3 >/dev/null 2>&1; then
    warn "python3 not available — skipping Vision Edge runtime provisioning (unit stays inert)."
    return 0
  fi

  log "provisioning the Vision Edge runtime (venv + deps — ultralytics/opencv are large; this can take a few minutes)"

  # The stdlib venv/ensurepip modules ship as a separate apt package on Debian/Ubuntu.
  if ! python3 -c 'import venv, ensurepip' >/dev/null 2>&1; then
    apt-get install -y -qq python3-venv python3-pip >/dev/null 2>&1 \
      || warn "could not install python3-venv/python3-pip — venv creation may fail"
  fi

  # Create the venv once; reuse it on re-runs/upgrades.
  if [ ! -x "$venv/bin/python" ]; then
    if ! python3 -m venv "$venv" >/dev/null 2>&1; then
      warn "could not create the edge venv at $venv — skipping runtime provisioning (unit stays inert)."
      return 0
    fi
  fi
  local py="$venv/bin/python"

  "$py" -m pip install --upgrade pip >/dev/null 2>&1 || true

  if command -v nvidia-smi >/dev/null 2>&1; then
    log "nvidia-smi present — installing CPU torch by default; for GPU inference reinstall CUDA wheels in $venv (see INSTALL-NODE.md)"
  fi

  # CPU torch/torchvision FIRST (from the CPU index) so ultralytics doesn't pull
  # the multi-GB CUDA build as a transitive dependency.
  if ! "$py" -m pip install --no-input torch torchvision \
      --index-url https://download.pytorch.org/whl/cpu >/dev/null 2>&1; then
    warn "CPU torch install failed (offline / no egress?) — edge daemon deps incomplete; re-run the installer when reachable."
  fi

  # The runtime package + its remaining deps (ultralytics, opencv-headless,
  # numpy, websockets, lapx) from the fetched source tree.
  if ! "$py" -m pip install --no-input "$src" >/dev/null 2>&1; then
    warn "Vision Edge runtime pip install failed — leaving the unit inert (join NOT aborted). Re-run the installer once egress/deps are available."
    return 0
  fi

  # The shim the systemd unit's ConditionPathExists gates on. Bakes in the venv
  # interpreter + sources edge.env so a manual run works like the unit does.
  cat > "$shim" <<EOF
#!/usr/bin/env bash
set -euo pipefail
[ -r /etc/streamhub/edge.env ] && { set -a; . /etc/streamhub/edge.env; set +a; }
exec "$py" -m vision_edge --mode edge
EOF
  chmod 0755 "$shim"

  # The ConditionPathExists now passes — (re)start so the daemon comes up (and a
  # re-run picks up a rewritten shim).
  if command -v systemctl >/dev/null 2>&1; then
    systemctl daemon-reload >/dev/null 2>&1 || true
    systemctl enable streamhub-edge.service >/dev/null 2>&1 || true
    systemctl restart streamhub-edge.service >/dev/null 2>&1 \
      || warn "could not start streamhub-edge.service (check: journalctl -u streamhub-edge, /var/log/streamhub-edge.log)"
  fi
  ok "Vision Edge runtime provisioned ($venv) — streamhub-edge.service dials the master WS control channel."
}

# ---- MediaMTX single-port :1935 RTMP front (opt-in) -------------------------
# Installs the PINNED mediamtx binary + config + systemd unit on a bare node so
# it owns the public :1935 and fires loopback hooks to the core, which classifies
# by stream key (ptk_ → passthrough remux, else → forward to LiveKit ingress
# :11935) and owns every ffmpeg. MediaMTX itself only runs `wget` (the hooks).
# The .env wiring (STREAMHUB_MEDIAMTX_* + STREAMHUB_LIVEKIT_INGRESS_RTMP_PORT=
# 11935) happens in section 4, so by the time this runs the compose ingress has
# already vacated :1935. Idempotent: the binary is re-downloaded only when the
# stamped version differs (sha256-verified); config, hook-secret env and unit are
# rewritten every run. Best-effort — a failure here never aborts the install.
install_mediamtx() {
  command -v systemctl >/dev/null 2>&1 || { warn "systemd unavailable — cannot install the MediaMTX unit; skipping"; return 0; }
  mkdir -p /etc/streamhub

  # wget is the only external tool MediaMTX execs here (the ready/notready hooks);
  # the core (in Docker) owns ffmpeg, so we do NOT need ffmpeg on the host.
  if ! command -v wget >/dev/null 2>&1; then
    log "installing MediaMTX host dep (wget, for the core hooks)"
    apt-get install -y -qq wget >/dev/null 2>&1 \
      || warn "could not apt-install wget — the MediaMTX ready/notready hooks need it"
  fi

  # Binary — download the pinned release + verify sha256 unless already current.
  local bin=/usr/local/bin/mediamtx stamp=/etc/streamhub/.mediamtx-version installed=""
  [ -x "$bin" ] && [ -r "$stamp" ] && installed="$(head -1 "$stamp" 2>/dev/null | tr -d '[:space:]')"
  if [ "$installed" = "$MEDIAMTX_VERSION" ] && [ -x "$bin" ]; then
    ok "mediamtx v${MEDIAMTX_VERSION} already installed"
  else
    local url tgz tmp got
    url="https://github.com/bluenviron/mediamtx/releases/download/v${MEDIAMTX_VERSION}/mediamtx_v${MEDIAMTX_VERSION}_linux_amd64.tar.gz"
    tgz="$(mktemp)"; tmp="$(mktemp -d)"
    log "downloading mediamtx v${MEDIAMTX_VERSION}"
    if ! curl -fsSL -m120 "$url" -o "$tgz"; then
      rm -rf "$tgz" "$tmp"; warn "mediamtx download failed ($url) — skipping the single-port front"; return 0
    fi
    got="$(sha256sum "$tgz" 2>/dev/null | awk '{print $1}')"
    if [ "$got" != "$MEDIAMTX_SHA256" ]; then
      rm -rf "$tgz" "$tmp"; warn "mediamtx sha256 mismatch (got ${got:-none}, want $MEDIAMTX_SHA256) — refusing to install"; return 0
    fi
    tar xzf "$tgz" -C "$tmp" mediamtx 2>/dev/null || tar xzf "$tgz" -C "$tmp" 2>/dev/null || true
    if [ -f "$tmp/mediamtx" ]; then
      install -m 0755 "$tmp/mediamtx" "$bin"
      printf '%s\n' "$MEDIAMTX_VERSION" > "$stamp"
      ok "installed mediamtx v${MEDIAMTX_VERSION} → $bin"
    else
      rm -rf "$tgz" "$tmp"; warn "mediamtx binary not found in the archive — skipping"; return 0
    fi
    rm -rf "$tgz" "$tmp"
  fi

  # Config + hook-secret env file (chmod 600 — it holds the secret). The config
  # references ${STREAMHUB_MEDIAMTX_HOOK_SECRET} in the ready/notready hook header
  # (MediaMTX expands it from this env), and MTX_AUTHHTTPADDRESS overrides the
  # auth URL to carry ?secret= (authHTTPAddress can't send a header).
  install -m 0644 "$INSTALL_DIR/deploy/mediamtx.yml" /etc/streamhub/mediamtx.yml
  local hs; hs="$(env_get STREAMHUB_MEDIAMTX_HOOK_SECRET)"
  # E2: SRT on the front (key-checked by the auth hook) only when the core's
  # STREAMHUB_MEDIAMTX_SRT_ENABLE is on; normalized to MediaMTX's yes/no.
  local srt_raw srt_port mtx_srt="no"
  srt_raw="$(env_get STREAMHUB_MEDIAMTX_SRT_ENABLE)"; srt_port="$(env_get STREAMHUB_MEDIAMTX_SRT_PORT)"
  case "$(printf '%s' "$srt_raw" | tr '[:upper:]' '[:lower:]')" in 1|true|on|yes) mtx_srt="yes" ;; esac
  ( umask 077; cat > /etc/streamhub/mediamtx.env <<EOF
STREAMHUB_MEDIAMTX_HOOK_SECRET=$hs
MTX_AUTHHTTPADDRESS=http://127.0.0.1:3020/api/v1/internal/mediamtx/auth?secret=$hs
MTX_SRT=$mtx_srt
MTX_SRTADDRESS=:${srt_port:-8890}
EOF
  )

  # systemd unit — absolute paths, no templating needed.
  install -m 0644 "$INSTALL_DIR/deploy/systemd/streamhub-mediamtx.service" /etc/systemd/system/streamhub-mediamtx.service
  systemctl daemon-reload >/dev/null 2>&1 || true
  systemctl enable streamhub-mediamtx.service >/dev/null 2>&1 || warn "could not enable streamhub-mediamtx.service"
  # restart (not just start) so a rewritten config/secret is picked up on re-runs.
  systemctl restart streamhub-mediamtx.service >/dev/null 2>&1 \
    || warn "could not (re)start streamhub-mediamtx.service — check: journalctl -u streamhub-mediamtx"
  ok "MediaMTX single-port :1935 front active (systemctl status streamhub-mediamtx)"
}

# ---- 4d. app scaffolding: streamhub CLI + ONE managed service ----------------
# Makes StreamHub a self-contained app the operator drives with one command:
#   - the `streamhub` CLI in <dir>/bin (symlinked into PATH)
#   - .install-profile (mode/proxy) so the CLI knows which services this node runs
#   - a single systemd unit fronting the whole compose stack
#   - the stamped VERSION (authoritative record for the next upgrade check)
install_app_scaffolding() {
  # MODE=cdn-edge tells the CLI this node is nginx-only (no compose stack).
  local prof_mode="$MODE"; [ "$CDN_EDGE" = "1" ] && prof_mode="cdn-edge"
  ( umask 022; cat > "$INSTALL_DIR/.install-profile" <<EOF
STREAMHUB_PROFILE_MODE=$prof_mode
STREAMHUB_PROFILE_PROXY=$PROXY
STREAMHUB_PROFILE_EGRESS=$WITH_EGRESS
STREAMHUB_PROFILE_NODE_IP=$NODE_IP_MODE
EOF
  )

  # Joined nodes also persist their role + join params (mode 600) so a bare
  # re-run / `streamhub upgrade` resumes as the same node instead of silently
  # re-running in origin mode (see the resume block). The cluster token is
  # kept ONLY when the origin vended no per-node secret (pre-3.3.4 origin):
  # otherwise the node holds just its own secret (.env STREAMHUB_NODE_SECRET).
  if [ "$MODE" = "join" ]; then
    PROFILE_TOKEN="$CLUSTER_TOKEN"
    [ -n "$(env_get STREAMHUB_NODE_SECRET)" ] && PROFILE_TOKEN=""
    ( umask 077; cat > "$INSTALL_DIR/.join-profile" <<EOF
STREAMHUB_PROFILE_NODE_TYPE=$NODE_TYPE
STREAMHUB_PROFILE_NODE_NAME=$NODE_NAME
STREAMHUB_PROFILE_ORIGIN_IP=$ORIGIN_IP
STREAMHUB_PROFILE_ORIGIN_URL=$ORIGIN_URL
STREAMHUB_PROFILE_CLUSTER_TOKEN=$PROFILE_TOKEN
STREAMHUB_PROFILE_EGRESS=$WITH_EGRESS
EOF
    )
  fi

  if [ -f "$INSTALL_DIR/deploy/streamhub" ]; then
    install -m 0755 "$INSTALL_DIR/deploy/streamhub" "$INSTALL_DIR/bin/streamhub"
    ln -sf "$INSTALL_DIR/bin/streamhub" /usr/local/bin/streamhub 2>/dev/null \
      || warn "could not symlink /usr/local/bin/streamhub — use $INSTALL_DIR/bin/streamhub"
    ok "streamhub CLI installed ($INSTALL_DIR/bin/streamhub → /usr/local/bin/streamhub)"
  else
    warn "deploy/streamhub missing from the source — CLI not installed"
  fi

  # (a CDN edge has no compose stack — nginx.service is its service)
  if [ "$CDN_EDGE" != "1" ] && command -v systemctl >/dev/null 2>&1 && [ -f "$INSTALL_DIR/deploy/systemd/streamhub.service" ]; then
    # Template the default /opt/streamhub paths to the actual install dir.
    sed "s#/opt/streamhub#$INSTALL_DIR#g" \
      "$INSTALL_DIR/deploy/systemd/streamhub.service" > /etc/systemd/system/streamhub.service
    systemctl daemon-reload >/dev/null 2>&1 || true
    # enable --now marks the unit active (it runs `streamhub start`, an idempotent
    # `compose up -d` over the stack we just brought up) so `systemctl status
    # streamhub` reflects the whole app immediately and it starts on boot.
    systemctl enable --now streamhub.service >/dev/null 2>&1 \
      || warn "could not enable streamhub.service"
    ok "managed as one service: systemctl status streamhub"
  fi

  printf '%s\n' "$TARGET_VERSION" > "$INSTALL_DIR/VERSION"
  # A prepared image is now a real install: later runs fetch/upgrade normally.
  rm -f "$IMAGE_MARKER"
}

# Actionable guidance for a FAILED upgrade (build OR health). The pre-upgrade DB
# backup is always preserved, and VERSION on disk is still the running (old)
# value (stamped only after health) so a re-run retries the upgrade.
print_rollback_guidance() { # <stage>
  warn "UPGRADE FAILED at $1: ${INSTALLED_VERSION} → ${TARGET_VERSION}. Your data is INTACT."
  warn "VERSION on disk stays at the running v${INSTALLED_VERSION} — re-run the installer to retry."
  warn "Pre-upgrade DB backup (kept, NOT deleted): ${BACKUP_DIR:-<none>}"
  if [ -n "${BACKUP_DIR:-}" ]; then
    warn "To restore the DBs and roll the stack back:"
    warn "    streamhub stop"
    warn "    cp -a '${BACKUP_DIR}/data/streamhub.db' '$DATA_HOST_DIR_EARLY/data/streamhub.db'   # + apps/*/app.db"
    warn "    docker compose -f '$INSTALL_DIR/docker-compose.yml' up -d --build"
  fi
}

# ---- anonymous install phone-home (fire-and-forget, opt-out) -----------------
# Sends a tiny anonymous ping so the project can count installs/versions. NO PII:
# no hostname, no IP (the server hashes the source IP), no secrets. Body:
# {install_id (random uuid, persisted at $INSTALL_DIR/.install_id so re-runs reuse
# it), version, os, arch, mode, channel}. NEVER fails or delays the install
# (backgrounded, `|| true`, 5s cap). Opt out with STREAMHUB_NO_TELEMETRY=1.
phone_home() { # <mode: fresh|upgrade|join>
  local mode="$1"
  if [ "${STREAMHUB_NO_TELEMETRY:-0}" = "1" ]; then
    log "telemetry off (STREAMHUB_NO_TELEMETRY=1) — no anonymous install ping sent"
    return 0
  fi
  command -v curl >/dev/null 2>&1 || return 0
  local url idfile iid ver arch body channel
  url="${STREAMHUB_TELEMETRY_URL:-https://streamhub.studio/api/installs}"
  # stable = the one-liner; a marketplace image reports its own channel.
  channel="$(printf '%s' "${STREAMHUB_TELEMETRY_CHANNEL:-${IMAGE_CHANNEL:-stable}}" | tr -cd 'A-Za-z0-9._-')"
  : "${channel:=stable}"
  idfile="$INSTALL_DIR/.install_id"
  [ -r "$idfile" ] && iid="$(head -1 "$idfile" 2>/dev/null | tr -d '[:space:]')" || iid=""
  if [ -z "$iid" ]; then
    iid="$(cat /proc/sys/kernel/random/uuid 2>/dev/null || uuidgen 2>/dev/null || true)"
    [ -n "$iid" ] && (umask 022; printf '%s\n' "$iid" > "$idfile" 2>/dev/null) || true
  fi
  ver="$(head -1 "$INSTALL_DIR/VERSION" 2>/dev/null | tr -d '[:space:]')"; : "${ver:=unknown}"
  case "$(uname -m)" in
    x86_64|amd64)  arch="amd64" ;;
    aarch64|arm64) arch="arm64" ;;
    *)             arch="$(uname -m)" ;;
  esac
  body="$(printf '{"install_id":"%s","version":"%s","os":"linux","arch":"%s","mode":"%s","channel":"%s"}' \
    "$iid" "$ver" "$arch" "$mode" "$channel")"
  # fire-and-forget: a telemetry hiccup must never fail or slow the install
  ( curl -fsS -m5 -X POST "$url" -H 'Content-Type: application/json' -d "$body" >/dev/null 2>&1 || true ) &
  log "sent anonymous install ping (mode=$mode, version=$ver, arch=$arch, channel=$channel) — opt out: STREAMHUB_NO_TELEMETRY=1"
}

# ---- 5. start services -------------------------------------------------------
if [ "$MODE" = "origin" ]; then
  # The core image bakes /app/VERSION at build time (Dockerfile COPY VERSION),
  # but the mirror step deliberately PRESERVES the previously stamped file — so
  # a fresh tarball install had NO VERSION (COPY failed the build) and an
  # upgrade baked the OLD one (health reported stale). Write the TARGET for the
  # build; a failed build restores the previous stamp (the authoritative stamp
  # still happens post-verify, unchanged).
  PRE_BUILD_VERSION=""
  [ -r "$INSTALL_DIR/VERSION" ] && PRE_BUILD_VERSION="$(head -1 "$INSTALL_DIR/VERSION" 2>/dev/null | tr -d '[:space:]')"
  if [ -n "$TARGET_VERSION" ] && [ "$TARGET_VERSION" != "0.0.0" ]; then
    printf '%s\n' "$TARGET_VERSION" > "$INSTALL_DIR/VERSION"
  fi
  # Capture a build/up failure ourselves (|| keeps set -e from a bare abort) so
  # an upgrade prints rollback guidance + keeps the backup instead of dying mute.
  BUILD_OK=1
  if [ "$PROXY" = "caddy" ]; then
    log "building + starting the full stack (with Caddy auto-TLS)"
    docker compose --profile caddy up -d --build || BUILD_OK=0
  else
    log "building + starting the stack (redis livekit ingress egress core — nginx fronts it)"
    docker compose up -d --build redis livekit ingress egress core || BUILD_OK=0
    # A pre-profile install may have left a compose caddy container fighting
    # nginx for :80 (restart loop) — drop it.
    docker compose --profile caddy rm -sf caddy >/dev/null 2>&1 || true
  fi
  if [ "$BUILD_OK" = "0" ]; then
    # Un-stamp the failed build's version so the record matches what still runs.
    if [ -n "$PRE_BUILD_VERSION" ]; then printf '%s\n' "$PRE_BUILD_VERSION" > "$INSTALL_DIR/VERSION"; fi
    docker compose logs --tail=40 core || true
    if [ "$DO_UPGRADE" = "1" ]; then
      print_rollback_guidance "build/rebuild"
      die "upgrade build failed — old version preserved, backup kept at ${BACKUP_DIR:-<none>}."
    fi
    die "docker compose build/up failed (see the logs above)."
  fi

  log "waiting for streamhub-core health..."
  HEALTH_JSON=""
  for i in $(seq 1 60); do
    if HEALTH_JSON="$(curl -fsS "http://127.0.0.1:3020/api/v1/health" 2>/dev/null)"; then ok "core is healthy"; break; fi
    if [ "$i" = 60 ]; then
      docker compose logs --tail=40 core || true
      if [ "$DO_UPGRADE" = "1" ]; then
        print_rollback_guidance "health check"
        die "upgrade health check failed — backup preserved at ${BACKUP_DIR:-<none>} (NOT deleted)."
      fi
      die "core did not become healthy in time"
    fi
    sleep 3
  done

  # ---- migration evidence: user_version before/after + reported version ------
  if [ "$DO_UPGRADE" = "1" ]; then
    UV_AFTER="$(sqlite_user_version "$DATA_HOST_DIR_EARLY/data/streamhub.db")"
    RUNTIME_VERSION="$(printf '%s' "$HEALTH_JSON" | grep -o '"version"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | cut -d'"' -f4 || true)"
    log "migration: global DB user_version ${UV_BEFORE} → ${UV_AFTER} (core reports version '${RUNTIME_VERSION:-?}')"
  fi

  log "seeding the global API token (idempotent)"
  # stdin ("-"): the sk_ token must never ride an argv (visible in ps/cmdline)
  printf '%s' "$(env_get STREAMHUB_API_TOKEN)" \
    | docker compose exec -T core streamhub-core seed-token - bootstrap \
    || warn "token seed skipped (probably already seeded)"

  # ---- proxy server-block + (optional) certbot ------------------------------
  DOMAIN="$(env_get STREAMHUB_DOMAIN)"
  if [ "$PROXY" = "nginx" ]; then
    # Connection limits first (worker_connections/rlimit/LimitNOFILE) — applied
    # by the reload below, or right here when the vhost already exists.
    tune_nginx_limits
    # No domain (localhost / --no-tls without --domain): a catch-all vhost to
    # the core instead of leaving nginx's default site (which never reached
    # /api or /hls). Named so it can't collide with a real domain's file.
    if [ "$DOMAIN" = "localhost" ]; then AVAIL="/etc/nginx/sites-available/streamhub-default"
    else AVAIL="/etc/nginx/sites-available/$DOMAIN"; fi
    # HLS direct-serve (STREAMHUB_HLS_DIRECT_SERVE, operations/SCALING.md): ON
    # points nginx's /hls root at the host DATA_DIR so live segments are served
    # straight from disk (sendfile), each one AFTER an auth_request to the core
    # (/hls-auth: signed HLS of private apps + geo) — playlists always go to the
    # core. OFF (default) uses a non-existent root and auth_request off, so
    # try_files always misses and everything falls back to the core (no change).
    # The two placeholders move together: a real root never ships without auth.
    HLS_DS="$(env_get STREAMHUB_HLS_DIRECT_SERVE)"; : "${HLS_DS:=${STREAMHUB_HLS_DIRECT_SERVE:-}}"
    case "${HLS_DS,,}" in
      on|1|true|yes) HLS_ROOT="$(cd "$INSTALL_DIR" 2>/dev/null && realpath -m "${DATA_HOST_DIR:-./data}" 2>/dev/null || echo "${DATA_HOST_DIR:-./data}")"
         HLS_AUTH="/_streamhub_hls_auth"
         log "HLS direct-serve ON — nginx serves /hls segments from disk at $HLS_ROOT (auth_request to the core)"
         # data/apps is 770 (umask 077 + g+rwX above): give ONLY the nginx worker
         # user traverse (x, no listing) down to the per-app dirs — not o+x, which
         # would open app.db (664) to every local user.
         NGX_USER="$(awk '$1=="user"{gsub(";","",$2); print $2; exit}' /etc/nginx/nginx.conf 2>/dev/null)"; : "${NGX_USER:=www-data}"
         if command -v setfacl >/dev/null 2>&1; then
           for d in "$INSTALL_DIR" "$HLS_ROOT" "$HLS_ROOT/apps"; do setfacl -m "u:$NGX_USER:x" "$d" 2>/dev/null || true; done
         else
           warn "setfacl not found — nginx ($NGX_USER) may get 403 on /hls; run: setfacl -m u:$NGX_USER:x $HLS_ROOT/apps (apt install acl)"
         fi ;;
      *) HLS_ROOT="/var/empty"; HLS_AUTH="off" ;;
    esac
    if [ ! -f "$AVAIL" ]; then
      if is_ip "$DOMAIN" || [ "$DOMAIN" = "localhost" ]; then
        # IP origin / no domain: a catch-all default_server answers on :80 for
        # ANY Host header, so edges/clients reach the core at http://<ip>.
        log "writing nginx catch-all server block ($([ "$DOMAIN" = localhost ] && echo 'no domain' || echo "IP origin $DOMAIN") → core 127.0.0.1:3020)"
        sed -e 's/server_name streamhub\.example\.com;/server_name _;/' \
            -e 's/listen 80;/listen 80 default_server;/' \
            -e 's/listen \[::\]:80;/listen [::]:80 default_server;/' \
            -e "s#__STREAMHUB_HLS_ROOT__#$HLS_ROOT#" \
            -e "s#__STREAMHUB_HLS_AUTH__#$HLS_AUTH#" \
            deploy/nginx-streamhub.conf > "$AVAIL"
      else
        log "writing nginx server block for $DOMAIN"
        sed -e "s/streamhub.example.com/$DOMAIN/" \
            -e "s#__STREAMHUB_HLS_ROOT__#$HLS_ROOT#" \
            -e "s#__STREAMHUB_HLS_AUTH__#$HLS_AUTH#" \
            deploy/nginx-streamhub.conf > "$AVAIL"
      fi
      ln -sf "$AVAIL" "/etc/nginx/sites-enabled/$(basename "$AVAIL")"
      rm -f /etc/nginx/sites-enabled/default
      nginx -t && systemctl reload nginx
    else
      ok "nginx server block for $DOMAIN already present"
      if nginx -t >/dev/null 2>&1; then systemctl reload nginx >/dev/null 2>&1 || true; fi   # picks up tune_nginx_limits
      # 3.4.0 (G2): a pre-3.4 vhost serves /hls from disk WITHOUT asking the
      # core, which would expose apps with public_playback:false. Detect it.
      if [ "$HLS_AUTH" != "off" ] && ! grep -q "_streamhub_hls_auth" "$AVAIL" 2>/dev/null; then
        warn "HLS direct-serve is ON but $AVAIL predates the /hls auth_request (3.4.0): private apps' segments would be served WITHOUT a token."
        warn "  Regenerate it: rm $AVAIL && re-run install.sh (or merge deploy/nginx-streamhub.conf by hand), then nginx -t && systemctl reload nginx."
      fi
    fi
    if [ "$DOMAIN" = "localhost" ]; then
      log "no domain: no certbot — nginx serves the core on plain HTTP :80 (pass --domain for TLS)"
    elif [ "$NO_TLS" = "1" ]; then
      warn "--no-tls: skipping certbot ($DOMAIN stays plain HTTP on :80)"
    elif is_ip "$DOMAIN"; then
      warn "domain is an IP ($DOMAIN) — skipping certbot (Let's Encrypt needs a DNS name); plain HTTP on :80."
    elif [ -d "/etc/letsencrypt/live/$DOMAIN" ]; then
      ok "Let's Encrypt cert for $DOMAIN already present (auto-renews via certbot.timer)"
    else
      log "requesting Let's Encrypt cert for $DOMAIN"
      certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --redirect -m "$(env_get ACME_EMAIL)" \
        || warn "certbot failed — check the DNS A record for $DOMAIN and re-run this installer"
    fi
    # Samples origin vhost (+ cert): a second server block, same core upstream;
    # the core splits by Host (features/samples.md).
    SAMPLES_URL_SET="$(env_get STREAMHUB_SAMPLES_URL)"
    if [ -n "$SAMPLES_URL_SET" ] && ! is_ip "$DOMAIN" && [ "$DOMAIN" != "localhost" ]; then
      SDOM="${SAMPLES_URL_SET#*://}"; SDOM="${SDOM%%/*}"
      SAVAIL="/etc/nginx/sites-available/$SDOM"
      if [ ! -f "$SAVAIL" ]; then
        log "writing nginx server block for the samples origin $SDOM"
        sed "s/samples.example.com/$SDOM/" deploy/nginx-samples.conf > "$SAVAIL"
        ln -sf "$SAVAIL" "/etc/nginx/sites-enabled/$SDOM"
        nginx -t && systemctl reload nginx
      else
        ok "nginx server block for $SDOM already present"
      fi
      if [ "$NO_TLS" != "1" ] && [ ! -d "/etc/letsencrypt/live/$SDOM" ]; then
        log "requesting Let's Encrypt cert for the samples origin $SDOM"
        certbot --nginx -d "$SDOM" --non-interactive --agree-tos --redirect -m "$(env_get ACME_EMAIL)" \
          || warn "certbot failed for $SDOM — check its DNS A record points here and re-run; samples are unreachable until it exists."
      fi
    fi
    # TURN cert (dedicated cert for turn.<domain> in its OWN live/ dir so the
    # compose cert_file path derives cleanly from STREAMHUB_TURN_DOMAIN). certonly
    # + --keep-until-expiring is idempotent; the nginx authenticator answers the
    # HTTP-01 challenge (needs turn.<domain> DNS → this host + :80 reachable).
    # LiveKit reads the PEMs live via the /etc/letsencrypt mount; certbot.timer
    # renews them in place (no copy, no reload hook).
    if [ "$TURN_ENABLE" = "1" ] && [ "$NO_TLS" != "1" ] && ! is_ip "$DOMAIN"; then
      TURN_DOM="$(env_get STREAMHUB_TURN_DOMAIN)"; : "${TURN_DOM:=turn.$DOMAIN}"
      if [ -r "/etc/letsencrypt/live/$TURN_DOM/fullchain.pem" ]; then
        ok "TURN cert for $TURN_DOM already present (auto-renews via certbot.timer)"
      else
        log "requesting Let's Encrypt cert for the TURN domain $TURN_DOM"
        certbot certonly --nginx -d "$TURN_DOM" --non-interactive --agree-tos --keep-until-expiring -m "$(env_get ACME_EMAIL)" \
          || warn "certbot failed for $TURN_DOM — check its DNS A record points here and re-run; TURN/TLS stays down until the cert exists."
      fi
      # Enable the relay now that the cert is on disk (livekit read cert_file at
      # boot with TURN still off, so flip the seam + recreate livekit to apply).
      if [ -r "/etc/letsencrypt/live/$TURN_DOM/fullchain.pem" ] && [ "$(env_get STREAMHUB_TURN_ENABLE)" != "true" ]; then
        env_set STREAMHUB_TURN_ENABLE "true"
        log "enabling the TURN relay on LiveKit (recreating the livekit container)"
        docker compose up -d --force-recreate livekit >/dev/null 2>&1 \
          || warn "could not recreate livekit to apply TURN — run: streamhub restart"
      fi
    fi
  fi

  # Heartbeat itself: the origin self-registers as node 'origin' at boot (see
  # cluster.service) and pings its OWN local core so it never goes stale.
  install_heartbeat_agent "http://127.0.0.1:3020" "$(env_get STREAMHUB_CLUSTER_TOKEN)" "origin"

  # Single-port :1935 RTMP front (opt-in). Runs AFTER the core is healthy + the
  # compose ingress has moved to :11935 (STREAMHUB_INGRESS_RTMP_PORT set above),
  # so mediamtx can bind the now-free public :1935.
  [ "$MEDIAMTX_ENABLE" = "1" ] && install_mediamtx
elif [ "$CDN_EDGE" = "1" ]; then
  # ---- CDN edge: nginx HLS cache only (no Docker, LiveKit or compose) --------
  log "CDN edge — nginx caching /hls from $CDN_ORIGIN_URL (no Docker/LiveKit)"
  install_cdn_edge
  # Registered + fresh in the master's registry, reporting conns/req/tx Mbps.
  install_heartbeat_agent "$API_BASE" "$NODE_CRED" "${NODE_ID:-}" "cdn-edge"
elif [ "$NODE_TYPE" = "edge" ]; then
  # ---- Vision Edge node: NO public media plane -------------------------------
  # An edge is a worker/compute node — it joins + heartbeats + (Wave 2) dials the
  # master's WS control channel, but runs no livekit/ingress/egress. Install the
  # inert edge runtime unit; the heartbeat agent below keeps it fresh meanwhile.
  log "edge node — skipping the public media plane (no livekit/ingress/egress)"
  install_edge_placeholder_unit "$API_BASE" "$NODE_CRED" "${NODE_ID:-}"
  # Provision + start the vision-edge runtime (best-effort; STREAMHUB_NO_EDGE_RUNTIME=1 skips).
  install_edge_runtime

  # Keep this edge fresh in the master's registry (60s systemd timer).
  install_heartbeat_agent "$API_BASE" "$NODE_CRED" "${NODE_ID:-}"
else
  # ---- redis preflight: the origin's shared Redis MUST be reachable ----------
  # Edges coordinate through the origin's Redis (LIVEKIT_REDIS_ADDRESS). If it
  # refuses (origin bound redis to 127.0.0.1 only — AWS-POC2 finding #2), bringing
  # up LiveKit/ingress/egress just crash-loops. Fail fast with the origin-side
  # remedy instead. Override the gate with STREAMHUB_SKIP_REDIS_PREFLIGHT=1.
  REDIS_ADDR="$(env_get LIVEKIT_REDIS_ADDRESS)"
  if [ "${STREAMHUB_SKIP_REDIS_PREFLIGHT:-0}" != "1" ] && [ -n "$REDIS_ADDR" ]; then
    R_HOST="${REDIS_ADDR%:*}"; R_PORT="${REDIS_ADDR##*:}"
    case "$REDIS_ADDR" in *:*) ;; *) R_HOST="$REDIS_ADDR"; R_PORT="6379" ;; esac
    log "preflight: checking the origin's Redis is reachable at ${R_HOST}:${R_PORT}"
    if preflight_tcp "$R_HOST" "$R_PORT" 6; then
      ok "redis reachable at ${R_HOST}:${R_PORT}"
    else
      warn "cannot reach the origin's Redis at ${R_HOST}:${R_PORT} — media services would crash-loop."
      warn "Fix on the ORIGIN (bind Redis to a reachable PRIVATE IP), e.g. re-run its installer with:"
      warn "    ... --cluster-redis-bind <ORIGIN_PRIVATE_IP>"
      warn "  or, quick manual fix on the origin:"
      warn "    echo 'REDIS_BIND=127.0.0.1 <ORIGIN_PRIVATE_IP>' >> \$INSTALL_DIR/.env"
      warn "    docker compose -f \$INSTALL_DIR/docker-compose.yml up -d --force-recreate redis"
      warn "    # and allow this edge: ufw allow from $(env_get STREAMHUB_DOMAIN 2>/dev/null || echo '<edge-ip>') to any port ${R_PORT} proto tcp"
      die "origin Redis unreachable at ${R_HOST}:${R_PORT} — not starting media services (override: STREAMHUB_SKIP_REDIS_PREFLIGHT=1). See INSTALL-NODE.md."
    fi
  fi

  # --no-deps: an edge must NOT start a local redis (depends_on would) — it
  # coordinates through the ORIGIN's redis set in LIVEKIT_REDIS_ADDRESS.
  #
  # Egress affinity (DEFAULT): a joined COMMON node does NOT run egress. Any
  # egress worker in the cluster can claim a shared-Redis recording/HLS job and
  # writes artifacts to ITS OWN local disk — but the origin uploads to S3 and
  # serves /hls from ITS disk, so a job claimed off-origin breaks (VOD failed /
  # HLS 404, ~50% with 2 nodes). Keeping egress on the origin only makes every
  # artifact land where the origin looks. Opt in with --with-egress once you
  # accept the tradeoff. Definitive fix = S3 transport (architecture/CLUSTER-ROADMAP.md).
  JOIN_SVCS="livekit ingress"
  if [ "$WITH_EGRESS" = "1" ]; then
    JOIN_SVCS="livekit ingress egress"
    warn "=================================================================="
    warn "--with-egress: this node WILL run egress. KNOWN LIMITATION —"
    warn "recordings/HLS this node captures land on ITS OWN disk, while the"
    warn "origin uploads/serves from its disk → cross-node recordings and"
    warn "live-HLS are broken (~50% failure) until S3 transport ships."
    warn "See streamhub-docs/architecture/CLUSTER-ROADMAP.md (Wave C)."
    warn "=================================================================="
  else
    log "egress affinity: NOT starting egress here (artifacts stay on the origin). Opt in with --with-egress."
    # Proactively drop a previously-running egress (e.g. a pre-affinity node being
    # upgraded) so the affinity takes effect NOW, not just on the next restart.
    # No-op on a fresh node (egress was never up).
    docker compose rm -sf egress >/dev/null 2>&1 || true
  fi
  log "starting media services ($JOIN_SVCS) against the origin's Redis"
  # shellcheck disable=SC2086
  docker compose up -d --no-deps $JOIN_SVCS

  # Keep this edge fresh in the master's registry (60s systemd timer). NODE_ID
  # comes from the join response above; a re-run reuses the stored id if the
  # master was unreachable this time.
  install_heartbeat_agent "$API_BASE" "$NODE_CRED" "${NODE_ID:-}"
fi

# ---- 5b. install the CLI + single service + stamp VERSION (both modes) -------
install_app_scaffolding

# ---- 6. summary ---------------------------------------------------------------
# Secrets are shown only on an interactive TTY: under cloud-init/CI, stdout is
# persisted to logs — point at .env instead.
reveal() {
  if [ -t 1 ] && [ "$NONINTERACTIVE" != "1" ]; then printf '%s' "$1"; else printf '(see %s/.env)' "$INSTALL_DIR"; fi
}
echo
ok "============================================================"
if [ "$DO_UPGRADE" = "1" ]; then
  ok "UPGRADE COMPLETE: ${INSTALLED_VERSION} → ${TARGET_VERSION}"
  if [ "$MODE" = "origin" ]; then
    echo "  DB migration  : global user_version ${UV_BEFORE:-n/a} → ${UV_AFTER:-n/a}  (core reports '${RUNTIME_VERSION:-?}')"
    echo "  Backup        : ${BACKUP_DIR:-<none>}   (kept — safe to remove after you verify)"
  fi
elif [ "$EXISTING_INSTALL" = "1" ]; then
  ok "Up to date at v${TARGET_VERSION} (no upgrade needed)."
else
  ok "Installed StreamHub v${TARGET_VERSION}."
fi
if [ "$MODE" = "origin" ]; then
  DOMAIN="$(env_get STREAMHUB_DOMAIN)"; SCHEME="https"
  [ "$NO_TLS" = "1" ] && SCHEME="http"
  [ "$DOMAIN" = "localhost" ] && { SCHEME="http"; DOMAIN="127.0.0.1:3020"; }
  ok "StreamHub origin node is running."
  echo "  Dashboard     : $SCHEME://$DOMAIN/          (login: $(env_get ADMIN_USER) / $(reveal "$(env_get ADMIN_PASS)"))"
  [ "$DOMAIN" = "127.0.0.1:3020" ] && [ "$PROXY" = "nginx" ] \
    && echo "  Also on       : http://<this-server-ip>/   (nginx catch-all → core, plain HTTP; --domain for TLS)"
  echo "  API + Swagger : $SCHEME://$DOMAIN/api/v1/docs"
  echo "  API token     : $(reveal "$(env_get STREAMHUB_API_TOKEN)")    (Authorization: Bearer ...)"
  echo "  RTMP publish  : rtmp://$(env_get RTMP_PUBLIC_HOST):1935/x  ·  WHIP: :8080  ·  HLS: /hls/<app>/<room>/index.m3u8"
  [ "$(env_get STREAMHUB_TURN_ENABLE)" = "true" ] && echo "  TURN relay    : turn:$(env_get STREAMHUB_TURN_DOMAIN):5349 (TLS) + :3478/udp  ·  ICE servers auto-advertised in the JoinResponse"
  [ -n "$(env_get STREAMHUB_SAMPLES_URL)" ] && echo "  Samples       : $(env_get STREAMHUB_SAMPLES_URL)/samples/<app>/<file>   (own origin)"
  echo "  Cluster token : $(reveal "$(env_get STREAMHUB_CLUSTER_TOKEN)")"
  echo "  Join an edge  : curl -fsSL $SELF_URL | sudo bash -s -- --join \\"
  echo "                    --master-token $(reveal "$(env_get STREAMHUB_CLUSTER_TOKEN)") --master-ip <THIS_SERVER_IP> --master-url $SCHEME://$DOMAIN"
  echo "  Manage        : streamhub status | logs -f | restart | doctor | upgrade   (systemctl status streamhub)"
  echo "  Config        : $INSTALL_DIR/.env   ·   Data: $INSTALL_DIR/data   ·   Version: $INSTALL_DIR/VERSION (v${TARGET_VERSION})"
  echo "  Logs          : streamhub logs -f core    ·   installer log: $INSTALL_DIR/logs/install.log"
  if [ "$DOMAIN" != "127.0.0.1:3020" ]; then
    echo
    warn "DNS: A record '$(env_get STREAMHUB_DOMAIN)' -> this server's public IP (DNS-only, no CDN proxy)."
    warn "Firewall: open 80,443,1935,7880,7881/tcp and 7882/udp."
    [ "$(env_get STREAMHUB_TURN_ENABLE)" = "true" ] && warn "TURN: also open 5349/tcp + 3478/udp, and add DNS A record '$(env_get STREAMHUB_TURN_DOMAIN)' -> this server."
    [ -n "$(env_get STREAMHUB_SAMPLES_URL)" ] && warn "Samples: add DNS A record '$(s="$(env_get STREAMHUB_SAMPLES_URL)"; s="${s#*://}"; echo "${s%%/*}")' -> this server."
  fi
  # Cluster readiness: without a private-IP Redis bind, edges get redis://<ip>:6379
  # and crash-loop (AWS-POC2 finding #2). Warn prominently unless the operator
  # already bound it via --cluster-redis-bind.
  if [ -z "$CLUSTER_REDIS_BIND" ]; then
    PRIV_IP="$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.)' | head -1 || true)"
    echo
    warn "CLUSTER: Redis is bound to 127.0.0.1 ONLY — edge nodes cannot join the media plane yet."
    warn "  Joining edges are handed redis://<this-host>:6379 and their LiveKit/ingress/egress will"
    warn "  crash-loop until Redis listens on a reachable PRIVATE IP. To enable clustering, re-run:"
    warn "      curl -fsSL $SELF_URL | sudo bash -s -- --cluster-redis-bind ${PRIV_IP:-<ORIGIN_PRIVATE_IP>}"
    warn "  (also password-protects Redis + advertises the right URL to edges), then per edge:"
    warn "      ufw allow from <edge-private-ip> to any port 6379 proto tcp"
    warn "  Single-node / standalone? You can ignore this."
  fi
elif [ "$CDN_EDGE" = "1" ]; then
  ok "StreamHub CDN edge '$NODE_NAME' is running and registered (node id: $(env_get STREAMHUB_NODE_ID))."
  echo "  Viewers       : $(env_get STREAMHUB_CDN_EDGE_URL)/hls/<app>/<room>/index.m3u8"
  echo "  Origin        : $(env_get STREAMHUB_CDN_ORIGIN_URL)   (set STREAMHUB_HLS_CDN=on on the origin)"
  echo "  Cache         : ${CDN_CACHE_DIR:-/var/cache/nginx/hls}$([ "$EDGE_CACHE_TMPFS" != off ] && echo " (tmpfs $EDGE_CACHE_TMPFS)")   ·   config: $CDN_EDGE_CONF"
  echo "  Heartbeat     : every 15s → $API_BASE (conns / req / tx Mbps from stub_status on $CDN_STATUS_LISTEN)"
  echo "  Manage        : streamhub status | logs | restart | doctor | upgrade   (systemctl status nginx)"
  echo "  Version       : $INSTALL_DIR/VERSION (v${TARGET_VERSION})   ·   installer log: $INSTALL_DIR/logs/install.log"
  echo "  Firewall      : open 80/tcp (and 443 if TLS terminates here) to viewers"
else
  ok "StreamHub edge node '$NODE_NAME' is running and registered."
  echo "  Sharing Redis : $(env_get REDIS_URL)   (LiveKit room affinity via the origin)"
  echo "  Media ports   : 7880-7882, RTMP 1935, WHIP 8080"
  echo "  Manage        : streamhub status | logs -f | restart | doctor   (systemctl status streamhub)"
  echo "  Version       : $INSTALL_DIR/VERSION (v${TARGET_VERSION})   ·   installer log: $INSTALL_DIR/logs/install.log"
  echo "  Note          : the origin's Redis must be reachable from this node"
  echo "                  (private network/VPN recommended; see streamhub-docs/operations/INSTALL-NODE.md)"
fi
ok "Re-running this installer is safe + idempotent: it keeps .env/data, upgrades on a newer version (with a pre-upgrade DB backup), and re-stamps VERSION."
ok "============================================================"

# Anonymous install phone-home (last — only reached on success; never blocks).
if [ "$MODE" = "join" ]; then MODE_KIND="join"
elif [ "$EXISTING_INSTALL" = "1" ]; then MODE_KIND="upgrade"
else MODE_KIND="fresh"; fi
phone_home "$MODE_KIND"
