#!/usr/bin/env bash
# =============================================================================
# StreamHub Agent installer — one-liner for Linux (x86_64 / ARM) with systemd.
#
#   curl -fsSL https://streamhub.studio/agent.sh | sudo bash
#   curl -fsSL https://streamhub.studio/agent.sh | sudo bash -s -- --non-interactive
#   sudo ./scripts/install.sh            # from a source checkout
#   sudo ./scripts/install.sh --uninstall
#
# What it does (idempotent — safe to re-run):
#   1. Detects OS + CPU arch (x86_64 | aarch64 | armv7).
#   2. Installs the streamhub-agent binary to /usr/local/bin:
#        - downloads a prebuilt release for the arch (STREAMHUB_AGENT_RELEASE_URL),
#        - else builds from source when run inside a checkout with a toolchain,
#        - else prints clear instructions.
#   3. Seeds /etc/streamhub-agent/{config.yml,secrets.ini} if absent (never
#      overwrites an existing config).
#   4. Installs + enables a systemd service (auto-start on boot, restart on fail).
#   5. Prints next steps (edit config, systemctl start streamhub-agent).
#
# Detection is a per-camera MODE (config: detect.mode). The DEFAULT is `remote`
# (server-side inference — the agent only subscribes), which needs NO ML deps:
# this installer never pulls torch/ultralytics unless you ask for edge mode with
# --edge (or STREAMHUB_AGENT_EDGE=1). Edge mode runs inference on the device and
# needs python3 + scripts/requirements.txt.
#
# Embedded BusyBox devices (Luckfox) have no systemd — use etc/S95streamhub.
# Every flag has a STREAMHUB_AGENT_* env equivalent so --non-interactive needs
# no TTY. `--help` lists them all.
# =============================================================================

set -euo pipefail

INSTALLER_VERSION="1.0.0"
SERVICE_NAME="streamhub-agent"
BINDIR_DEFAULT="/usr/local/bin"
CONF_DIR="/etc/streamhub-agent"
DATA_DIR="/var/lib/streamhub-agent"
RELEASE_URL_DEFAULT="https://streamhub.studio/agent"

# ---- colored logging (mirrors the main StreamHub install.sh) ----------------
c_info='\033[1;36m'; c_ok='\033[1;32m'; c_warn='\033[1;33m'; c_err='\033[1;31m'; c_off='\033[0m'
log()  { printf "${c_info}[agent]${c_off} %s\n" "$*"; }
ok()   { printf "${c_ok}[agent]${c_off} %s\n" "$*"; }
warn() { printf "${c_warn}[agent]${c_off} %s\n" "$*"; }
die()  { printf "${c_err}[agent] ERROR:${c_off} %s\n" "$*" >&2; exit 1; }

