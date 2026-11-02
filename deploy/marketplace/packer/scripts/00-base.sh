#!/usr/bin/env bash
# Packer step 00 — base OS: wait for cloud-init, then a full, non-interactive
# upgrade (the DO/Vultr checklists reject images with pending security updates).
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a

# The provider's own first boot (apt sources, SSH keys, growpart) must finish
# before we touch apt, or we race its dpkg lock.
if command -v cloud-init >/dev/null 2>&1; then
  cloud-init status --wait >/dev/null 2>&1 || true
fi
for _ in $(seq 1 60); do
  fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1 || break
  sleep 5
done

apt-get update -qq
apt-get -y -qq -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold dist-upgrade
apt-get -y -qq install ca-certificates curl git openssl rsync acl
echo "[00-base] OS up to date: $(. /etc/os-release && echo "$PRETTY_NAME") $(uname -m)"
