#!/usr/bin/env bash
# StreamHub Encoder — e2e test entrypoint (synthetic + real media).
#
#   test/e2e/run.sh [suite ...]        default: all suites except soak/density
#   suites: formats outputs hotswap failover crash latency netem density soak
#   env:    REAL_MEDIA=/path/clip.mp4  GPU=auto|on|off  SOAK_MIN=60  KEEP=1
#
# Needs a Linux Docker host (nvidia runtime for NVENC). Builds the images,
# brings up enc-e2e-* containers on network enc-e2e-net, runs the suites and
# writes test/e2e/results/<run>/summary.tsv. Never touches other containers.
set -uo pipefail
cd "$(dirname "$0")/../.."
source test/e2e/lib.sh
for f in test/e2e/suites/*.sh; do source "$f"; done

SUITES=("$@")
[[ ${#SUITES[@]} -eq 0 ]] && SUITES=(formats outputs hotswap failover crash latency netem)

if [[ ${SKIP_BUILD:-0} != 1 ]]; then
  log "building images"
  bash test/e2e/build-images.sh || exit 1
fi
infra_up
[[ ${KEEP:-0} == 1 ]] || trap infra_down EXIT
for s in "${SUITES[@]}"; do
  log "=== suite $s"
  delete_all_channels
  "suite_$s"
done
delete_all_channels
log "summary: $SUMMARY"
column -t -s $'\t' "$SUMMARY" >&2
! grep -q $'\tFAIL\t' "$SUMMARY"
