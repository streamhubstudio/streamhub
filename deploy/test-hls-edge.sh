#!/usr/bin/env bash
# deploy/test-hls-edge.sh — behavioural regression test for deploy/nginx-hls-edge.conf (needs Docker).
#
# Puts the edge config in front of a fake StreamHub origin (nginx serving a live playlist with the
# origin's real headers — internal/platform/web/hls_cache.go with STREAMHUB_HLS_CDN=on) and checks
# the two bugs measured in planning/LOADTEST-4-REPORT.md plus the cache itself:
#   1. exactly ONE Access-Control-Allow-Origin (a duplicate `*, *` breaks every browser player);
#   2. after a quiet spell the FIRST playlist request is the current one, not an arbitrarily old
#      STALE copy (that left viewers 20–49 s behind live for the whole session);
#   3. segments are cached (second request is a HIT).
#
# usage: deploy/test-hls-edge.sh [edge-conf]
#   EDGE_TEST_IMAGE  image with nginx + curl (default nginx:1.27; any Debian nginx image works)
#   NGINX_BIN        nginx binary inside it (default nginx)
set -euo pipefail

CONF=${1:-$(dirname "$0")/nginx-hls-edge.conf}
IMG=${EDGE_TEST_IMAGE:-nginx:1.27}
NGINX=${NGINX_BIN:-nginx}
ID=hlsedge-test-$$
W=$(mktemp -d)
FAILS=0

cleanup() {
  docker rm -f "$ID-origin" "$ID-edge" >/dev/null 2>&1 || true
  docker network rm "$ID" >/dev/null 2>&1 || true
  rm -rf "$W"
}
trap cleanup EXIT

ok()   { echo "  ok   $*"; }
fail() { echo "  FAIL $*"; FAILS=$((FAILS + 1)); }

mkdir -p "$W/origin/hls/app/room"
cat > "$W/origin.conf" <<'NG'
events {}
http {
  server {
    listen 80;
    location ~ \.m3u8$ {
      root /srv;
      add_header Cache-Control "public, max-age=1, stale-while-revalidate=2" always;
      add_header Access-Control-Allow-Origin "*" always;
    }
    location ~ \.ts$ {
      root /srv;
      add_header Cache-Control "public, max-age=31536000, immutable" always;
      add_header Access-Control-Allow-Origin "*" always;
    }
  }
}
NG
playlist() {
  printf '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:%s\n#EXTINF:4.0,\nseg%s.ts\n' "$1" "$1" \
    > "$W/origin/hls/app/room/index.m3u8"
}
playlist 1
echo segment > "$W/origin/hls/app/room/seg1.ts"

# The config under test, its two >>> markers pointed at the fake origin (plain HTTP, private link).
{
  echo 'events {}'
  echo 'http {'
  sed -e "s#proxy_pass https://origin.example.com;#proxy_pass http://$ID-origin;#" \
      -e 's#server_name edge.example.com;#server_name _;#' "$CONF"
  echo '}'
} > "$W/edge.conf"
grep -q "proxy_pass http://$ID-origin;" "$W/edge.conf" || { echo "FAIL: origin marker not found in $CONF"; exit 1; }

docker network create "$ID" >/dev/null
docker run -d --name "$ID-origin" --network "$ID" -v "$W/origin:/srv:ro" -v "$W/origin.conf:/t/nginx.conf:ro" \
  --entrypoint "$NGINX" "$IMG" -c /t/nginx.conf -g 'daemon off;' >/dev/null
docker run -d --name "$ID-edge" --network "$ID" -v "$W/edge.conf:/t/nginx.conf:ro" \
  --entrypoint sh "$IMG" -c "mkdir -p /var/cache/nginx/hls && exec $NGINX -c /t/nginx.conf -g 'daemon off;'" >/dev/null

get() { docker exec "$ID-edge" curl -s -D - "http://127.0.0.1$1"; }
for _ in $(seq 1 50); do get /hls/app/room/index.m3u8 >/dev/null 2>&1 && break; sleep 0.2; done

echo "edge config: $CONF"
r=$(get /hls/app/room/index.m3u8)
n=$(grep -ci '^access-control-allow-origin:' <<<"$r" || true)
if [ "$n" = 1 ]; then ok "one Access-Control-Allow-Origin"; else fail "Access-Control-Allow-Origin appears $n times"; fi

# Quiet spell longer than max-age + stale-while-revalidate, while the live playlist moves on.
playlist 15
sleep 5
r=$(get /hls/app/room/index.m3u8)
if grep -q 'seg15.ts' <<<"$r"; then
  ok "first request after a quiet spell is the live playlist ($(grep -i '^x-cache-status' <<<"$r" | tr -d '\r'))"
else
  fail "first request after a quiet spell served an old playlist ($(grep -i '^x-cache-status' <<<"$r" | tr -d '\r'))"
fi

get /hls/app/room/seg1.ts >/dev/null
if get /hls/app/room/seg1.ts | grep -qi '^x-cache-status: HIT'; then ok "segments are cached"; else fail "segment not served from cache"; fi

if [ "$FAILS" != 0 ]; then echo "$FAILS check(s) failed"; exit 1; fi
echo "PASS"
