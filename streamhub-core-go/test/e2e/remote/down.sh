#!/usr/bin/env bash
# Tear everything down: core, receiver, ffmpeg, the compose stack (+ volumes),
# root-owned egress output, the images this run pulled, and the run dir.
set -uo pipefail
source "$(dirname "$0")/env.sh"
cd "$E2E_DIR"
# the compose-shape core runs under sudo (root): sudo relays the signal to it
[ -f .core.pid ] && { kill "$(cat .core.pid)" 2>/dev/null || sudo -n kill "$(cat .core.pid)" 2>/dev/null; }
[ -f .receiver.pid ] && kill "$(cat .receiver.pid)" 2>/dev/null
sleep 1
pkill -f "ffmpeg .*127.0.0.1:$P_ING_RTMP" 2>/dev/null
docker compose "${COMPOSE_FILES[@]}" down -v --remove-orphans 2>&1 | tail -n 3
# egress wrote as root: delete through a container (redis image is on the host)
docker run --rm -v "$E2E_DIR:/w" redis:6.2-alpine rm -rf /w/data 2>/dev/null
if [ "${E2E_KEEP_IMAGES:-0}" != 1 ] && [ -f .images-before ]; then
  docker images --format '{{.Repository}}:{{.Tag}}' | grep -vxF -f .images-before | grep -v '<none>' | xargs -r docker rmi 2>&1 | tail -n 5
fi
cd / && rm -rf "$E2E_DIR"
echo "[down] cleaned $E2E_DIR"
