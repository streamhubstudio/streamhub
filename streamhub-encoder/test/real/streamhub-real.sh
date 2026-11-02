#!/usr/bin/env bash
# REAL test against a real StreamHub stack (LiveKit + ingress + egress + core
# from this repo's docker-compose.yml), isolated as compose project "enc-sh".
#
#   test/real/streamhub-real.sh up        build core image + start the stack
#   test/real/streamhub-real.sh today     "works today" mode: sk_ app token →
#                                         ingress via REST → RTMP + WHIP push
#   test/real/streamhub-real.sh pairing   native device plane (needs a core with
#                                         internal/devices, e.g. feat/encoder-core:
#                                         CORE_SRC=<dir with that tree> … up)
#   test/real/streamhub-real.sh down
#
# env: REPO (repo root copy on this host), REAL_MEDIA, ENC_IMAGE (enc-e2e:dev),
#      RES (results dir). Linux host only (host networking). Ports used on the
#      host: 3020 6379 7880-7882 1935 8080 9090 6789-6791 + encoderd 18090.
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=${REPO:-$(cd "$HERE/../../.." && pwd)}
CORE_SRC=${CORE_SRC:-$REPO}
ENC_IMAGE=${ENC_IMAGE:-enc-e2e:dev}
RES=${RES:-$HERE/results/$(date -u +%Y%m%dT%H%M%SZ)}
REAL_MEDIA=${REAL_MEDIA:-}
P=enc-sh
API=http://127.0.0.1:3020/api/v1
mkdir -p "$RES"
SUMMARY=$RES/summary.tsv
[[ -f $SUMMARY ]] || printf 'suite\ttest\tresult\tdetails\n' >"$SUMMARY"
log() { printf '\033[36m[%s]\033[0m %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
result() {
  printf '%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$4" >>"$SUMMARY"
  printf '%-5s %-10s %-34s %s\n' "$3" "$1" "$2" "$4" >&2
}
dc() { (cd "$REPO" && docker compose -p $P --env-file "$REPO/.env.enc" -f docker-compose.yml -f "$HERE/compose.enc.yml" "$@"); }
envv() { grep "^$1=" "$REPO/.env.enc" | cut -d= -f2-; }
sh_api() { # METHOD PATH [JSON] (global token)
  curl -s -X "$1" -H "Authorization: Bearer $(envv STREAMHUB_API_TOKEN)" -H 'Content-Type: application/json' ${3:+--data-binary "$3"} "$API$2"
}
enc_api() {
  docker exec enc-sh-encoder curl -s -X "$1" -H "Authorization: Bearer enc-real" -H 'Content-Type: application/json' ${3:+--data-binary "$3"} "http://127.0.0.1:18090/api/v1$2"
}

cmd_up() {
  # refuse to start over somebody else's services
  local busy
  busy=$(ss -ltnH '( sport = :3020 or sport = :7880 or sport = :1935 or sport = :8080 or sport = :6379 )' 2>/dev/null | grep -v "enc-sh" | wc -l)
  if ((busy)) && ! docker ps --format '{{.Names}}' | grep -q '^enc-sh-'; then
    log "ports 3020/7880/1935/8080/6379 are in use by something else — aborting"; ss -ltnp | head; exit 1
  fi
  if [[ ! -f $REPO/.env.enc ]]; then
    local key secret
    key=API$(head -c 9 /dev/urandom | od -An -tx1 | tr -d ' \n')
    secret=$(head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 40)
    cat >"$REPO/.env.enc" <<EOF
STREAMHUB_DOMAIN=127.0.0.1
LIVEKIT_API_KEY=$key
LIVEKIT_API_SECRET=$secret
HOST=127.0.0.1
PORT=3020
LIVEKIT_URL=ws://127.0.0.1:7880
PUBLIC_WS_URL=ws://127.0.0.1:7880
RTMP_PUBLIC_HOST=127.0.0.1
PUBLIC_BASE_URL=http://127.0.0.1:3020
REDIS_URL=redis://127.0.0.1:6379
STREAMHUB_JWT_SECRET=$(head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 40)
ADMIN_USER=admin
ADMIN_PASS=$(head -c 16 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 20)
STREAMHUB_API_TOKEN=sk_$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 32)
STREAMHUB_AUTHZ_ENFORCE=on
DATA_DIR=/data
STREAMHUB_HOST_DATA_DIR=$REPO/data-enc
LOG_LEVEL=info
NODE_ENV=production
INSTALL_DEFACE_WORKER=0
INSTALL_VENDORED_WORKER_DEPS=
STREAMHUB_DEVICES_ENABLE=on
INGRESS_CPUS=8
INGRESS_MEM_LIMIT=4g
STREAMHUB_MEDIAMTX_ENABLE=true
STREAMHUB_LIVEKIT_INGRESS_RTMP_PORT=11935
STREAMHUB_RTMP_PASSTHROUGH_ENABLE=true
STREAMHUB_MEDIAMTX_SRT_ENABLE=true
STREAMHUB_PASSTHROUGH_HEVC=on
STREAMHUB_MEDIAMTX_HOOK_SECRET=$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 32)
EOF
    ln -sf .env.enc "$REPO/.env"
  fi
  # the app S3 of this test lives on 127.0.0.1: allow it past the core's SSRF guard
  grep -q '^STREAMHUB_ALLOW_PRIVATE_S3_ENDPOINT=' "$REPO/.env.enc" || echo 'STREAMHUB_ALLOW_PRIVATE_S3_ENDPOINT=1' >>"$REPO/.env.enc"
  mkdir -p "$REPO/data-enc"
  if [[ $CORE_SRC != "$REPO" ]]; then
    log "building core image from $CORE_SRC"
    (cd "$CORE_SRC" && DOCKER_BUILDKIT=1 docker build -q --build-arg INSTALL_DEFACE_WORKER=0 --build-arg INSTALL_VENDORED_WORKER_DEPS= -f deploy/Dockerfile -t enc-sh-core:local .) || exit 1
  else
    log "building core image from $REPO"
    (cd "$REPO" && DOCKER_BUILDKIT=1 docker build -q --build-arg INSTALL_DEFACE_WORKER=0 --build-arg INSTALL_VENDORED_WORKER_DEPS= -f deploy/Dockerfile -t enc-sh-core:local .) || exit 1
  fi
  dc --profile mediamtx up -d redis livekit ingress egress core mediamtx || exit 1
  local i
  for i in $(seq 1 120); do curl -sf "$API/health" >/dev/null && break; sleep 1; done
  curl -sf "$API/health" >/dev/null || { log "core not healthy"; dc logs core | tail -30; exit 1; }
  envv STREAMHUB_API_TOKEN | docker exec -i enc-sh-core /app/streamhub-core seed-token - bootstrap >/dev/null 2>&1 || true
  log "stack up: $(curl -s "$API/health" | head -c 200)"
}

