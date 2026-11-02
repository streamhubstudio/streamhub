#!/usr/bin/env bash
# formats: every codec/backend × raster/rate → TS on disk; ffprobe the result
# and check codec/profile/raster/fps/field order/audio, bitrate within ±15 %
# of the CBR target, real-time fps on the bus and zero CC errors.

format_case() { # name video_json input_json expect_field_order seconds fps_tol_pct extra_json
  local name=$1 v=$2 in=$3 fo=${4:-progressive} secs=${5:-20} ftol=${6:-2} extra=${7:-'{}'}
  selected "$name" || return 0
  local ch=f-${name//[^a-z0-9]/-}
  ch=${ch:0:32}
  api POST /channels "$(channel_json "$ch" "$in" "$v" "[{\"id\":\"rec\",\"type\":\"file\",\"enabled\":true,\"url\":\"/res/formats/$name.ts\"}]" "$(jq -c '. + {overlay:{timecode:true}}' <<<"$extra")")" >/dev/null
  if ! wait_state "$ch" live 40; then
    result formats "$name" FAIL "never live: $(status "$ch" | jq -c '{state,error}') $(api GET "/channels/$ch/logs?proc=engine" | jq -r '.[-5:][]' | tr '\n' ' ' | cut -c1-300)"
    api DELETE "/channels/$ch" >/dev/null
    return
  fi
  sleep "$secs"
  local st fps busfps cc kbps
  st=$(status "$ch")
  busfps=$(jq -r .stats.fps <<<"$st")
  cc=$(jq -r .stats.ccErrors <<<"$st")
  local cpu
  cpu=$(jq -r '.engineProc.cpuSeconds' <<<"$st")
  local up
  up=$(jq -r '.uptimeSeconds' <<<"$st")
  api DELETE "/channels/$ch" >/dev/null
  local f=/res/formats/$name.ts
  local p a
  p=$(probe "$f")
  a=$(analyze "$f")
  fps=$(jq -r .fps <<<"$a")
  kbps=$(jq -r .bitrateKbps <<<"$a")
  local want_codec want_w want_h want_fps target
  want_codec=$(jq -r '.codec | if .=="h265" then "hevc" else . end' <<<"$v")
  want_w=$(jq -r .width <<<"$v")
  want_h=$(jq -r .height <<<"$v")
  want_fps=$(jq -r '.fps' <<<"$v")
  target=$(jq -r '.bitrateKbps' <<<"$v")
  local got_codec got_w got_h got_fo got_ac got_prof
  got_codec=$(jq -r .v.codec_name <<<"$p")
  got_w=$(jq -r .v.width <<<"$p")
  got_h=$(jq -r .v.height <<<"$p")
  got_fo=$(jq -r '.v.field_order // "progressive"' <<<"$p")
  got_prof=$(jq -r '.v.profile' <<<"$p")
  got_ac=$(jq -r .a.channels <<<"$p")
  local fail=()
  [[ $got_codec == "$want_codec" ]] || fail+=("codec=$got_codec")
  [[ $got_w == "$want_w" && $got_h == "$want_h" ]] || fail+=("raster=${got_w}x$got_h")
  [[ $fo == any || $got_fo == "$fo" || ($fo == interlaced && $got_fo =~ ^(tt|bb|tb|bt)$) ]] || fail+=("field_order=$got_fo")
  [[ $got_ac == 2 ]] || fail+=("audio_ch=$got_ac")
  within "$fps" "$want_fps" "$ftol" || fail+=("file_fps=$fps")
  ge "$busfps" "$(awk -v f="$want_fps" 'BEGIN{print f*0.97}')" || fail+=("bus_fps=$busfps")
  # CBR: TS bitrate = video + audio + mux overhead; allow ±15 % around video+audio.
  # HW encoders (NVENC) do not stuff filler data: CBR there is a ceiling, so
  # easy content lands below target — only overshoot fails. A muxRateKbps
  # (null-packet padded TS) must be met within ±3 %.
  local mux
  mux=$(jq -r '.mux.muxRateKbps // 0' <<<"$extra")
  if [[ $mux != 0 ]]; then
    within "$kbps" "$mux" 3 || fail+=("kbps=$kbps(mux $mux)")
  elif [[ $(jq -r .encoder <<<"$v") == nvenc && $(jq -r '.pattern // ""' <<<"$in") != snow ]]; then
    awk -v k="$kbps" -v t="$((target + 128))" 'BEGIN{exit !(k<=t*1.15)}' || fail+=("kbps=$kbps overshoot")
  else
    within "$kbps" "$((target + 128))" 15 || fail+=("kbps=$kbps")
  fi
  [[ $cc == 0 ]] || fail+=("cc=$cc")
  local cpu_pct
  cpu_pct=$(awk -v c="$cpu" -v u="$up" 'BEGIN{printf "%.0f", (u>0)?c/u*100:0}')
  local details="${got_codec}/${got_prof} ${got_w}x${got_h} ${got_fo} fps=$fps (bus $busfps) ${kbps}kbps (target $target+128) cc=$cc engine_cpu=${cpu_pct}%"
  if ((${#fail[@]})); then
    result formats "$name" FAIL "$details :: ${fail[*]}"
  else
    result formats "$name" PASS "$details"
  fi
}

suite_formats() {
  rx "mkdir -p /res/formats"
  local test='{"type":"test","pattern":"ball"}'
  local testi='{"type":"test","pattern":"ball","interlaced":true}'
  format_case x264-1080p30 '{"codec":"h264","encoder":"x264","width":1920,"height":1080,"fps":"30","bitrateKbps":6000}' "$test"
  format_case x264-1080p60 '{"codec":"h264","encoder":"x264","width":1920,"height":1080,"fps":"60","bitrateKbps":9000}' "$test"
  format_case x264-720p50 '{"codec":"h264","encoder":"x264","width":1280,"height":720,"fps":"50","bitrateKbps":4000}' "$test"
  format_case x264-1080i50-paff '{"codec":"h264","encoder":"x264","width":1920,"height":1080,"fps":"25","interlaced":true,"bitrateKbps":8000}' "$testi" interlaced
  format_case x264-1080i50-deint '{"codec":"h264","encoder":"x264","width":1920,"height":1080,"fps":"25","bitrateKbps":6000}' "$testi"
  format_case x264-2997-vbr '{"codec":"h264","encoder":"x264","width":1280,"height":720,"fps":"29.97","bitrateKbps":3000,"rateControl":"cbr","bframes":2}' "$test"
  format_case x265-1080p25 '{"codec":"h265","encoder":"x265","width":1920,"height":1080,"fps":"25","bitrateKbps":4000,"bframes":3,"preset":"faster"}' "$test"
  format_case x265-720p50-lowlat '{"codec":"h265","encoder":"x265","width":1280,"height":720,"fps":"50","bitrateKbps":3000,"lowLatency":true,"preset":"veryfast"}' "$test"
  if has_gpu; then
    format_case nvenc-h264-1080p60 '{"codec":"h264","encoder":"nvenc","width":1920,"height":1080,"fps":"60","bitrateKbps":9000}' "$test"
    format_case nvenc-h265-1080p25 '{"codec":"h265","encoder":"nvenc","width":1920,"height":1080,"fps":"25","bitrateKbps":4000,"bframes":2}' "$test"
    format_case nvenc-h265-2160p30 '{"codec":"h265","encoder":"nvenc","width":3840,"height":2160,"fps":"30","bitrateKbps":15000}' "$test"
    format_case nvenc-h264-2160p30 '{"codec":"h264","encoder":"nvenc","width":3840,"height":2160,"fps":"30","bitrateKbps":20000}' "$test"
    format_case nvenc-h264-1080p30-snow '{"codec":"h264","encoder":"nvenc","width":1920,"height":1080,"fps":"30","bitrateKbps":6000}' '{"type":"test","pattern":"snow"}'
    format_case nvenc-h265-1080p25-muxcbr '{"codec":"h265","encoder":"nvenc","width":1920,"height":1080,"fps":"25","bitrateKbps":4000}' "$test" progressive 20 2 '{"mux":{"muxRateKbps":5000}}'
  else
    result formats nvenc SKIP "no NVIDIA runtime/GPU on this host"
  fi
  if [[ -n $REAL_MEDIA ]]; then
    format_case file-real-x264-1080p30 '{"codec":"h264","encoder":"x264","width":1920,"height":1080,"fps":"30","bitrateKbps":6000}' '{"type":"file","uri":"/media/real.mp4","loop":true}' progressive 25 3
    has_gpu && format_case file-real-nvenc-h265 '{"codec":"h265","encoder":"nvenc","width":1920,"height":1080,"fps":"25","bitrateKbps":4000}' '{"type":"file","uri":"/media/real.mp4","loop":true}' progressive 25 3
  fi
}
