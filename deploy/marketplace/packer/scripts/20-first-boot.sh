#!/usr/bin/env bash
# Packer step 20 — first-boot wiring:
#   /opt/streamhub/first-boot.sh              the setup script (domain/email → install)
#   streamhub-first-boot.service              runs it after cloud-final (user-data path)
#   /etc/update-motd.d/99-streamhub           pending / running / done banner
#   /etc/profile.d/streamhub-first-boot.sh    prompts on the first interactive root login
set -euo pipefail
SRC=/tmp/image

install -m 0755 /tmp/streamhub-first-boot.sh /opt/streamhub/first-boot.sh
install -m 0644 "$SRC/streamhub-first-boot.service" /etc/systemd/system/streamhub-first-boot.service
install -m 0755 "$SRC/99-streamhub-motd" /etc/update-motd.d/99-streamhub
install -m 0644 "$SRC/streamhub-first-boot-profile.sh" /etc/profile.d/streamhub-first-boot.sh
install -d -m 0755 /var/lib/streamhub
install -d -m 0700 /etc/streamhub

systemctl daemon-reload
systemctl enable streamhub-first-boot.service
systemctl enable docker.service >/dev/null 2>&1 || true
echo "[20-first-boot] first-boot wiring installed (unit enabled for cloud-init.target)"
