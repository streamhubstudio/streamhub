#!/usr/bin/env bash
# Real-media end-to-end validation of the Go core on a Linux Docker host.
#
#   test/e2e/run.sh                 # build HEAD, run every scenario on `ssh docker`, clean up
#   GO_CORE_REF=<ref> run.sh        # build another commit
#   E2E_HOST=<ssh alias> run.sh     # another Linux host (needs docker, ffmpeg, jq, curl)
#   E2E_KEEP=1 run.sh               # leave the stack running (tear down later with down.sh)
#   E2E_KEEP_IMAGES=1 run.sh        # keep pulled images (faster re-runs; a later run then
#                                   # treats them as pre-existing — remove them by hand)
#   E2E_EGRESS=0 run.sh             # no egress container (HLS/recording/snapshot/restream SKIP)
#   E2E_CLUSTER=1 run.sh            # + cluster (2 Go nodes, heartbeat, grid) and Vision Edge with the
#                                   # real runtime (E2E_EDGE_VENV: venv with ultralytics, default ~/sh-e2e-edge/venv)
#   E2E_BINARY=<path> run.sh        # use a pre-built linux/amd64 core instead of building REF
#   E2E_SHAPE=sameuid run.sh        # host without passwordless sudo: core + egress as the host uid
#                                   # (default compose: core root + umask 002, egress uid 1001/gid 0)
#
# Stack (remote/compose.yml, host networking, non-default ports): Redis,
# LiveKit server v1.13.11, ingress v1.5.0, egress v1.15.0, SeaweedFS S3, a MediaMTX
# restream sink; plus a webhook receiver (receiver/, Go, built from this checkout
# like the remote/ scripts) and the Go core
# binary cross-compiled linux/amd64 from a git worktree of the ref (never the
# working tree). Scenarios: remote/scenarios.sh. Exit 0 = no FAIL.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
HOST="${E2E_HOST:-docker}"
REF="${GO_CORE_REF:-HEAD}"
RUN="sh-e2e-$(date +%Y%m%d-%H%M%S)"

OUT="$(mktemp -d)"
WT="$OUT/wt"
git -C "$ROOT" worktree add -q --detach "$WT" "$REF"
trap 'git -C "$ROOT" worktree remove --force "$WT" >/dev/null 2>&1 || true; rm -rf "$OUT"' EXIT
SHA="$(git -C "$ROOT" rev-parse --short "$REF")"
echo "[run] building $REF ($SHA) linux/amd64"
if [ -n "${E2E_BINARY:-}" ]; then   # pre-built linux/amd64 binary (e.g. an uncommitted fix)
  echo "[run] using E2E_BINARY=$E2E_BINARY instead"; cp "$E2E_BINARY" "$OUT/streamhub"
else
( cd "$WT/streamhub-core-go" && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
    go build -trimpath -ldflags "-s -w -X github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/version.Override=e2e-$SHA" \
    -o "$OUT/streamhub" ./cmd/streamhub )
fi
# The webhook receiver is harness, not product: built from this checkout.
( cd "$HERE/../.." && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -o "$OUT/receiver" ./test/e2e/receiver )

REMOTE_DIR="$(ssh "$HOST" 'echo $HOME')/$RUN"
echo "[run] staging $HOST:$REMOTE_DIR"
ssh "$HOST" "mkdir -p '$REMOTE_DIR'"
scp -q "$HERE"/remote/* "$OUT/streamhub" "$OUT/receiver" "$HOST:$REMOTE_DIR/"
scp -q "$ROOT/install.sh" "$HOST:$REMOTE_DIR/installer.sh"   # cluster.sh reuses its heartbeat agent
# Edge-capable vision app for the cluster/edge scenarios (composed into
# <repo>/plugins-vendor by the apps tooling; the Go registry discovers
# <exe dir>/plugins-vendor).
VENDOR="$ROOT/plugins-vendor/occupancy"
if [ -d "$VENDOR" ]; then
  ssh "$HOST" "mkdir -p '$REMOTE_DIR/plugins-vendor'"
  tar -C "$(dirname "$VENDOR")" --exclude __pycache__ -czf - occupancy | ssh "$HOST" "tar -C '$REMOTE_DIR/plugins-vendor' -xzf -"
fi

set +e
ssh "$HOST" "cd '$REMOTE_DIR' && E2E_EGRESS=${E2E_EGRESS:-1} E2E_SHAPE=${E2E_SHAPE:-compose} ./up.sh || exit 1; E2E_EGRESS=${E2E_EGRESS:-1} E2E_SHAPE=${E2E_SHAPE:-compose} ./scenarios.sh; rc=\$?; if [ '${E2E_CLUSTER:-0}' = 1 ]; then ./cluster.sh; EDGE_VENV='${E2E_EDGE_VENV:-}' ./edge.sh; ! grep -q '^FAIL' results.txt; else exit \$rc; fi"
RC=$?
mkdir -p "$HERE/.last-run"
scp -q "$HOST:$REMOTE_DIR/results.txt" "$HOST:$REMOTE_DIR/logs/*" "$HOST:$REMOTE_DIR/receiver.jsonl" "$HERE/.last-run/" 2>/dev/null
if [ "${E2E_KEEP:-0}" = 1 ]; then
  echo "[run] kept: ssh $HOST '$REMOTE_DIR/down.sh' to clean up"
else
  ssh "$HOST" "E2E_SHAPE=${E2E_SHAPE:-compose} E2E_KEEP_IMAGES=${E2E_KEEP_IMAGES:-0} '$REMOTE_DIR/down.sh'"
fi
echo "[run] logs + results in $HERE/.last-run (exit $RC)"
exit $RC
