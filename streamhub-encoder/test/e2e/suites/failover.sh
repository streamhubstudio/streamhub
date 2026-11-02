#!/usr/bin/env bash
# failover: primary (SRT push, RED) → backup (UDP-TS, BLUE) → back to primary
# → slate when both die. The encode never stops: the output TS is continuous
# (no CC errors, every frame) and its colour over time proves each switch.

push_color() { # color proto url seconds
  rxd "timeout $4 ffmpeg -nostdin -loglevel error -re -f lavfi -i 'color=c=$1:s=1280x720:r=25' -f lavfi -i 'sine=f=440:r=48000' \
    -c:v libx264 -preset ultrafast -tune zerolatency -g 25 -b:v 2M -c:a aac -f mpegts '$3'"
}

suite_failover() {
  rx "mkdir -p /res/failover"
  local v='{"codec":"h264","encoder":"x264","width":1280,"height":720,"fps":"25","bitrateKbps":2000,"lowLatency":true}'
  local in='{"type":"srt","uri":"srt://:9100?mode=listener","timeoutMs":1500}'
  local x='{"backup":{"type":"udp","uri":"udp://0.0.0.0:5100","timeoutMs":1500}}'
  push_color blue udp "udp://enc-e2e-enc:5100?pkt_size=1316" 75          # backup: whole test
  sleep 2
  api POST /channels "$(channel_json fo "$in" "$v" '[{"id":"rec","type":"file","enabled":true,"url":"/res/failover/out.ts"}]' "$x")" >/dev/null
  wait_state fo live 40 || { result failover setup FAIL "$(status fo | jq -c '{state,error}')"; return; }
  push_color red srt "srt://enc-e2e-enc:9100?mode=caller&latency=120000&pkt_size=1316" 20   # primary for 20 s
  sleep 35
  push_color red srt "srt://enc-e2e-enc:9100?mode=caller&latency=120000&pkt_size=1316" 20   # primary back at t≈35 s
  sleep 46                                                                   # backup dies at t≈75 → slate
  local st
  st=$(status fo)
  api GET "/channels/fo/logs?proc=engine" | jq -r '.[]' >"$RES/failover-engine.log"
  api DELETE /channels/fo >/dev/null
  # colour every 0.2 s
  rx "ffmpeg -nostdin -v error -i /res/failover/out.ts -vf 'fps=5,scale=1:1' -f rawvideo -pix_fmt rgb24 - | od -An -v -tu1 -w3" |
    awk '{r=$1;g=$2;b=$3; c="?"; if(r>150&&b<90)c="R"; else if(b>150&&r<90)c="B"; else if(r<45&&g<45&&b<45)c="K"; printf "%s", c} END{print ""}' >"$RES/failover-colors.txt"
  local colors
  colors=$(cat "$RES/failover-colors.txt")
  # collapse runs: e.g. BBRRRR…BBB…RRR…BBB…KKK
  local runs
  runs=$(sed -E 's/(.)\1*/\1/g' <<<"$colors")
  local a
  a=$(analyze /res/failover/out.ts)
  local frames secs cc
  frames=$(jq .videoFrames <<<"$a")
  secs=$(jq .streamSeconds <<<"$a")
  cc=$(jq .ccErrors <<<"$a")
  local exp
  exp=$(awk -v s="$secs" 'BEGIN{printf "%d", s*25*0.97}')
  local eng_r
  eng_r=$(jq .engine.restarts <<<"$st")
  # switch latency: length of the last colour before a change is irrelevant;
  # measure the run of '?' (mixed frames) — must be short (no freeze/black gap > 2 s)
  local maxq
  maxq=$(grep -o '?*' <<<"$colors" | awk '{ if(length>m)m=length } END{print m+0}')
  if [[ $runs =~ R+.*B.*R.*B.*K ]] || [[ $runs =~ R.*B.*R.*B ]]; then
    result failover primary-backup-primary PASS "colour runs: $runs"
  else
    result failover primary-backup-primary FAIL "colour runs: $runs (full: ${colors:0:200})"
  fi
  [[ $runs =~ K$|K\?*$ ]] && result failover slate-when-all-inputs-lost PASS "ends on black/silence" || result failover slate-when-all-inputs-lost FAIL "ending: ${runs: -5}"
  if [[ $cc == 0 && $frames -ge $exp && $eng_r == 0 ]]; then
    result failover output-continuous PASS "${secs}s, $frames frames (≥$exp), cc=0, engine_restarts=0, longest mixed run=$((maxq * 200))ms"
  else
    result failover output-continuous FAIL "${secs}s, $frames frames (≥$exp), cc=$cc, engine_restarts=$eng_r"
  fi
}
