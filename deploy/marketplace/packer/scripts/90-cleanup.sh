#!/usr/bin/env bash
# Packer step 90 — marketplace cleanup. Reproduces the essentials of
# DigitalOcean's marketplace-partners `90-cleanup.sh` (also what Vultr and AWS
# expect): no SSH keys, no shell history, no logs, no per-instance identity, a
# clean cloud-init state — plus StreamHub's own per-instance state, so every
# server booted from the image generates its own secrets.
# Runs LAST (with 99-img-check.sh): the authorized_keys it drops are the ones
# Packer itself is connected with (the open session survives).
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
INSTALL_DIR=/opt/streamhub

# ---- packages ----------------------------------------------------------------
apt-get -y -qq autoremove --purge
apt-get -y -qq autoclean
apt-get -y -qq clean

# ---- StreamHub per-instance state (must never be baked) ------------------------
rm -f  "$INSTALL_DIR/.env" "$INSTALL_DIR/.env.tmp" "$INSTALL_DIR/.install_id" \
       "$INSTALL_DIR/.install-profile" "$INSTALL_DIR/.join-profile"
rm -rf "$INSTALL_DIR/data"
rm -rf "${INSTALL_DIR:?}/logs/"* "${INSTALL_DIR:?}/backups/"* 2>/dev/null || true
rm -f  /var/lib/streamhub/first-boot.done /var/lib/streamhub/first-boot.running /var/lib/streamhub/first-boot.lock
rm -f  /etc/streamhub/first-boot.env /etc/streamhub/heartbeat.env /etc/streamhub/edge.env
rm -f  /var/log/streamhub-first-boot.log
# Docker regenerates its engine id; no containers/volumes exist (nothing started).
rm -f  /var/lib/docker/engine-id

# ---- temp files ------------------------------------------------------------------
rm -rf /tmp/* /tmp/.[!.]* /var/tmp/* 2>/dev/null || true

# ---- SSH: no keys of any kind ------------------------------------------------------
# Host keys are regenerated per instance by cloud-init (cc_ssh); user keys are
# injected per instance from the provider's metadata.
rm -f /root/.ssh/authorized_keys /home/*/.ssh/authorized_keys
rm -f /etc/ssh/ssh_host_*
touch /etc/ssh/revoked_keys && chmod 600 /etc/ssh/revoked_keys

# ---- shell history / dotfile leftovers ---------------------------------------------
unset HISTFILE
rm -f /root/.bash_history /home/*/.bash_history /root/.lesshst /root/.viminfo \
      /root/.wget-hsts /root/.python_history /root/.sudo_as_admin_successful \
      /home/*/.sudo_as_admin_successful 2>/dev/null || true

# ---- machine identity: regenerated on first boot -------------------------------------
truncate -s 0 /etc/machine-id
[ -L /var/lib/dbus/machine-id ] || { rm -f /var/lib/dbus/machine-id; ln -s /etc/machine-id /var/lib/dbus/machine-id 2>/dev/null || true; }
rm -f /var/lib/systemd/random-seed

# ---- cloud-init: run again on the first boot of every instance --------------------
cloud-init clean --logs
rm -rf /var/lib/cloud/instances/*

# ---- logs ------------------------------------------------------------------------------
find /var/log -type f \( -name '*.gz' -o -name '*.[0-9]' -o -name '*.old' -o -name '*-????????' \) -delete
# (the binary journal is rotated + vacuumed instead of truncated under journald)
find /var/log -type f ! -path '/var/log/journal/*' -exec truncate -s 0 {} +
journalctl --rotate >/dev/null 2>&1 || true
journalctl --vacuum-time=1s >/dev/null 2>&1 || true

# ---- zero free space (smaller snapshot), then flush ----------------------------------
if [ "${ZERO_FREE_SPACE:-1}" = "1" ]; then
  dd if=/dev/zero of=/zerofile bs=4M status=none 2>/dev/null || true
  sync; rm -f /zerofile
fi
sync
echo "[90-cleanup] done"
