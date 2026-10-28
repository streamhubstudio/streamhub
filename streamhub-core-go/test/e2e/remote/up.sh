#!/usr/bin/env bash
# Bring up the media stack + webhook receiver + the Go core, then configure
# the `live` app (MinIO S3 + signed callbacks to the receiver).
set -euo pipefail
source "$(dirname "$0")/env.sh"
cd "$E2E_DIR"
log() { printf '[up] %s\n' "$*"; }

docker images --format '{{.Repository}}:{{.Tag}}' | sort > .images-before
# Never fill a shared host's disk: image pulls need compressed + unpacked space.
NEED_GB=$([ "$E2E_EGRESS" = 1 ] && echo 14 || echo 4)
FREE_GB=$(df -BG --output=avail / | tail -1 | tr -dc 0-9)
missing=0; for i in livekit/livekit-server:v1.13.11 livekit/ingress:v1.5.0; do grep -qxF "$i" .images-before || missing=1; done
[ "$E2E_EGRESS" = 1 ] && ! grep -qxF livekit/egress:v1.15.0 .images-before && missing=1
[ "$E2E_EGRESS" = 1 ] && ! grep -qxF chrislusf/seaweedfs:latest .images-before && missing=1
if [ "$missing" = 1 ] && [ "$FREE_GB" -lt "$NEED_GB" ]; then
  log "only ${FREE_GB}G free on / — need ~${NEED_GB}G to pull the images (E2E_EGRESS=$E2E_EGRESS); aborting"; exit 3
fi
mkdir -p "$E2E_DATA" logs

log "compose up ($E2E_PROJECT)"
docker compose "${COMPOSE_FILES[@]}" up -d --quiet-pull 2>&1 | tail -n 20

wait_for() { # name url tries
  for _ in $(seq 1 "${3:-60}"); do curl -sf -o /dev/null "$2" && { log "$1 ready"; return 0; }; sleep 1; done
  log "$1 NOT ready ($2)"; return 1
}
wait_for livekit "http://127.0.0.1:$P_LK/"
if [ "$E2E_EGRESS" = 1 ]; then
wait_for filer "http://127.0.0.1:$P_S3_FILER/" 90
wait_for sink "http://127.0.0.1:$P_SINK_API/v3/paths/list"
S3_C="$(docker compose "${COMPOSE_FILES[@]}" ps -q s3)"
for _ in $(seq 1 30); do
  echo "s3.bucket.create -name $BUCKET" | docker exec -i "$S3_C" weed shell -master="127.0.0.1:$P_S3_MASTER" >/dev/null 2>&1 &&
    curl -sf "http://127.0.0.1:$P_S3_FILER/buckets/$BUCKET/?pretty=y" -H 'accept: application/json' >/dev/null && break
  sleep 2
done
curl -sf -o /dev/null "http://127.0.0.1:$P_S3_FILER/buckets/$BUCKET/" -H 'accept: application/json' || { log "bucket create failed"; exit 1; }
wait_for s3 "http://127.0.0.1:$P_MINIO/status" 30 || true
log "bucket $BUCKET created"
fi

nohup ./receiver "$P_RECV" "$E2E_DIR/receiver.jsonl" >logs/receiver.log 2>&1 &
echo $! > .receiver.pid
for _ in $(seq 1 20); do [ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$P_RECV/ping")" = 200 ] && break; sleep 0.5; done
rm -f receiver.jsonl   # drop the readiness ping
log "receiver ready"

cat > core.env <<ENV
NODE_ENV=production
PORT=$P_CORE
HOST=127.0.0.1
DATA_DIR=$E2E_DATA
WEB_DIR=$E2E_DIR/web
PUBLIC_BASE_URL=$CORE
LIVEKIT_URL=ws://127.0.0.1:$P_LK
LIVEKIT_API_KEY=$LK_KEY
LIVEKIT_API_SECRET=$LK_SECRET
PUBLIC_WS_URL=ws://127.0.0.1:$P_LK
RTMP_PUBLIC_HOST=127.0.0.1
STREAMHUB_LIVEKIT_INGRESS_RTMP_PORT=$P_ING_RTMP
REDIS_URL=redis://127.0.0.1:$P_REDIS
STREAMHUB_JWT_SECRET=e2e-jwt-secret-0123456789abcdefghij
ADMIN_USER=$ADMIN_USER
ADMIN_PASS=$ADMIN_PASS
STREAMHUB_AUTHZ_ENFORCE=on
STREAMHUB_CALLBACK_ALLOW_HOSTS=127.0.0.1
STREAMHUB_ALLOW_PRIVATE_S3_ENDPOINT=1
STREAMHUB_SNAPSHOT_SOURCE=http://127.0.0.1:$P_CORE/hls/{app}/{room}/index.m3u8
STREAMHUB_CLUSTER_TOKEN=$CLUSTER_TOKEN
STREAMHUB_PLUGINS_VENDOR_DIR=$E2E_DIR/plugins-vendor
LOG_LEVEL=debug
ENV
mkdir -p plugins-vendor web && echo '<!doctype html><title>e2e</title>' > web/index.html
if [ "$E2E_SHAPE" = compose ]; then
  sudo -n true || { log "E2E_SHAPE=compose needs passwordless sudo (or use E2E_SHAPE=sameuid)"; exit 4; }
  # root + umask 002, as deploy/core-entrypoint.sh runs it
  nohup sudo -n env $(grep -v '^#' core.env | xargs) sh -c 'umask 002; exec ./streamhub' >logs/core.log 2>&1 &
else
  set -a; source core.env; set +a
  nohup ./streamhub >logs/core.log 2>&1 &
fi
echo $! > .core.pid
log "core shape: $E2E_SHAPE"
wait_for core "$CORE/api/v1/health" 30

TOKEN="$(curl -sf -X POST "$CORE/api/v1/auth/login" -H 'content-type: application/json' \
  -d "{\"user\":\"$ADMIN_USER\",\"password\":\"$ADMIN_PASS\"}" | jq -r '.data.token // .token')"
[ -n "$TOKEN" ] && [ "$TOKEN" != null ] || { log "login failed"; exit 1; }
echo "$TOKEN" > .token
api() { curl -s -w '\n%{http_code}' -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' "$@"; }

r="$(api -X PUT "$CORE/api/v1/apps/$APP/s3" -d "{\"provider\":\"minio\",\"bucket\":\"$BUCKET\",\"region\":\"us-east-1\",\"endpoint\":\"http://127.0.0.1:$P_MINIO\",\"forcePathStyle\":true,\"prefix\":\"e2e\",\"key\":\"$MINIO_USER\",\"secret\":\"$MINIO_PASS\"}")"
log "PUT s3 → $(tail -1 <<<"$r")"
r="$(api -X PATCH "$CORE/api/v1/apps/$APP" -d "{\"callbackUrl\":\"http://127.0.0.1:$P_RECV/hook\",\"callbackSecret\":\"$CB_SECRET\"}")"
log "PATCH callbacks → $(tail -1 <<<"$r")"
grep -q "url: http://127.0.0.1:$P_RECV/hook" "$E2E_DATA/apps/$APP/config.yaml" || { log "callback URL not persisted"; exit 1; }
log "stack up"