usage() {
  cat <<'USAGE'
StreamHub Agent installer — Linux (x86_64 / ARM) with systemd.

  curl -fsSL https://streamhub.studio/agent.sh | sudo bash [-s -- FLAGS]
  sudo ./scripts/install.sh [FLAGS]

Flags
  --uninstall            Stop + disable the service and remove the binary.
  --purge                With --uninstall, also delete config + data dirs.
  --release-url <url>    Base URL for prebuilt binaries (default below).
  --build                Force building from source (needs a checkout + toolchain).
  --bindir <dir>         Where to install the binary (default /usr/local/bin).
  --no-service           Install the binary/config but skip the systemd unit.
  --no-ffmpeg            Do not try to apt-install ffmpeg (a runtime dependency).
  --edge                 Also install the edge-mode ML deps (python3 + pip +
                         scripts/requirements.txt: ultralytics/opencv). Only
                         needed for on-device inference; remote mode does not.
  --fleet                Also install the fleet-management deps (python3 + pip +
                         paho-mqtt) for scripts/fleet_agent.py. Enable it with
                         `fleet.interval` in config.yml. See features/fleet.md.
  --non-interactive      Accepted for parity; this installer never prompts.
  --version              Print installer version and exit.
  -h, --help             This help.

Layout
  binary   <bindir>/streamhub-agent          (default /usr/local/bin)
  config   /etc/streamhub-agent/config.yml
  secrets  /etc/streamhub-agent/secrets.ini
  data     /var/lib/streamhub-agent          (records, snapshots)
  service  /etc/systemd/system/streamhub-agent.service

Env equivalents
  STREAMHUB_AGENT_RELEASE_URL   (default https://streamhub.studio/agent)
      Prebuilt asset URL is <release-url>/streamhub-agent-linux-<arch>,
      where <arch> is x86_64, aarch64 or armv7.
  STREAMHUB_AGENT_BINDIR, STREAMHUB_AGENT_SKIP_OS_CHECK=1
  STREAMHUB_AGENT_EDGE=1        Same as --edge (install on-device ML deps).
  STREAMHUB_AGENT_FLEET=1       Same as --fleet (install paho-mqtt for fleet).
USAGE
}

# ---- flags ------------------------------------------------------------------
BINDIR="${STREAMHUB_AGENT_BINDIR:-$BINDIR_DEFAULT}"
RELEASE_URL="${STREAMHUB_AGENT_RELEASE_URL:-$RELEASE_URL_DEFAULT}"
DO_UNINSTALL=0
DO_PURGE=0
FORCE_BUILD=0
NO_SERVICE=0
INSTALL_FFMPEG=1
INSTALL_EDGE="${STREAMHUB_AGENT_EDGE:-0}"
INSTALL_FLEET="${STREAMHUB_AGENT_FLEET:-0}"

while [ $# -gt 0 ]; do
  case "$1" in
    --uninstall)        DO_UNINSTALL=1 ;;
    --purge)            DO_PURGE=1 ;;
    --release-url)      shift; RELEASE_URL="${1:-}" ;;
    --build)            FORCE_BUILD=1 ;;
    --bindir)           shift; BINDIR="${1:-}" ;;
    --no-service)       NO_SERVICE=1 ;;
    --no-ffmpeg)        INSTALL_FFMPEG=0 ;;
    --edge)             INSTALL_EDGE=1 ;;
    --fleet)            INSTALL_FLEET=1 ;;
    --non-interactive)  : ;;   # accepted for parity — this installer never prompts
    --version)          echo "streamhub-agent installer $INSTALLER_VERSION"; exit 0 ;;
    -h|--help)          usage; exit 0 ;;
    *)                  die "unknown flag: $1 (see --help)" ;;
  esac
  shift
done

[ -n "$BINDIR" ]      || die "--bindir requires a path"
[ -n "$RELEASE_URL" ] || die "--release-url requires a URL"
BIN="$BINDIR/$SERVICE_NAME"

# ---- locate a source checkout (when not piped via curl) ---------------------
# BASH_SOURCE is a real path when run as a file; empty/"bash" when piped.
REPO_DIR=""
_self="${BASH_SOURCE[0]:-}"
if [ -n "$_self" ] && [ -f "$_self" ]; then
  _script_dir="$(cd "$(dirname "$_self")" && pwd)"
  if [ -f "$_script_dir/../Makefile" ]; then
    REPO_DIR="$(cd "$_script_dir/.." && pwd)"
  fi
fi

# ---- helpers ----------------------------------------------------------------
require_root() {
  [ "$(id -u)" = "0" ] || die "must run as root — use sudo (curl ... | sudo bash)."
}

have_systemd() { [ -d /run/systemd/system ]; }

detect_arch() {
  case "$(uname -m)" in
    x86_64|amd64)          echo "x86_64" ;;
    aarch64|arm64)         echo "aarch64" ;;
    armv7l|armv7|armhf)    echo "armv7" ;;
    armv6l)                echo "armv7" ;;   # closest prebuilt target
    *)                     uname -m ;;
  esac
}

