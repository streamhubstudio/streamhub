#!/usr/bin/env bash
# outputs: ONE encode → every output protocol at once, each verified at a real
# receiver with ffprobe (codec/raster/audio) — SRT caller → MediaMTX (streamid),
# SRT listener ← receiver, RTMP → MediaMTX, RTMP → nginx-rtmp, WHIP → MediaMTX
# (read back over RTSP), UDP multicast + unicast, RTP, HLS push (HTTP PUT),
# TS file; then the same with HEVC (SRT, Enhanced RTMP, HLS fMP4).

check_probe() { # suite test probe_json want_codec [want_audio_codec]
  local p=$3 vc ac w h
  vc=$(jq -r .v.codec_name <<<"$p")
  ac=$(jq -r '.a.codec_name // "none"' <<<"$p")
  w=$(jq -r .v.width <<<"$p")
  h=$(jq -r .v.height <<<"$p")
  if [[ $vc == "$4" && $w == 1280 && $h == 720 && $ac == "${5:-aac}" ]]; then
    result "$1" "$2" PASS "$vc ${w}x$h audio=$ac fps=$(jq -r .v.avg_frame_rate <<<"$p")"
  else
    result "$1" "$2" FAIL "got: $p"
  fi
}

suite_outputs() {
  rx "mkdir -p /res/outputs /tmp/hls && (pgrep hlsrecv || (nohup hlsrecv -listen :8088 -dir /tmp/hls >/res/outputs/hlsrecv.log 2>&1 &))" >/dev/null
  local v='{"codec":"h264","encoder":"x264","width":1280,"height":720,"fps":"30","bitrateKbps":3000,"lowLatency":true}'
  local outs='[
    {"id":"srt-mtx","type":"srt","enabled":true,"url":"srt://enc-e2e-mediamtx:8890","srt":{"streamId":"publish:srtcam","latencyMs":200}},
    {"id":"srt-lst","type":"srt","enabled":true,"url":"srt://:9001","srt":{"mode":"listener","latencyMs":200,"passphrase":"e2e-passphrase-123"}},
    {"id":"rtmp-mtx","type":"rtmp","enabled":true,"url":"rtmp://enc-e2e-mediamtx:1935/rtmpcam"},
    {"id":"rtmp-ngx","type":"rtmp","enabled":true,"url":"rtmp://enc-e2e-nginx:1935/live/cam"},
    {"id":"whip-mtx","type":"whip","enabled":true,"url":"http://enc-e2e-mediamtx:8889/whipcam/whip"},
    {"id":"udp-mc","type":"udp","enabled":true,"url":"udp://239.10.10.10:5000","udp":{"ttl":4}},
    {"id":"udp-uc","type":"udp","enabled":true,"url":"udp://enc-e2e-rx:5002"},
    {"id":"rtp-mc","type":"rtp","enabled":true,"url":"rtp://239.10.10.11:5004"},
    {"id":"hls","type":"hls","enabled":true,"url":"http://enc-e2e-rx:8088/live/ch/index.m3u8","hls":{"segmentSeconds":2,"listSize":5}},
    {"id":"rec","type":"file","enabled":true,"url":"/res/outputs/rec-{ts}.ts"}]'
  api POST /channels "$(channel_json out264 '{"type":"test","pattern":"ball"}' "$v" "$outs" '{"overlay":{"timecode":true}}')" >/dev/null
  if ! wait_state out264 live 40; then
    result outputs h264-channel FAIL "$(status out264 | jq -c '{state,error,outputs:[.outputs[]|{id,state,error}]}')"
    return
  fi
  sleep 12
  local st
  st=$(status out264)
  jq . <<<"$st" >"$RES/outputs-status-h264.json"
  local o
  for o in $(jq -r '.outputs[].id' <<<"$st"); do
    local s
    s=$(jq -r --arg o "$o" '.outputs[]|select(.id==$o)|"\(.state) restarts=\(.process.restarts // 0) \(.error // "")"' <<<"$st")
    [[ $s == running* ]] || log "output $o: $s"
  done
  check_probe outputs srt-caller-mediamtx "$(probe_rec 'srt://enc-e2e-mediamtx:8890?streamid=read:srtcam')" h264
  check_probe outputs srt-listener-passphrase "$(probe 'srt://enc-e2e-enc:9001?mode=caller&passphrase=e2e-passphrase-123')" h264
  # wrong passphrase must be refused
  if rx "timeout 15 ffprobe -v error -rw_timeout 8000000 'srt://enc-e2e-enc:9001?mode=caller&passphrase=wrong-passphrase-9' >/dev/null 2>&1"; then
    result outputs srt-listener-wrong-passphrase FAIL "stream readable with a wrong passphrase"
  else
    result outputs srt-listener-wrong-passphrase PASS "refused"
  fi
  check_probe outputs rtmp-mediamtx "$(probe 'rtmp://enc-e2e-mediamtx:1935/rtmpcam')" h264
  check_probe outputs rtmp-nginx-rtmp "$(probe_rec 'rtmp://enc-e2e-nginx:1935/live/cam')" h264
  check_probe outputs whip-mediamtx-read-rtsp "$(probe 'rtsp://enc-e2e-mediamtx:8554/whipcam')" h264 opus
  check_probe outputs udp-multicast "$(probe 'udp://239.10.10.10:5000?timeout=10000000')" h264
  check_probe outputs udp-unicast "$(probe 'udp://0.0.0.0:5002?timeout=10000000')" h264
  check_probe outputs rtp-multicast "$(probe 'rtp://239.10.10.11:5004?timeout=10000000')" h264
  check_probe outputs hls-push "$(probe 'http://localhost:8088/live/ch/index.m3u8')" h264
  local segs
  segs=$(rx "ls /tmp/hls/live/ch/ | grep -c '\.ts$'")
  [[ $segs -ge 3 ]] && result outputs hls-push-segments PASS "$segs segments pushed" || result outputs hls-push-segments FAIL "$segs segments"
  local all_running
  all_running=$(status out264 | jq '[.outputs[]|select(.state!="running")]|length')
  [[ $all_running == 0 ]] && result outputs all-10-outputs-running PASS "10 outputs, 1 encode, engine restarts=$(status out264 | jq .engine.restarts)" ||
    result outputs all-10-outputs-running FAIL "$(status out264 | jq -c '[.outputs[]|select(.state!="running")|{id,state,error}]')"
  api DELETE /channels/out264 >/dev/null
  local recf
  recf=$(rx "ls /res/outputs/rec-*.ts | head -1")
  local a
  a=$(analyze "$recf")
  [[ $(jq .ccErrors <<<"$a") == 0 && $(jq '.videoFrames>300' <<<"$a") == true ]] && result outputs file-ts PASS "$(jq -c '{fps,bitrateKbps,ccErrors,streamSeconds}' <<<"$a")" ||
    result outputs file-ts FAIL "$a"

  # HEVC to the protocols that carry it
  local v5='{"codec":"h265","encoder":"x265","width":1280,"height":720,"fps":"25","bitrateKbps":2500,"preset":"veryfast"}'
  local outs5='[
    {"id":"srt-mtx","type":"srt","enabled":true,"url":"srt://enc-e2e-mediamtx:8890","srt":{"streamId":"publish:hevc"}},
    {"id":"ertmp-mtx","type":"rtmp","enabled":true,"url":"rtmp://enc-e2e-mediamtx:1935/hevcrtmp"},
    {"id":"hls","type":"hls","enabled":true,"url":"http://enc-e2e-rx:8088/live/hevc/index.m3u8"}]'
  api POST /channels "$(channel_json out265 '{"type":"test","pattern":"ball"}' "$v5" "$outs5")" >/dev/null
  wait_state out265 live 40
  sleep 12
  check_probe outputs hevc-srt-mediamtx "$(probe_rec 'srt://enc-e2e-mediamtx:8890?streamid=read:hevc')" hevc
  check_probe outputs hevc-enhanced-rtmp-mediamtx "$(probe 'rtsp://enc-e2e-mediamtx:8554/hevcrtmp')" hevc
  check_probe outputs hevc-hls-fmp4 "$(probe 'http://localhost:8088/live/hevc/index.m3u8')" hevc
  api DELETE /channels/out265 >/dev/null
}
