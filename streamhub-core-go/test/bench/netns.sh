#!/usr/bin/env bash
# Run a command (as the invoking user) inside a private network namespace
# with a plain loopback. Needed on WSL2 mirrored networking, where TCP to
# 127.0.0.1 is policy-routed through the Windows host (loopback0) and new
# connections cap at ~100/s — the benchmark would measure Hyper-V, not the core.
#   sudo ./netns.sh <command…>
set -euo pipefail
exec unshare -n bash -c 'ip link set lo up; exec sudo -u "$SUDO_USER" -H "$@"' _ "$@"
