#!/usr/bin/env bash
# latency: the encoder burns an RTC timecode (capture time) into the picture;
# a receiver decodes the SRT/UDP output, burns ITS RTC timecode at presentation
# time below it, and tesseract reads both. Difference = capture→present
# latency (encode + mux + network + receiver jitter buffer/decoder), ±1 frame.
# Both containers share the host clock.

latency_case() { # name video_json output_proto srt_latency_ms
  local name=$1 v=$2 proto=$3 srtlat=${4:-120}
  selected "$name" || return 0
  local ch=lat-${name//[^a-z0-9]/-}
  ch=${ch:0:32}
  local out url
  case $proto in
  srt)
    out="[{\"id\":\"o\",\"type\":\"srt\",\"enabled\":true,\"url\":\"srt://:9200\",\"srt\":{\"mode\":\"listener\",\"latencyMs\":$srtlat}}]"
    url="srtsrc uri=srt://enc-e2e-enc:9200?mode=caller latency=$srtlat"
    ;;
  udp)
    out='[{"id":"o","type":"udp","enabled":true,"url":"udp://enc-e2e-rx:5200"}]'
    url='udpsrc port=5200 caps="video/mpegts,systemstream=(boolean)true,packetsize=(int)188"'
    ;;
  esac
  api POST /channels "$(channel_json "$ch" '{"type":"test","pattern":"black"}' "$v" "$out" '{"overlay":{"timecode":true},"audio":{"disabled":true}}')" >/dev/null
  wait_state "$ch" live 40 || { result latency "$name" FAIL "not live"; api DELETE "/channels/$ch" >/dev/null; return; }
  sleep 3
  local codec dec
  codec=$(jq -r .codec <<<"$v")
  dec="h264parse ! avdec_h264"
  [[ $codec == h265 ]] && dec="h265parse ! avdec_h265"
  local fps
  fps=$(jq -r .fps <<<"$v")
  local h w fs
  h=$(jq -r .height <<<"$v")
  w=$(jq -r .width <<<"$v")
  fs=$((h / 30))
  rx "rm -rf /tmp/lat && mkdir -p /tmp/lat"
  # receiver: decode → stamp receiver RTC timecode (bottom) → 2 frames/s to PNG
  rx "timeout 25 gst-launch-1.0 -q $url ! tsdemux latency=0 ! $dec ! videoconvert ! timecodestamper source=rtc set=always ! timeoverlay time-mode=time-code valignment=bottom halignment=left shaded-background=true font-desc='DejaVu Sans Mono Bold $fs' ! videorate drop-only=true ! video/x-raw,framerate=2/1 ! videoconvert ! pngenc ! multifilesink location=/tmp/lat/f%04d.png sync=true >/dev/null 2>&1 || true"
  api DELETE "/channels/$ch" >/dev/null
  # OCR: crop the source TC (top-left) and the receiver TC (bottom-left)
  local th=$((fs * 5)) tw=$((fs * 22))
  local lats
  lats=$(rx "cd /tmp/lat; for f in \$(ls f*.png | tail -n +6); do
      a=\$(ffmpeg -v error -i \$f -vf 'crop=$tw:$th:0:0,format=gray,lut=y=if(gt(val\,128)\,0\,255)' -f image2 -y /tmp/lat/a.png && tesseract /tmp/lat/a.png - --psm 7 -c tessedit_char_whitelist=0123456789: 2>/dev/null | tr -d ' \n');
      b=\$(ffmpeg -v error -i \$f -vf 'crop=$tw:$th:0:$((h - th)),format=gray,lut=y=if(gt(val\,128)\,0\,255)' -f image2 -y /tmp/lat/b.png && tesseract /tmp/lat/b.png - --psm 7 -c tessedit_char_whitelist=0123456789: 2>/dev/null | tr -d ' \n');
      echo \"\$a \$b\"; done" | awk -v fps="$(awk -v f="$fps" 'BEGIN{split(f,p,"/"); print (p[2]?p[1]/p[2]:f)}')" '
      function tc(s,  p){ if (split(s,p,":")!=4) return -1; return ((p[1]*60+p[2])*60+p[3])*int(fps+0.5)+p[4] }
      { a=tc($1); b=tc($2); if (a>=0 && b>=0 && b>=a && b-a < fps*10) printf "%.0f\n", (b-a)/fps*1000 }')
  local n med p95 min
  n=$(wc -l <<<"$lats" | tr -d ' ')
  [[ -z $lats ]] && n=0
  if ((n < 5)); then
    result latency "$name" FAIL "only $n OCR samples"
    rx "cp /tmp/lat/f0010.png /res/latency-$name-sample.png 2>/dev/null" || true
    return
  fi
  read -r min med p95 < <(sort -n <<<"$lats" | awk '{a[NR]=$1} END{print a[1], a[int((NR+1)/2)], a[int(NR*0.95+0.5)]}')
  echo "$lats" >"$RES/latency-$name.txt"
  rx "cp /tmp/lat/f0010.png /res/latency-$name-sample.png" 2>/dev/null || true
  result latency "$name" PASS "median ${med} ms, p95 ${p95} ms, min ${min} ms (n=$n, ±1 frame)"
}

suite_latency() {
  latency_case x264-lowlat-udp '{"codec":"h264","encoder":"x264","width":1280,"height":720,"fps":"30","bitrateKbps":3000,"lowLatency":true,"preset":"veryfast"}' udp
  latency_case x264-lowlat-srt120 '{"codec":"h264","encoder":"x264","width":1280,"height":720,"fps":"30","bitrateKbps":3000,"lowLatency":true,"preset":"veryfast"}' srt 120
  latency_case x264-quality-srt120 '{"codec":"h264","encoder":"x264","width":1280,"height":720,"fps":"30","bitrateKbps":3000,"bframes":3,"preset":"medium"}' srt 120
  latency_case x265-lowlat-srt120 '{"codec":"h265","encoder":"x265","width":1280,"height":720,"fps":"30","bitrateKbps":3000,"lowLatency":true,"preset":"veryfast"}' srt 120
  latency_case x265-quality-srt120 '{"codec":"h265","encoder":"x265","width":1280,"height":720,"fps":"30","bitrateKbps":3000,"bframes":3,"preset":"faster"}' srt 120
  if has_gpu; then
    latency_case nvenc-h264-lowlat-srt120 '{"codec":"h264","encoder":"nvenc","width":1280,"height":720,"fps":"30","bitrateKbps":3000,"lowLatency":true}' srt 120
    latency_case nvenc-h265-lowlat-srt120 '{"codec":"h265","encoder":"nvenc","width":1280,"height":720,"fps":"30","bitrateKbps":3000,"lowLatency":true}' srt 120
  fi
  latency_case x264-lowlat-srt500 '{"codec":"h264","encoder":"x264","width":1280,"height":720,"fps":"30","bitrateKbps":3000,"lowLatency":true,"preset":"veryfast"}' srt 500
}