os_gate() {
  if [ "${STREAMHUB_AGENT_SKIP_OS_CHECK:-0}" = "1" ]; then
    warn "STREAMHUB_AGENT_SKIP_OS_CHECK=1 — skipping the OS gate."
    return 0
  fi
  [ "$(uname -s)" = "Linux" ] || die "the agent installs on Linux only (this host is $(uname -s))."
  if [ -r /etc/os-release ]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    case "${ID:-}" in
      debian|ubuntu|raspbian)
        ok "OS check: ${PRETTY_NAME:-$ID} ($(detect_arch))" ;;
      *)
        warn "untested distro '${PRETTY_NAME:-${ID:-unknown}}' — proceeding as generic Linux." ;;
    esac
  else
    warn "no /etc/os-release — proceeding as generic Linux."
  fi
}

# fetch <url> <dest> — curl or wget; returns non-zero on any HTTP/transport error.
fetch() {
  local url="$1" dest="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$url" -o "$dest"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$dest" "$url"
  else
    die "need curl or wget to download the binary."
  fi
}

# place_binary <srcfile> — atomically install as $BIN (safe over a running one).
place_binary() {
  local src="$1" tmp
  mkdir -p "$BINDIR"
  tmp="$(mktemp "$BINDIR/.streamhub-agent.XXXXXX")" || die "cannot write to $BINDIR"
  cp "$src" "$tmp"
  chmod 0755 "$tmp"
  mv -f "$tmp" "$BIN"   # same-FS rename: replaces a running binary cleanly
}

build_from_source() {
  [ -n "$REPO_DIR" ] && [ -f "$REPO_DIR/Makefile" ] || return 1
  command -v make >/dev/null 2>&1 || return 1
  command -v gcc >/dev/null 2>&1 || command -v cc >/dev/null 2>&1 || return 1
  log "building streamhub-agent from source in $REPO_DIR ..."
  ( cd "$REPO_DIR" && make clean >/dev/null 2>&1 || true; make ) || return 1
  [ -f "$REPO_DIR/streamhub-agent" ] || return 1
  place_binary "$REPO_DIR/streamhub-agent"
}

acquire_binary() {
  local arch bin_url tmp
  arch="$(detect_arch)"

  if [ "$FORCE_BUILD" = "1" ]; then
    build_from_source && { ok "built + installed $BIN (arch=$arch)"; return 0; }
    die "source build requested but failed — need a checkout with make, gcc and libssl-dev."
  fi

  bin_url="$RELEASE_URL/streamhub-agent-linux-$arch"
  tmp="$(mktemp)"
  log "downloading prebuilt binary: $bin_url"
  if fetch "$bin_url" "$tmp" && [ -s "$tmp" ]; then
    place_binary "$tmp"
    rm -f "$tmp"
    ok "installed $BIN (arch=$arch)"
    return 0
  fi
  rm -f "$tmp"
  warn "no prebuilt binary for arch '$arch' at $RELEASE_URL"

  if build_from_source; then
    ok "built from source + installed $BIN (arch=$arch)"
    return 0
  fi

  die "could not obtain a streamhub-agent binary for '$arch'. Options:
  - point --release-url / STREAMHUB_AGENT_RELEASE_URL at a reachable release host, or
  - run this from a source checkout with make + gcc + libssl-dev installed, or
  - cross-build for '$arch' on a build box (see README build matrix) and copy it to $BIN."
}

ensure_ffmpeg() {
  if command -v ffmpeg >/dev/null 2>&1; then
    ok "ffmpeg present: $(command -v ffmpeg)"
    return 0
  fi
  warn "ffmpeg not found — required for streaming, recording and snapshots."
  if [ "$INSTALL_FFMPEG" = "1" ] && command -v apt-get >/dev/null 2>&1; then
    log "installing ffmpeg via apt ..."
    if DEBIAN_FRONTEND=noninteractive apt-get update -qq \
       && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ffmpeg; then
      ok "ffmpeg installed"
    else
      warn "ffmpeg install failed — install it manually before starting the agent."
    fi
  else
    warn "install ffmpeg manually before starting the agent."
  fi
}

