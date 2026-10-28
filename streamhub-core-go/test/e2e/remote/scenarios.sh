#!/usr/bin/env bash
# Media e2e scenarios against the running Go core. Each scenario prints
# PASS / FAIL / SKIP with evidence; results.txt holds the summary.
# Scenarios whose routes the binary does not expose (modules still being
# ported) SKIP with the missing operationId.
set -uo pipefail
source "$(dirname "$0")/env.sh"
cd "$E2E_DIR"
TOKEN="$(cat .token)"
: > results.txt
log() { printf '    %s\n' "$*"; }
result() { printf '%-4s %-28s %s\n' "$2" "$1" "${3:-}" | tee -a results.txt; }

# api METHOD PATH [JSON] → $BODY, $CODE
api() {
  local out
  out="$(curl -s -m 30 -w '\n%{http_code}' -X "$1" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
    "$CORE/api/v1$2" ${3:+-d "$3"})"
  CODE="${out##*$'\n'}"; BODY="${out%$'\n'*}"
}
data() { jq -c '.data // .' <<<"$BODY"; }
OPENAPI="$(curl -s "$CORE/api/v1/openapi.json")"
has_op() { jq -e --arg id "$1" '[.paths[][] | objects | .operationId] | index($id)' <<<"$OPENAPI" >/dev/null; }
poll() { # tries cmd... → 0 when cmd succeeds
  local n="$1"; shift
  for _ in $(seq 1 "$n"); do "$@" && return 0; sleep 1; done; return 1
}
# object size straight from the SeaweedFS filer (independent of the core's S3 client)
s3_size() { curl -sf -H 'accept: application/json' "http://127.0.0.1:$P_S3_FILER/buckets/$BUCKET/$1?metadata=true" | jq -r '.FileSize // empty'; }
egress_skip() { [ "$E2E_EGRESS" = 1 ] || { result "$1" SKIP "E2E_EGRESS=0 (no egress container)"; return 0; }; return 1; }
core_errors() { grep -cE '"level":"(ERROR|error)"' logs/core.log || true; }

ROOM_REQ=e2e-cam
FFMPEG_PID=""
STREAM_ID=""; SID_ENC=""; ROOM=""
cleanup() { [ -n "$FFMPEG_PID" ] && kill "$FFMPEG_PID" 2>/dev/null; }
trap cleanup EXIT

# ---------------------------------------------------------------------------
echo "== (a) RTMP ingress → ffmpeg push → stream row + LiveKit participant"
api POST "/apps/$APP/ingress" "{\"inputType\":\"rtmp\",\"room\":\"$ROOM_REQ\",\"participantIdentity\":\"cam1\",\"participantName\":\"E2E cam\",\"enableTranscoding\":true}"
log "create ingress → $CODE $(data | jq -c '{ingressId,roomName,url,rtmp_url,streamKey,player_url}' 2>/dev/null)"
INGRESS_ID="$(data | jq -r '.ingressId // empty')"
ROOM="$(data | jq -r '.roomName // .room // empty')"
URL="$(data | jq -r '.url // .rtmp_url // empty')"
KEY="$(data | jq -r '.streamKey // .stream_key // empty')"
if [[ "$CODE" =~ ^20 && -n "$URL" && -n "$KEY" ]]; then
  PUSH="${URL%/}/$KEY"; [[ "$URL" == *"$KEY" ]] && PUSH="$URL"
  log "push → $PUSH"
  ffmpeg -nostdin -loglevel error -re -f lavfi -i testsrc=size=640x360:rate=15 -f lavfi -i sine=frequency=440 \
    -t 400 -c:v libx264 -preset veryfast -tune zerolatency -g 30 -b:v 700k -c:a aac -b:a 64k -f flv "$PUSH" \
    >logs/ffmpeg.log 2>&1 &
  FFMPEG_PID=$!
  active() {
    api GET "/apps/$APP/streams"
    STREAM_ID="$(data | jq -r --arg r "$ROOM" '[.[] | select(.status=="active" and .room==$r)][0] | (.streamId // .stream_id // .id // empty)')"
    SID_ENC="$(jq -rn --arg s "$STREAM_ID" '$s|@uri')"
    [ -n "$STREAM_ID" ]
  }
  if poll 45 active; then
    log "stream row: $(data | jq -c --arg r "$ROOM" '[.[]|select(.room==$r)][0]')"
    in_room() { api GET "/apps/$APP/rooms"; data | jq -e --arg r "$ROOM" '[.[] | select((.name // .room)==$r) | (.numParticipants // .num_participants // 0)] | .[0] >= 1' >/dev/null; }
    if poll 20 in_room; then
      log "room: $(data | jq -c --arg r "$ROOM" '[.[]|select((.name // .room)==$r)][0] | {name,numParticipants,numPublishers}')"
      result rtmp-ingress PASS "ingress=$INGRESS_ID room=$ROOM stream=$STREAM_ID"
    else result rtmp-ingress FAIL "stream active but LiveKit room shows no participant: $BODY"; fi
  else
    result rtmp-ingress FAIL "no active stream row for room $ROOM after 45s (streams: $(data | head -c 300)); ffmpeg: $(tail -3 logs/ffmpeg.log)"
  fi
