#!/usr/bin/env bash
# Packer step 10 — `install.sh --prepare-image`: Docker + compose, the source in
# /opt/streamhub, the pinned stack images pulled and the core image built.
# No .env, no secrets, no domain, nothing started, no telemetry ping.
# Env (from the template): STREAMHUB_PROXY, STREAMHUB_SRC_URL, STREAMHUB_REPO_URL.
set -euo pipefail
INSTALLER=/tmp/streamhub-install.sh
[ -r "$INSTALLER" ] || { echo "[10-prepare] $INSTALLER missing" >&2; exit 1; }

STREAMHUB_NO_TELEMETRY=1 GIT_TERMINAL_PROMPT=0 \
  bash "$INSTALLER" --prepare-image --non-interactive --proxy "${STREAMHUB_PROXY:-caddy}"

# Keep the installer the image was prepared with OUTSIDE the install dir (a
# later source mirror never touches it): first-boot.sh runs this copy, which is
# the one that understands the .image-prepared marker.
install -D -m 0755 "$INSTALLER" /usr/local/lib/streamhub/install.sh

[ -f /opt/streamhub/.image-prepared ] || { echo "[10-prepare] marker missing — prepare did not finish" >&2; exit 1; }
[ ! -e /opt/streamhub/.env ] || { echo "[10-prepare] .env must not exist in the image" >&2; exit 1; }
echo "[10-prepare] $(tr '\n' ' ' < /opt/streamhub/.image-prepared)"
docker image ls --format '  {{.Repository}}:{{.Tag}}  {{.Size}}'
