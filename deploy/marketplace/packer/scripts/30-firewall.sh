#!/usr/bin/env bash
# Packer step 30 — host firewall (ENABLE_UFW=1): deny inbound by default, allow
# SSH (rate-limited) + exactly the public StreamHub ports. 3020 (core) and 6379
# (redis) stay closed: they bind loopback anyway. TURN (5349/tcp, 3478/udp) is
# opened by the installer only when --turn is used.
set -euo pipefail
[ "${ENABLE_UFW:-1}" = "1" ] || { echo "[30-firewall] ENABLE_UFW=0 — skipped"; exit 0; }
export DEBIAN_FRONTEND=noninteractive
command -v ufw >/dev/null 2>&1 || apt-get -y -qq install ufw

ufw --force reset >/dev/null
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw limit 22/tcp comment 'ssh' >/dev/null
for p in 80 443 1935 7880 7881 8080; do ufw allow "$p/tcp" comment 'streamhub' >/dev/null; done
ufw allow 7882/udp comment 'streamhub webrtc media' >/dev/null
ufw --force enable >/dev/null
ufw status verbose