# Edge mode only: install python3 + the ML deps. Never called unless --edge.
ensure_edge_deps() {
  log "edge mode requested — installing on-device ML deps (ultralytics/opencv) ..."
  if ! command -v python3 >/dev/null 2>&1; then
    if command -v apt-get >/dev/null 2>&1; then
      DEBIAN_FRONTEND=noninteractive apt-get install -y -qq python3 python3-pip \
        || warn "could not apt-install python3/pip — install them manually for edge mode."
    else
      warn "python3 not found and no apt — install python3 + pip for edge mode."
    fi
  fi
  command -v python3 >/dev/null 2>&1 || { warn "skipping ML deps: no python3."; return 0; }

  local req=""
  if [ -n "$REPO_DIR" ] && [ -f "$REPO_DIR/scripts/requirements.txt" ]; then
    req="$REPO_DIR/scripts/requirements.txt"
  else
    req="$(mktemp)"
    if ! fetch "$RELEASE_URL/requirements.txt" "$req" 2>/dev/null || [ ! -s "$req" ]; then
      printf 'ultralytics>=8.3.0\nopencv-python-headless>=4.8.0\nnumpy>=1.24.0\npsutil>=5.9.0\n' > "$req"
    fi
  fi

  if python3 -m pip install --upgrade -r "$req"; then
    ok "edge ML deps installed"
  else
    warn "pip install failed — edge mode will not run until these deps are present:"
    warn "  python3 -m pip install -r scripts/requirements.txt"
  fi
}

write_config_template() {
  # Built-in fallback used only when no config.example.yml is available
  # (pure curl|bash with no reachable release template).
  cat > "$1" <<'YAML'
# StreamHub Agent configuration. API token + S3 keys live in secrets.ini.
agent:
  id: agent-0001
  timezone: America/Argentina/Buenos_Aires
  records_enabled: true
  records_ttl: 30
  rtmps: true
  stream_server: rtmps://media.example.com:443/live/
  callback_url: media.example.com      # StreamHub host, no scheme
  tenant: myapp                         # StreamHub app name (alias: app)
  encryption_key: ""

mqtt:
  host: media.example.com
  port: 1883

storage:
  endpoint: s3.us-east-1.amazonaws.com
  bucket: my-records-bucket
  region: us-east-1

cameras:
  - id: c001
    ip: 192.168.1.50
    status: true
    record_path: /var/lib/streamhub-agent/records/c001
    rtsp: 'rtsp://USER:PASSWORD@192.168.1.50:554/Streaming/Channels/101'
    resolution: '1920:1080'
    room: ''
    detect:
      enabled: true
      mode: remote                      # remote | edge | off (default remote)
      plugin: yolo                      # remote mode: yolo | deface
      poll_interval: 2
      model: yolo11n                    # edge mode: on-device model
      confidence: 0.5
YAML
}

write_secrets_template() {
  cat > "$1" <<'INI'
# StreamHub Agent secrets — real credentials. Keep this file 0600; never commit.
[streamhub]
api_token = sk_replace_me

[s3]
access_key =
secret_key =
INI
}

install_config() {
  mkdir -p "$CONF_DIR" "$DATA_DIR/records" "$DATA_DIR/snapshots"
  chmod 700 "$CONF_DIR"

  local cfg="$CONF_DIR/config.yml"
  if [ -f "$cfg" ]; then
    ok "config exists — keeping $cfg"
  elif [ -n "$REPO_DIR" ] && [ -f "$REPO_DIR/config.example.yml" ]; then
    install -m 0644 "$REPO_DIR/config.example.yml" "$cfg"
    ok "seeded $cfg from config.example.yml"
  elif fetch "$RELEASE_URL/config.example.yml" "$cfg" 2>/dev/null && [ -s "$cfg" ]; then
    ok "seeded $cfg from release template"
  else
    write_config_template "$cfg"
    ok "seeded $cfg from built-in template"
  fi

  local sec="$CONF_DIR/secrets.ini"
  if [ -f "$sec" ]; then
    ok "secrets exist — keeping $sec"
  elif [ -n "$REPO_DIR" ] && [ -f "$REPO_DIR/secrets.example.ini" ]; then
    install -m 0600 "$REPO_DIR/secrets.example.ini" "$sec"
    ok "seeded $sec from secrets.example.ini"
  else
    write_secrets_template "$sec"
    chmod 600 "$sec"
    ok "created $sec (fill in your API token)"
  fi
}