else
  result rtmp-ingress FAIL "create ingress $CODE: $(head -c 300 <<<"$BODY")"
fi

# ---------------------------------------------------------------------------
echo "== (b) HLS start → playlist + segments via Go /hls → stop"
if egress_skip hls; then :
elif [ -z "$STREAM_ID" ]; then result hls SKIP "needs (a)"
elif ! has_op HlsController_start; then result hls SKIP "HlsController_start not in this binary"
else
  api POST "/apps/$APP/streams/$SID_ENC/hls/start" '{}'
  log "hls start → $CODE $(head -c 300 <<<"$BODY")"
  HLS_URL="$(data | jq -r '.url // .hlsUrl // .hls_url // .playlistUrl // empty')"
  [ -z "$HLS_URL" ] && HLS_URL="$CORE/hls/$APP/$ROOM/index.m3u8"
  [[ "$HLS_URL" == /* ]] && HLS_URL="$CORE$HLS_URL"
  playlist_ok() { curl -sf -D hls.h -o hls.m3u8 "$HLS_URL" && grep -q '#EXTINF' hls.m3u8; }
  if [[ "$CODE" =~ ^20 ]] && poll 60 playlist_ok; then
    PT="$(grep -i '^content-type' hls.h | tr -d '\r')"; PC="$(grep -i '^cache-control' hls.h | tr -d '\r')"
    SEG="$(grep -v '^#' hls.m3u8 | grep -v '^$' | head -1)"
    BASE="${HLS_URL%/*}"
    # a variant playlist may come first (master) — follow one level
    if [[ "$SEG" == *.m3u8 ]]; then curl -sf -o hls2.m3u8 "$BASE/$SEG"; BASE="$BASE/$(dirname "$SEG")"; SEG="$(grep -v '^#' hls2.m3u8 | grep -v '^$' | head -1)"; fi
    curl -sf -D seg.h -o seg.ts "$BASE/$SEG"
    ST="$(grep -i '^content-type' seg.h | tr -d '\r')"; SC="$(grep -i '^cache-control' seg.h | tr -d '\r')"
    SZ="$(stat -c %s seg.ts 2>/dev/null || echo 0)"
    log "playlist: $PT | $PC"; log "segment $SEG: $ST | $SC | ${SZ}B"
    api GET "/apps/$APP/streams/$SID_ENC/hls"; log "status → $CODE $(head -c 200 <<<"$BODY")"
    api POST "/apps/$APP/streams/$SID_ENC/hls/stop" '{}'; STOP="$CODE"
    if [[ "$PT" == *mpegurl* && "$ST" == *mp2t* && "$SC" == *immutable* && "$SZ" -gt 1000 && "$STOP" =~ ^20 ]]; then
      result hls PASS "$HLS_URL seg=${SZ}B stop=$STOP"
    else result hls FAIL "headers/size/stop mismatch (stop=$STOP)"; fi
  else
    result hls FAIL "start=$CODE, no playlist at $HLS_URL after 60s; ls: $(ls -R "$E2E_DATA/apps/$APP/hls" 2>&1 | head -5 | tr '\n' ' ')"
  fi
fi

# ---------------------------------------------------------------------------
echo "== (f) snapshot → S3 object"
if egress_skip snapshot; then :
elif [ -z "$ROOM" ]; then result snapshot SKIP "needs (a)"
else
  # source is the live HLS of the room (STREAMHUB_SNAPSHOT_SOURCE) → restart HLS for it
  has_op HlsController_start && { api POST "/apps/$APP/streams/$SID_ENC/hls/start" '{}'; sleep 12; }
  api POST "/apps/$APP/snapshots" "{\"room\":\"$ROOM\"}"
  log "snapshot → $CODE $(head -c 300 <<<"$BODY")"
  SKEY="$(data | jq -r '.key // empty')"; SURL="$(data | jq -r '.url // empty')"
  if [[ "$CODE" =~ ^20 && -n "$SKEY" ]]; then
    SSIZE="$(s3_size "$SKEY")"
    MAGIC="$(curl -sf "$SURL" | head -c 3 | od -An -tx1 | tr -d ' ')"
    if [ -n "$SSIZE" ] && [ "$MAGIC" = ffd8ff ]; then result snapshot PASS "key=$SKEY ${SSIZE}B (JPEG via presigned url)"
    else result snapshot FAIL "object size='$SSIZE' magic='$MAGIC' url=$SURL"; fi
  else result snapshot FAIL "$CODE $(head -c 200 <<<"$BODY")"; fi
  has_op HlsController_stop && api POST "/apps/$APP/streams/$SID_ENC/hls/stop" '{}'
fi

# ---------------------------------------------------------------------------
echo "== (c) recording start/stop → MP4 → MinIO → vod ready + presigned download"
if egress_skip recording; then :
elif [ -z "$STREAM_ID" ]; then result recording SKIP "needs (a)"
elif ! has_op RecordingController_recordStreamStart; then result recording SKIP "RecordingController_* not in this binary (recording module not ported yet)"
else
  api POST "/apps/$APP/streams/$SID_ENC/record/start" '{}'
  log "record start → $CODE $(head -c 300 <<<"$BODY")"
  if [[ "$CODE" =~ ^20 ]]; then
    sleep 15
    api POST "/apps/$APP/streams/$SID_ENC/record/stop" '{}'; log "record stop → $CODE $(head -c 200 <<<"$BODY")"
    vod_ready() { api GET "/apps/$APP/vods"; VOD="$(data | jq -c '[(if type=="array" then . else (.items // []) end)[] | select(.status=="ready")][0] // empty')"; [ -n "$VOD" ]; }
    if poll 120 vod_ready; then
      VID="$(jq -r '.id' <<<"$VOD")"; VKEY="$(jq -r '.file_key // .fileKey // .key // empty' <<<"$VOD")"
      log "vod: $(head -c 400 <<<"$VOD")"
      api GET "/apps/$APP/vods/$VID"; VURL="$(data | jq -r '.url // .presignedUrl // .s3_url // empty')"
      curl -sfL -o vod.mp4 "$VURL"
      DUR="$(ffprobe -v error -show_entries format=duration -of csv=p=0 vod.mp4 2>/dev/null)"
      OSIZE="$( [ -n "$VKEY" ] && s3_size "$VKEY")"
      if awk "BEGIN{exit !(${DUR:-0} > 5)}"; then result recording PASS "vod=$VID key=$VKEY s3=${OSIZE:-?}B duration=${DUR}s"
      else result recording FAIL "downloaded vod not a valid MP4 (duration='$DUR', url=$VURL)"; fi
    else result recording FAIL "no ready vod after 120s: $(head -c 300 <<<"$BODY")"; fi
  else result recording FAIL "start $CODE"; fi
fi

# ---------------------------------------------------------------------------
echo "== (g) restream → second RTMP sink (MediaMTX)"
if egress_skip restream; then :
elif [ -z "$STREAM_ID" ]; then result restream SKIP "needs (a)"
elif ! has_op RestreamController_add; then result restream SKIP "RestreamController_* not in this binary (restream module not ported yet)"
else
  api POST "/apps/$APP/streams/$SID_ENC/restream" "{\"platform\":\"custom\",\"url\":\"rtmp://127.0.0.1:$P_SINK_RTMP/sink/e2e\",\"name\":\"e2e sink\"}"
  log "restream add → $CODE $(head -c 300 <<<"$BODY")"
  EGID="$(data | jq -r '.egressId // .id // empty')"
  sink_live() { curl -sf "http://127.0.0.1:$P_SINK_API/v3/paths/list" | jq -e '.items[] | select(.name=="sink/e2e" and .ready==true)' >/dev/null; }
  if [[ "$CODE" =~ ^20 ]] && poll 60 sink_live; then
    log "sink: $(curl -s "http://127.0.0.1:$P_SINK_API/v3/paths/list" | jq -c '.items[] | {name,ready,bytesReceived}')"
    api DELETE "/apps/$APP/streams/$SID_ENC/restream/$EGID"; log "remove → $CODE"
    result restream PASS "egress=$EGID reached sink/e2e"
  else result restream FAIL "add=$CODE sink never ready"; fi
fi

# ---------------------------------------------------------------------------
echo "== (e) WHIP ingress (API + LiveKit side)"
api POST "/apps/$APP/ingress" '{"inputType":"whip","room":"e2e-whip","participantIdentity":"whip1"}'
log "create → $CODE $(data | jq -c '{ingressId,roomName,url,inputType}' 2>/dev/null)"
WID="$(data | jq -r '.ingressId // empty')"; WURL="$(data | jq -r '.url // empty')"
if [[ "$CODE" =~ ^20 && -n "$WID" && "$WURL" == *":$P_ING_WHIP/w"* ]]; then
  api GET "/apps/$APP/ingress/$WID"; G="$CODE"; log "get → $CODE $(data | jq -c '{ingressId,inputType,state}' 2>/dev/null)"
  api GET "/apps/$APP/ingress"; L="$(data | jq --arg id "$WID" '[.[] | select(.ingressId==$id)] | length' 2>/dev/null)"
  api DELETE "/apps/$APP/ingress/$WID"; D="$CODE"
  if [ "$G" = 200 ] && [ "${L:-0}" -ge 1 ] && [[ "$D" =~ ^20 ]]; then result whip-ingress PASS "id=$WID url=$WURL get=$G listed=$L delete=$D"
  else result whip-ingress FAIL "get=$G listed=$L delete=$D"; fi
else result whip-ingress FAIL "$CODE url=$WURL $(head -c 200 <<<"$BODY")"; fi

# ---------------------------------------------------------------------------
echo "== stop the push → stream ends"
if [ -n "$FFMPEG_PID" ] && [ -n "$STREAM_ID" ]; then
  kill "$FFMPEG_PID" 2>/dev/null; FFMPEG_PID=""
  ended() { api GET "/apps/$APP/streams/$SID_ENC"; [ "$(data | jq -r '.status // empty')" = ended ]; }
  if poll 60 ended; then log "stream $STREAM_ID → $(data | jq -c '{status,ended_at,endedAt}' 2>/dev/null)"; result stream-end PASS "row ended after unpublish"
  else result stream-end FAIL "still $(data | jq -r '.status' 2>/dev/null)"; fi
fi
sleep 3

# ---------------------------------------------------------------------------
echo "== (d) LiveKit webhooks → Go; signed app callbacks → receiver"
WH="$(grep -c 'webhooks/livekit' logs/core.log || true)"
if [ -s receiver.jsonl ]; then
  N="$(wc -l < receiver.jsonl)"; BAD="$(jq -s '[.[] | select(.sigValid|not)] | length' receiver.jsonl)"
  EVENTS="$(jq -rs '[.[].event] | unique | join(",")' receiver.jsonl)"
  ENVOK="$(jq -s '[.[] | select(.body.event == .event and .body.app == "'"$APP"'" and (.body.id|type=="string"))] | length' receiver.jsonl)"
  log "webhook requests in core log: $WH; callbacks received: $N; events: $EVENTS"
  log "sample: $(head -1 receiver.jsonl | head -c 400)"
  if [ "$BAD" = 0 ] && [ "$ENVOK" = "$N" ] && grep -qE 'stream_started|participant_joined|ingress_started|room_started' <<<"$EVENTS"; then
    result webhooks-callbacks PASS "$N signed callbacks, all signatures valid; events=$EVENTS"
  else result webhooks-callbacks FAIL "bad signatures=$BAD envelopes ok=$ENVOK/$N events=$EVENTS"; fi
else result webhooks-callbacks FAIL "receiver got nothing (core webhook lines: $WH)"; fi

echo "== core log: $(core_errors) error lines"
grep -E '"level":"(ERROR|error)"' logs/core.log | tail -n 10 | cut -c1-300
echo; echo "== SUMMARY"; cat results.txt
! grep -q '^FAIL' results.txt
