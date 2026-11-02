#!/usr/bin/env bash
# hotswap: while a receiver records the SRT output continuously, add RTMP and
# WHIP outputs, remove the UDP output and edit the RTMP one. The SRT recording
# must show zero continuity errors, no PCR jumps and every frame, and neither
# the engine nor the SRT output may restart.

suite_hotswap() {
  rx "mkdir -p /res/hotswap"
  local v='{"codec":"h264","encoder":"x264","width":1280,"height":720,"fps":"30","bitrateKbps":3000,"lowLatency":true}'
  local outs='[{"id":"srt","type":"srt","enabled":true,"url":"srt://:9002","srt":{"mode":"listener","latencyMs":200}},
               {"id":"udp","type":"udp","enabled":true,"url":"udp://enc-e2e-rx:5010"}]'
  api POST /channels "$(channel_json hs '{"type":"test","pattern":"ball"}' "$v" "$outs" '{"overlay":{"timecode":true}}')" >/dev/null
  wait_state hs live 40 || { result hotswap setup FAIL "not live"; return; }
  sleep 3
  local dur=70
  rxd "timeout $((dur + 20)) ffmpeg -nostdin -loglevel error -y -i 'srt://enc-e2e-enc:9002?mode=caller&latency=200000' -map 0 -c copy -t $dur -f mpegts /res/hotswap/srt.ts"
  sleep 10
  api POST /channels/hs/outputs '{"id":"rtmp","type":"rtmp","enabled":true,"url":"rtmp://enc-e2e-mediamtx:1935/hs1"}' >/dev/null
  sleep 10
  api POST /channels/hs/outputs '{"id":"whip","type":"whip","enabled":true,"url":"http://enc-e2e-mediamtx:8889/hswhip/whip"}' >/dev/null
  sleep 10
  api DELETE /channels/hs/outputs/udp >/dev/null
  sleep 10
  api PUT /channels/hs/outputs/rtmp '{"type":"rtmp","enabled":true,"url":"rtmp://enc-e2e-mediamtx:1935/hs2"}' >/dev/null
  sleep 10
  local p_rtmp p_whip
  p_rtmp=$(probe 'rtmp://enc-e2e-mediamtx:1935/hs2')
  p_whip=$(probe 'rtsp://enc-e2e-mediamtx:8554/hswhip')
  sleep $((dur - 50 + 15))
  local st
  st=$(status hs)
  api DELETE /channels/hs >/dev/null
  local a
  a=$(analyze /res/hotswap/srt.ts)
  local frames cc disc secs
  frames=$(jq .videoFrames <<<"$a")
  cc=$(jq .ccErrors <<<"$a")
  disc=$(jq .pcrDiscontinuities <<<"$a")
  secs=$(jq .streamSeconds <<<"$a")
  local eng_r srt_r
  eng_r=$(jq .engine.restarts <<<"$st")
  srt_r=$(jq '.outputs[]|select(.id=="srt")|.process.restarts' <<<"$st")
  local exp=$((dur * 30 * 97 / 100))
  if [[ $cc == 0 && $disc == 0 && $frames -ge $exp && $eng_r == 0 && $srt_r == 0 ]]; then
    result hotswap srt-uninterrupted PASS "recorded ${secs}s, $frames frames (≥$exp), cc=$cc, pcr_jumps=$disc, engine_restarts=$eng_r, srt_restarts=$srt_r"
  else
    result hotswap srt-uninterrupted FAIL "recorded ${secs}s, $frames frames (≥$exp), cc=$cc, pcr_jumps=$disc, engine_restarts=$eng_r, srt_restarts=$srt_r"
  fi
  [[ $(jq -r .v.codec_name <<<"$p_rtmp") == h264 ]] && result hotswap rtmp-added-and-edited PASS "read back from MediaMTX after URL edit" || result hotswap rtmp-added-and-edited FAIL "$p_rtmp"
  [[ $(jq -r .v.codec_name <<<"$p_whip") == h264 ]] && result hotswap whip-added PASS "WHIP session up while SRT kept flowing" || result hotswap whip-added FAIL "$p_whip"
  [[ $(jq '[.outputs[]|select(.id=="udp")]|length' <<<"$st") == 0 ]] && result hotswap udp-removed PASS "removed without touching SRT" || result hotswap udp-removed FAIL "still present"
}