# ONVIF discovery tool (scripts/onvif.py — stdlib-only Python, NO pip deps).
# Installed next to the binary so `streamhub-agent onvif scan|sync` finds it
# (the C dispatcher looks in <exe_dir>/scripts/onvif.py). Best-effort: the
# agent itself never needs it, and it is skipped when unavailable.
install_onvif_tool() {
  local dest="$BINDIR/scripts/onvif.py"
  mkdir -p "$BINDIR/scripts"
  if [ -n "$REPO_DIR" ] && [ -f "$REPO_DIR/scripts/onvif.py" ]; then
    install -m 0755 "$REPO_DIR/scripts/onvif.py" "$dest"
    ok "installed ONVIF tool → $dest"
  elif fetch "$RELEASE_URL/onvif.py" "$dest" 2>/dev/null && [ -s "$dest" ]; then
    chmod 755 "$dest"
    ok "installed ONVIF tool (release) → $dest"
  else
    rm -f "$dest"
    warn "ONVIF tool not installed (no checkout and no release copy) —"
    warn "  'streamhub-agent onvif' needs scripts/onvif.py next to the binary."
  fi
  if ! command -v python3 >/dev/null 2>&1; then
    warn "python3 not found — 'streamhub-agent onvif scan|sync' needs a Python 3"
    warn "  interpreter (stdlib only, no pip packages)."
  fi
}

# Fleet management companion (scripts/fleet_agent.py — paho-mqtt). Installed next
# to the binary so the C supervisor (fleet_tick) finds it at
# <exe_dir>/scripts/fleet_agent.py. Best-effort; only runs when config.yml sets
# fleet.interval > 0.
install_fleet_tool() {
  local dest="$BINDIR/scripts/fleet_agent.py"
  mkdir -p "$BINDIR/scripts"
  if [ -n "$REPO_DIR" ] && [ -f "$REPO_DIR/scripts/fleet_agent.py" ]; then
    install -m 0755 "$REPO_DIR/scripts/fleet_agent.py" "$dest"
    ok "installed fleet companion → $dest"
  elif fetch "$RELEASE_URL/fleet_agent.py" "$dest" 2>/dev/null && [ -s "$dest" ]; then
    chmod 755 "$dest"
    ok "installed fleet companion (release) → $dest"
  else
    rm -f "$dest"
    warn "fleet companion not installed (no checkout and no release copy) —"
    warn "  fleet management needs scripts/fleet_agent.py next to the binary."
  fi
}

# Fleet mode: install python3 + paho-mqtt. Only called with --fleet.
ensure_fleet_deps() {
  log "fleet mode requested — installing the MQTT companion deps (paho-mqtt) ..."
  if ! command -v python3 >/dev/null 2>&1; then
    if command -v apt-get >/dev/null 2>&1; then
      DEBIAN_FRONTEND=noninteractive apt-get install -y -qq python3 python3-pip \
        || warn "could not apt-install python3/pip — install them manually for fleet mode."
    else
      warn "python3 not found and no apt — install python3 + pip for fleet mode."
    fi
  fi
  command -v python3 >/dev/null 2>&1 || { warn "skipping fleet deps: no python3."; return 0; }

  local req=""
  if [ -n "$REPO_DIR" ] && [ -f "$REPO_DIR/scripts/requirements-fleet.txt" ]; then
    req="$REPO_DIR/scripts/requirements-fleet.txt"
  else
    req="$(mktemp)"
    if ! fetch "$RELEASE_URL/requirements-fleet.txt" "$req" 2>/dev/null || [ ! -s "$req" ]; then
      printf 'paho-mqtt>=1.6.1\npsutil>=5.9.0\n' > "$req"
    fi
  fi

  if python3 -m pip install --upgrade -r "$req"; then
    ok "fleet deps installed (paho-mqtt)"
  else
    warn "pip install failed — fleet management will not run until paho-mqtt is present:"
    warn "  python3 -m pip install -r scripts/requirements-fleet.txt"
  fi
}

