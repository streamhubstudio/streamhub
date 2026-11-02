#!/usr/bin/env bash
# Packer step 99 — image check. Reproduces the essentials of DigitalOcean's
# marketplace-partners `99-img-check.sh` (the same rules Vultr's and AWS's image
# reviews apply) plus StreamHub-specific invariants. Prints PASS/WARN/FAIL per
# check and exits 1 on any FAIL, which fails the Packer build — a dirty image
# never becomes a snapshot.
#   standalone:  sudo bash 99-img-check.sh   (on a booted-but-unconfigured image)
set -uo pipefail

FAILS=0; WARNS=0
pass() { printf '[PASS] %s\n' "$*"; }
warn() { printf '[WARN] %s\n' "$*"; WARNS=$((WARNS + 1)); }
fail() { printf '[FAIL] %s\n' "$*"; FAILS=$((FAILS + 1)); }
INSTALL_DIR=/opt/streamhub
SELF="$(readlink -f "$0" 2>/dev/null || echo "$0")"

[ "$(id -u)" = "0" ] || { echo "run as root"; exit 2; }

# ---- OS -------------------------------------------------------------------------
. /etc/os-release
case "${ID}:${VERSION_ID}" in
  ubuntu:24.04|ubuntu:26.04|debian:12|debian:13) pass "OS: $PRETTY_NAME ($(uname -m))" ;;
  *) fail "OS '$PRETTY_NAME' is not a supported base (Ubuntu 24.04/26.04, Debian 12/13)" ;;
esac
[ "$(uname -m)" = "x86_64" ] || fail "architecture $(uname -m) (images are x86_64 only)"

# ---- cloud-init ---------------------------------------------------------------------
if command -v cloud-init >/dev/null 2>&1; then pass "cloud-init installed ($(cloud-init --version 2>&1 | awk '{print $NF}'))"
else fail "cloud-init is not installed (required by every marketplace)"; fi
if [ -d /var/lib/cloud/instances ] && [ -n "$(ls -A /var/lib/cloud/instances 2>/dev/null)" ]; then
  fail "/var/lib/cloud/instances is not empty (run: cloud-init clean)"
else pass "cloud-init state is clean"; fi

# ---- SSH keys / passwords -------------------------------------------------------------
for f in /root/.ssh/authorized_keys /home/*/.ssh/authorized_keys; do
  [ -e "$f" ] || continue
  if [ -s "$f" ]; then fail "SSH keys present in $f"; else warn "empty $f (remove it)"; fi
done
[ -n "$(find /root /home -maxdepth 3 -path '*/.ssh/*' -name 'id_*' 2>/dev/null)" ] && fail "private SSH keys found under /root or /home"
ls /etc/ssh/ssh_host_*key* >/dev/null 2>&1 && warn "SSH host keys present (cloud-init regenerates them; the cleanup deletes them)"
root_state="$(passwd -S root 2>/dev/null | awk '{print $2}')"
case "$root_state" in L|NP|LK) pass "root password locked/unset ($root_state)" ;; *) fail "root has a usable password (passwd -S: $root_state)" ;; esac
while IFS=: read -r user hash _; do
  case "$hash" in ''|'*'|'!'*|'x') ;; *) [ "$user" = "root" ] || fail "user '$user' has a password set" ;; esac
done < /etc/shadow

# ---- history / temp / logs ---------------------------------------------------------------
for h in /root/.bash_history /home/*/.bash_history; do
  [ -s "$h" ] && fail "shell history left in $h"
done
leftovers="$(find /tmp /var/tmp -mindepth 1 -maxdepth 1 ! -path "$SELF" ! -name 'script_*.sh' ! -name 'systemd-private-*' ! -name 'snap-private-tmp' 2>/dev/null | head -5)"
[ -n "$leftovers" ] && warn "files left in /tmp or /var/tmp: $(echo "$leftovers" | tr '\n' ' ')"
nonempty="$(find /var/log -type f -size +0 ! -path '/var/log/journal/*' 2>/dev/null | head -5)"
if [ -n "$nonempty" ]; then warn "non-empty logs: $(echo "$nonempty" | tr '\n' ' ')"; else pass "/var/log is clean"; fi
[ -n "$(find /var/log -type f \( -name '*.gz' -o -name '*.[0-9]' \) 2>/dev/null | head -1)" ] && fail "rotated log archives left in /var/log"
[ -s /etc/machine-id ] && warn "/etc/machine-id is set (every instance would share it — truncate it)"

# ---- updates ----------------------------------------------------------------------------
if command -v apt-get >/dev/null 2>&1; then
  upg="$(apt-get -s -o Debug::NoLocking=1 dist-upgrade 2>/dev/null | grep -c '^Inst' || true)"
  sec="$(apt-get -s -o Debug::NoLocking=1 dist-upgrade 2>/dev/null | grep '^Inst' | grep -ci security || true)"
  if [ "${sec:-0}" -gt 0 ]; then fail "$sec pending SECURITY update(s)"
  elif [ "${upg:-0}" -gt 0 ]; then warn "$upg pending update(s) (non-security)"
  else pass "no pending updates"; fi
fi

# ---- firewall -----------------------------------------------------------------------------
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q 'Status: active'; then pass "ufw active"
else warn "no active host firewall (ufw) — fine on AWS (security groups), expected on DO/Vultr"; fi

# ---- StreamHub invariants -------------------------------------------------------------------
[ -f "$INSTALL_DIR/.image-prepared" ] && pass "image prepared: $(tr '\n' ' ' < "$INSTALL_DIR/.image-prepared")" \
  || fail "$INSTALL_DIR/.image-prepared missing (install.sh --prepare-image did not finish)"
for f in .env .install_id .install-profile .join-profile; do
  [ -e "$INSTALL_DIR/$f" ] && fail "$INSTALL_DIR/$f must not be baked (per-instance state)"
done
[ -e "$INSTALL_DIR/data" ] && fail "$INSTALL_DIR/data must not be baked (DBs/recordings are per instance)"
[ -e /var/lib/streamhub/first-boot.done ] && fail "first-boot already marked done"
[ -x "$INSTALL_DIR/first-boot.sh" ] && pass "first-boot.sh installed" || fail "$INSTALL_DIR/first-boot.sh missing"
[ -x /usr/local/lib/streamhub/install.sh ] || fail "/usr/local/lib/streamhub/install.sh missing"
systemctl is-enabled streamhub-first-boot.service >/dev/null 2>&1 && pass "streamhub-first-boot.service enabled" \
  || fail "streamhub-first-boot.service not enabled"
if command -v docker >/dev/null 2>&1; then
  [ -z "$(docker ps -aq 2>/dev/null)" ] && pass "no containers baked" || fail "containers exist in the image (nothing may run before first boot)"
  imgs="$(docker image ls --format '{{.Repository}}:{{.Tag}}' 2>/dev/null)"
  for want in streamhub-core:local redis:7-alpine livekit/livekit-server livekit/ingress livekit/egress caddy:2-alpine; do
    printf '%s\n' "$imgs" | grep -q "^$want" && pass "image present: $want" || fail "image missing: $want"
  done
else
  fail "docker is not installed"
fi

echo "------------------------------------------------------------"
echo "image check: $FAILS fail(s), $WARNS warning(s)"
[ "$FAILS" -eq 0 ]