s3cli() { docker run --rm --network host -e AWS_ACCESS_KEY_ID=encs3 -e AWS_SECRET_ACCESS_KEY=encs3-secret-123 -e AWS_DEFAULT_REGION=us-east-1 amazon/aws-cli:latest --endpoint-url http://127.0.0.1:19000 "$@"; }

cmd_down() {
  docker rm -f enc-sh-encoder enc-sh-s3 >/dev/null 2>&1
  dc down -v --remove-orphans >/dev/null 2>&1
  log "stack down"
}

encoder_up() {
  docker rm -f enc-sh-encoder >/dev/null 2>&1
  local gpu=()
  docker info 2>/dev/null | grep -q 'Runtimes:.*nvidia' && gpu=(--runtime nvidia --gpus all -e NVIDIA_DRIVER_CAPABILITIES=video,compute,utility)
  local media=()
  [[ -n $REAL_MEDIA ]] && media=(-v "$REAL_MEDIA:/media/real.mp4:ro")
  docker run -d --name enc-sh-encoder --network host "${gpu[@]}" "${media[@]}" -v "$RES:/res" \
    -e ENCODERD_API_TOKEN=enc-real -e ENCODERD_TLS=off -e ENCODERD_LISTEN=127.0.0.1:18090 -e ENCODERD_PORT_RANGE=42000-42999 "$ENC_IMAGE" serve >/dev/null
  local i
  for i in $(seq 1 60); do docker exec enc-sh-encoder curl -sf http://127.0.0.1:18090/api/v1/health >/dev/null 2>&1 && break; sleep 0.5; done
}

app_and_token() {
  sh_api POST /apps '{"name":"enc","displayName":"Encoder e2e"}' >/dev/null
  local id
  id=$(sh_api GET /apps | jq -r '(if type=="array" then . else (.data // .) end)[] | select(.name=="enc") | .id' | head -1)
  sh_api POST /tokens "{\"name\":\"encoder-$(date +%s)\",\"scope\":\"app\",\"appId\":$id}" | jq -r '(.data.token // .token)'
}

probe() { docker run --rm --network host --entrypoint ffprobe "$ENC_IMAGE" -v error -rw_timeout 15000000 -show_entries stream=codec_name,width,height,avg_frame_rate,channels -show_entries format=duration -of json "$1" 2>/dev/null | jq -c '{v:([.streams[]|select(.width!=null)][0]), a:([.streams[]|select(.channels!=null)][0]), d:.format.duration}'; }

lk() { docker run --rm --network host livekit/livekit-cli:latest "$@" --url ws://127.0.0.1:7880 --api-key "$(envv LIVEKIT_API_KEY)" --api-secret "$(envv LIVEKIT_API_SECRET)" 2>&1; }

cmd_today() {
  local tok
  tok=$(app_and_token)
  [[ $tok == sk_* ]] || { result streamhub app-token FAIL "could not mint an app token: $tok"; return 1; }
  result streamhub app-token PASS "app 'enc' + app-scoped sk_ token minted through the REST API"
  # start clean: remove ingresses left by a previous run
  local old
  for old in $(curl -s -H "Authorization: Bearer $tok" "$API/apps/enc/ingress" | jq -r '.data[]?.ingressId'); do
    curl -s -X DELETE -H "Authorization: Bearer $tok" "$API/apps/enc/ingress/$old" >/dev/null
  done
  encoder_up
  # RTMP: test pattern 1080p with B-frames; WHIP: the real clip (looped file)
  local in='{"type":"test","pattern":"ball"}'
  local win='{"type":"test","pattern":"ball"}'
  [[ -n $REAL_MEDIA ]] && win='{"type":"file","uri":"/media/real.mp4","loop":true}'
  local enc=x264
  docker exec enc-sh-encoder gst-inspect-1.0 --exists nvh264enc 2>/dev/null && enc=nvenc
  enc_api POST /channels "{\"id\":\"rtmp\",\"enabled\":true,\"input\":$in,\"video\":{\"codec\":\"h264\",\"encoder\":\"x264\",\"width\":1920,\"height\":1080,\"fps\":\"30\",\"bitrateKbps\":5000,\"bframes\":2},
    \"outputs\":[{\"id\":\"sh\",\"type\":\"streamhub\",\"enabled\":true,\"streamhub\":{\"baseUrl\":\"http://127.0.0.1:3020\",\"app\":\"enc\",\"token\":\"$tok\",\"room\":\"cam-rtmp\",\"protocol\":\"rtmp\",\"deleteOnRemove\":true}}]}" >/dev/null
  enc_api POST /channels "{\"id\":\"whip\",\"enabled\":true,\"input\":$win,\"overlay\":{\"timecode\":true},\"video\":{\"codec\":\"h264\",\"encoder\":\"auto\",\"width\":1280,\"height\":720,\"fps\":\"30\",\"bitrateKbps\":2500,\"lowLatency\":true},
    \"outputs\":[{\"id\":\"sh\",\"type\":\"streamhub\",\"enabled\":true,\"streamhub\":{\"baseUrl\":\"http://127.0.0.1:3020\",\"app\":\"enc\",\"token\":\"$tok\",\"room\":\"cam-whip\",\"protocol\":\"whip\",\"deleteOnRemove\":true}}]}" >/dev/null
  sleep 25
  enc_api GET /channels | jq -c '.[]|{id:.config.id,state:.status.state,encoder:.status.encoder,outputs:[.status.outputs[]|{id,state,target,error}]}' | tee "$RES/encoder-status.json" >&2
  local s
  for c in rtmp whip; do
    s=$(enc_api GET "/channels/$c/status" | jq -r '.outputs[0].state')
    [[ $s == running ]] && result streamhub "encoder-$c-output" PASS "ingress resolved via REST, $(enc_api GET "/channels/$c/status" | jq -r '.outputs[0].target' | sed -E 's#(live/|w$).*#\1…#')" ||
      result streamhub "encoder-$c-output" FAIL "$(enc_api GET "/channels/$c/status" | jq -c '.outputs[0]|{state,error}')"
  done
  local ing
  ing=$(curl -s -H "Authorization: Bearer $tok" "$API/apps/enc/ingress")
  echo "$ing" | jq . >"$RES/ingress.json"
  for room in cam-rtmp cam-whip; do
    local row
    local k
    for k in $(seq 1 12); do # WHIP goes buffering → publishing once the ingress has a keyframe
      row=$(jq -c --arg r "$room" '[.data[] | select((.room // .roomName // "") | test($r))][0] | {ingressId, inputType, status, width, height, bitrate}' <<<"$ing")
      [[ $(jq -r .status <<<"$row") == publishing ]] && break
      sleep 5
      ing=$(curl -s -H "Authorization: Bearer $tok" "$API/apps/enc/ingress")
    done
    [[ $(jq -r .status <<<"$row") == publishing ]] && result streamhub "ingress-$room" PASS "LiveKit ingress $row" || result streamhub "ingress-$room" FAIL "$row"
  done
  local streams
  streams=$(curl -s -H "Authorization: Bearer $tok" "$API/apps/enc/streams")
  echo "$streams" | jq . >"$RES/streams.json"
  for room in cam-rtmp cam-whip; do
    local srow
    srow=$(jq -c --arg r "$room" '[(if type=="array" then . else (.data // .) end)[] | select(((.room // .roomName // .id // "")|tostring) | test($r))][0]' <<<"$streams")
    if [[ $srow != null && -n $srow ]]; then result streamhub "stream-listed-$room" PASS "$(jq -c '{id, room, status, source: (.source // .type // null)}' <<<"$srow")"; else result streamhub "stream-listed-$room" FAIL "not in GET /apps/enc/streams"; fi
  done
  # WebRTC side: the room has the ingress participant publishing video+audio tracks
  for room in enc-cam-rtmp enc-cam-whip; do
    local parts ingid outs i
    ingid=$(jq -r --arg r "${room#enc-}" '[.data[] | select((.room // .roomName // "") | test($r))][0].ingressId' <<<"$ing")
    # the ingress logs track stats once a minute: wait for the first round
    for i in $(seq 1 10); do
      parts=$(lk room participants list "$room")
      outs=$(docker logs enc-sh-ingress 2>&1 | grep "track stats update" | grep "$ingid" | grep -oE '"name": "output\.[a-z]+' | sort -u | tr '\n' ' ')
      grep -qE "tracks: ?[1-9]" <<<"$parts" && [[ $outs == *audio* && $outs == *video* ]] && break
      sleep 10
    done
    echo "$parts" >"$RES/participants-$room.txt"
    if grep -qE "tracks: ?[1-9]" <<<"$parts" && [[ $outs == *audio* && $outs == *video* ]]; then
      result streamhub "webrtc-tracks-$room" PASS "ingress participant in the LiveKit room; ingress publishing $outs($(grep -oE 'tracks: ?[0-9]+' <<<"$parts"))"
    else
      result streamhub "webrtc-tracks-$room" FAIL "$(tr '\n' ' ' <<<"$parts" | cut -c1-300)"
    fi
  done
  # HLS: start the live HLS egress for the RTMP stream and ffprobe the playlist
  local sid
  sid=$(jq -r '[(if type=="array" then . else (.data // .) end)[] | select(((.room // .roomName // "")|tostring) | test("cam-"))] | sort_by(.room) | .[0].streamId' <<<"$streams")
  local hls
  hls=$(curl -s -X POST -H "Authorization: Bearer $tok" "$API/apps/enc/streams/$(jq -rn --arg s "$sid" '$s|@uri')/hls/start")
  echo "$hls" >"$RES/hls-start.json"
  sleep 30
  local pl
  pl=$(curl -s -H "Authorization: Bearer $tok" "$API/apps/enc/streams/$(jq -rn --arg s "$sid" '$s|@uri')/hls" | jq -r '.data.playlistUrl // empty')
  local local_pl="http://127.0.0.1:3020/hls/enc/$(sed -E 's#.*/hls/enc/##' <<<"$pl")"
  local hp
  hp=$(probe "$local_pl")
  [[ $(jq -r .v.codec_name <<<"$hp") == h264 ]] && result streamhub hls-playback PASS "ffprobe $local_pl → $hp" || result streamhub hls-playback FAIL "start=$(cut -c1-200 <<<"$hls") playlist=$pl probe=$hp"
  # egress runs one room-composite job per 4 CPUs: stop the HLS egress first
  curl -s -X POST -H "Authorization: Bearer $tok" "$API/apps/enc/streams/$(jq -rn --arg s "$sid" '$s|@uri')/hls/stop" >/dev/null
  sleep 5
  # Recording: room-composite egress → MP4 uploaded to the app S3. The S3 is a
  # Versity S3 gateway (posix backend) on :19000 — the MinIO images are no
  # longer pullable anonymously from Docker Hub / quay.io.
  docker rm -f enc-sh-s3 >/dev/null 2>&1
  mkdir -p "$RES/s3"
  docker run -d --name enc-sh-s3 --network host -v "$RES/s3:/data" -e ROOT_ACCESS_KEY=encs3 -e ROOT_SECRET_KEY=encs3-secret-123 \
    versity/versitygw:latest --port 127.0.0.1:19000 posix /data >/dev/null
  sleep 3
  s3cli s3 mb s3://enc-rec >/dev/null 2>&1
  curl -s -X PUT -H "Authorization: Bearer $tok" -H 'Content-Type: application/json' --data-binary '{"provider":"minio","bucket":"enc-rec","region":"us-east-1","endpoint":"http://127.0.0.1:19000","forcePathStyle":true,"prefix":"streamhub/enc","key":"encs3","secret":"encs3-secret-123"}' "$API/apps/enc/s3" >"$RES/s3.json"
  local rec vod
  rec=$(curl -s -X POST -H "Authorization: Bearer $tok" -H 'Content-Type: application/json' --data-binary '{"roomName":"enc-cam-whip"}' "$API/apps/enc/recording/start")
  vod=$(jq -r '.data.vodId // empty' <<<"$rec")
  sleep 40
  curl -s -X POST -H "Authorization: Bearer $tok" "$API/apps/enc/recording/$vod/stop" >"$RES/recording-stop.json"
  local vrow i
  for i in $(seq 1 30); do
    vrow=$(curl -s -H "Authorization: Bearer $tok" "$API/apps/enc/vods/$vod")
    [[ $(jq -r '(.data // .).status' <<<"$vrow") =~ ready|uploaded|available ]] && break
    sleep 3
  done
  echo "$vrow" >"$RES/recording-vod.json"
  local vurl obj
  vurl=$(jq -r '(.data // .) | (.url // .presignedUrl // .playbackUrl // empty)' <<<"$vrow")
  obj=$(s3cli s3 ls --recursive s3://enc-rec 2>/dev/null | tail -3 | tr '\n' ' ')
  if [[ $obj == *.mp4* ]]; then
    local rp=""
    [[ -n $vurl ]] && rp=$(probe "$vurl")
    result streamhub recording PASS "egress MP4 uploaded to the app S3 (versitygw): $obj vod=$(jq -c '(.data // .) | {id,status}' <<<"$vrow") probe=$rp"
  else
    result streamhub recording FAIL "no MP4 (start=$(cut -c1-200 <<<"$rec"), vod=$(curl -s -H "Authorization: Bearer $tok" "$API/apps/enc/vods" | jq -c '(if type=="array" then . else (.data // .) end)[0] | {status, error}' 2>/dev/null))"
  fi
  # removing the output deletes the ingress (deleteOnRemove)
  enc_api DELETE /channels/rtmp/outputs/sh >/dev/null
  sleep 3
  local left
  left=$(curl -s -H "Authorization: Bearer $tok" "$API/apps/enc/ingress" | jq '[.data[] | select((.room // .roomName // "") | test("cam-rtmp"))] | length')
  [[ $left == 0 ]] && result streamhub output-removal-cleans-ingress PASS "ingress deleted in StreamHub" || result streamhub output-removal-cleans-ingress FAIL "$left ingress rows left"
}

cmd_pairing() {
  encoder_up
  enc_api POST /channels '{"id":"cam1","name":"Cámara 1","enabled":true,"input":{"type":"test","pattern":"ball"},"overlay":{"timecode":true},"video":{"codec":"h264","encoder":"x264","width":1280,"height":720,"fps":"30","bitrateKbps":2500,"lowLatency":true}}' >/dev/null
  enc_api POST /channels '{"id":"cam2","name":"Cámara 2 HEVC","enabled":true,"input":{"type":"test","pattern":"ball"},"overlay":{"timecode":true},"video":{"codec":"h265","encoder":"x265","width":1280,"height":720,"fps":"25","bitrateKbps":2000,"preset":"veryfast","bframes":2}}' >/dev/null
  local st
  st=$(enc_api POST /streamhub/pair '{"baseUrl":"http://127.0.0.1:3020"}')
  local code
  code=$(jq -r .displayCode <<<"$st")
  [[ $code =~ ^[A-Z0-9]{4}-[A-Z0-9]{4}$ ]] && result pairing code-shown PASS "encoder shows $code" || { result pairing code-shown FAIL "$st"; return 1; }
  local t0
  t0=$(date +%s)
  local tok
  tok=$(app_and_token)
  local claim
  claim=$(curl -s -X POST -H "Authorization: Bearer $tok" -H 'Content-Type: application/json' --data-binary "{\"code\":\"$code\",\"name\":\"Encoder e2e\"}" "$API/apps/enc/devices/claim")
  local dev
  dev=$(jq -r '.data.id // .id' <<<"$claim")
  [[ $dev == dev_* ]] && result pairing claim PASS "operator claimed $dev" || { result pairing claim FAIL "$claim"; return 1; }
  local i ps
  for i in $(seq 1 60); do
    ps=$(enc_api GET /streamhub | jq -r .state)
    [[ $ps == connected ]] && break
    sleep 1
  done
  [[ $ps == connected ]] && result pairing ws-connected PASS "device WS up $(($(date +%s) - t0)) s after claim" || { result pairing ws-connected FAIL "$(enc_api GET /streamhub)"; return 1; }
  local link
  link=$(curl -s -X PUT -H "Authorization: Bearer $tok" -H 'Content-Type: application/json' --data-binary '{"room":"paired","protocol":"rtmp"}' "$API/apps/enc/devices/$dev/channels/cam1")
  echo "$link" >"$RES/pairing-link.json"
  for i in $(seq 1 30); do
    [[ $(enc_api GET /channels/cam1/status | jq -r '[.outputs[]|select(.id=="streamhub")][0].state') == running ]] && break
    sleep 1
  done
  sleep 10
  local ing
  ing=$(curl -s -H "Authorization: Bearer $tok" "$API/apps/enc/ingress" | jq -c '[.data[] | select((.room // .roomName // "") | test("paired"))][0] | {status, inputType}')
  [[ $(jq -r .status <<<"$ing") == publishing ]] && result pairing publish-without-typing-keys PASS "config frame → managed RTMP output → LiveKit ingress publishing; $(($(date +%s) - t0)) s from claim (no URL/key typed)" ||
    result pairing publish-without-typing-keys FAIL "ingress=$ing encoder=$(enc_api GET /channels/cam1/status | jq -c '.outputs')"
  # SRT + HEVC passthrough (E1/E2): link cam2 over SRT → MediaMTX :8890 with streamid key → fMP4 HLS
  local t1
  t1=$(date +%s)
  curl -s -X PUT -H "Authorization: Bearer $tok" -H 'Content-Type: application/json' --data-binary '{"room":"paired-hevc","protocol":"srt"}' "$API/apps/enc/devices/$dev/channels/cam2" >"$RES/pairing-link-srt.json"
  for i in $(seq 1 30); do
    [[ $(enc_api GET /channels/cam2/status | jq -r '[.outputs[]|select(.id=="streamhub")][0].state') == running ]] && break
    sleep 1
  done
  sleep 20
  local srow hls hp
  srow=$(curl -s -H "Authorization: Bearer $tok" "$API/apps/enc/ingress" | jq -c '[.data[] | select((.room // .roomName // "") | test("paired-hevc"))][0]')
  echo "$srow" >"$RES/pairing-srt-ingress.json"
  hls=$(jq -r '.hls_url // empty' <<<"$srow")
  hp=$(probe "http://127.0.0.1:3020/hls/$(sed -E 's#.*/hls/##' <<<"$hls")")
  [[ $(jq -r .v.codec_name <<<"$hp") == hevc ]] && result pairing srt-hevc-passthrough PASS "paired channel → SRT streamid publish:enc/ptk_… → MediaMTX → fMP4 HLS: $hp ($(($(date +%s) - t1)) s from link)" ||
    result pairing srt-hevc-passthrough FAIL "ingress=$srow hls=$hls probe=$hp encoder=$(enc_api GET /channels/cam2/status | jq -c '.outputs')"
  sleep 12
  local dv
  dv=$(curl -s -H "Authorization: Bearer $tok" "$API/apps/enc/devices/$dev")
  echo "$dv" | jq . >"$RES/pairing-device.json"
  [[ $(jq -r '.data.online // .online' <<<"$dv") == true && $(jq -r '(.data.status // .status).channels[0].state' <<<"$dv") == live ]] &&
    result pairing status-telemetry PASS "core sees online=true, channel cam1 live $(jq -c '(.data.status // .status) | {cpu, channels}' <<<"$dv" | cut -c1-160)" ||
    result pairing status-telemetry FAIL "$(jq -c '.data // .' <<<"$dv" | cut -c1-300)"
  # command round trip: stop/start from the core
  local cr
  cr=$(curl -s -X POST -H "Authorization: Bearer $tok" -H 'Content-Type: application/json' --data-binary '{"action":"restart","channel":"cam1"}' "$API/apps/enc/devices/$dev/commands")
  echo "$cr" >"$RES/pairing-command.json"
  [[ $(jq -r '.data.ok // .ok' <<<"$cr") == true ]] && result pairing command-restart PASS "$(jq -c '.data // .' <<<"$cr" | cut -c1-160)" || result pairing command-restart FAIL "$(cut -c1-300 <<<"$cr")"
  # revoke → 4401 → encoder back to unpaired, managed output gone
  curl -s -X DELETE -H "Authorization: Bearer $tok" "$API/apps/enc/devices/$dev" >/dev/null
  for i in $(seq 1 20); do
    ps=$(enc_api GET /streamhub | jq -r .state)
    [[ $ps == revoked ]] && break
    sleep 1
  done
  local mo
  mo=$(enc_api GET /channels/cam1 | jq '[.config.outputs[]|select(.managedBy=="streamhub")]|length')
  [[ $ps == revoked && $mo == 0 ]] && result pairing revoke PASS "4401 → encoder unpaired, managed output removed" || result pairing revoke FAIL "state=$ps managed=$mo"
}

case ${1:-} in
up) cmd_up ;;
down) cmd_down ;;
today) cmd_today ;;
pairing) cmd_pairing ;;
*) echo "usage: $0 up|today|pairing|down" >&2; exit 2 ;;
esac