install_service() {
  if [ "$NO_SERVICE" = "1" ]; then
    warn "--no-service: skipping the systemd unit."
    return 0
  fi
  if ! have_systemd; then
    warn "systemd not detected — skipping service install."
    warn "start manually: $BIN $CONF_DIR/config.yml $CONF_DIR/secrets.ini"
    return 0
  fi
  local unit="/etc/systemd/system/$SERVICE_NAME.service"
  cat > "$unit" <<EOF
[Unit]
Description=StreamHub Edge Agent (CCTV ingest + remote detection subscriber)
Documentation=https://streamhub.studio
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=$BIN $CONF_DIR/config.yml $CONF_DIR/secrets.ini
WorkingDirectory=$DATA_DIR
Restart=on-failure
RestartSec=5s
KillMode=mixed
TimeoutStopSec=15s
StandardOutput=journal
StandardError=journal
SyslogIdentifier=$SERVICE_NAME

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable "$SERVICE_NAME" >/dev/null 2>&1 || true
  ok "installed + enabled systemd service ($SERVICE_NAME)"
}

do_uninstall() {
  if have_systemd; then
    systemctl stop "$SERVICE_NAME" 2>/dev/null || true
    systemctl disable "$SERVICE_NAME" 2>/dev/null || true
    rm -f "/etc/systemd/system/$SERVICE_NAME.service"
    systemctl daemon-reload 2>/dev/null || true
    ok "stopped + removed systemd service"
  fi
  rm -f "$BIN"
  rm -f "$BINDIR/scripts/onvif.py"
  rm -f "$BINDIR/scripts/fleet_agent.py"
  rmdir "$BINDIR/scripts" 2>/dev/null || true
  ok "removed $BIN"
  if [ "$DO_PURGE" = "1" ]; then
    rm -rf "$CONF_DIR" "$DATA_DIR"
    ok "purged $CONF_DIR and $DATA_DIR"
  else
    log "kept config + data ($CONF_DIR, $DATA_DIR) — remove with --uninstall --purge"
  fi
}

print_next_steps() {
  ok "StreamHub Agent installed."
  cat <<STEPS

Next steps:
  1. Edit the config:    $CONF_DIR/config.yml
       agent.callback_url  = your StreamHub host (no scheme)
       agent.tenant        = your StreamHub app name
       agent.stream_server = rtmps://<host>:443/live/
       cameras[].rtsp      = each camera's RTSP URL
  2. Add your API token:  $CONF_DIR/secrets.ini    ([streamhub] api_token = sk_...)
  3. Start the agent:     systemctl start $SERVICE_NAME
  4. Watch the logs:      journalctl -u $SERVICE_NAME -f
  5. Local web UI:        http://<device-ip>/   (default admin/admin — change it)

ONVIF: discover the LAN's cameras and register them in StreamHub in one shot:
  streamhub-agent onvif scan     # find cameras + their RTSP URIs (read-only)
  streamhub-agent onvif sync     # scan + create the StreamHub ingresses
Camera credentials go in config.yml under onvif: (see the README's ONVIF section).

Detection modes (per camera, config detect.mode):
  remote  (default) server-side inference — the agent only subscribes. No ML deps.
  edge              on-device inference — set detect.mode: edge and install the ML
                    deps: re-run with --edge, or  pip install -r scripts/requirements.txt
  off               no detection.

Uninstall: re-run this installer with --uninstall (add --purge to drop config+data).
STEPS
}

# ---- main -------------------------------------------------------------------
main() {
  require_root

  if [ "$DO_UNINSTALL" = "1" ]; then
    do_uninstall
    exit 0
  fi

  os_gate

  local was_active=0
  if have_systemd && systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
    was_active=1
  fi

  acquire_binary
  ensure_ffmpeg
  [ "$INSTALL_EDGE" = "1" ] && ensure_edge_deps
  [ "$INSTALL_FLEET" = "1" ] && ensure_fleet_deps
  install_config
  install_onvif_tool
  install_fleet_tool
  install_service

  if [ "$was_active" = "1" ]; then
    systemctl restart "$SERVICE_NAME" && ok "restarted the running service to pick up the new binary"
  fi

  print_next_steps
}

main
