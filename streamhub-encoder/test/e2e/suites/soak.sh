#!/usr/bin/env bash
# soak: SOAK_MIN minutes (default 60) of 4 mixed channels and 8 outputs with
# live readers. SOAK_PROD_RTMP=rtmp://host/live/<key> adds a 5th channel (s5,
# x264 720p30 2 Mbps from the same input as s1) pushing to a real server.
# Every 30 s it samples per channel fps/bitrate/CC/PCR drift/restarts/stalls
# and per process RSS/CPU/fds into soak.csv; at the end it checks for
# restarts, CC errors, fps loss, memory growth and fd leaks.

suite_soak() {
  local mins=${SOAK_MIN:-60}
  rx "mkdir -p /res/soak /tmp/hls; (pgrep hlsrecv || (nohup hlsrecv -listen :8088 -dir /tmp/hls >/res/soak/hlsrecv.log 2>&1 &))" >/dev/null
  local in1='{"type":"test","pattern":"ball"}'
  [[ -n $REAL_MEDIA ]] && in1='{"type":"file","uri":"/media/real.mp4","loop":true}'
  api POST /channels "$(channel_json s1 "$in1" '{"codec":"h264","encoder":"x264","width":1920,"height":1080,"fps":"30","bitrateKbps":6000}' \
    '[{"id":"srt","type":"srt","enabled":true,"url":"srt://enc-e2e-mediamtx:8890","srt":{"streamId":"publish:soak1"}},{"id":"rtmp","type":"rtmp","enabled":true,"url":"rtmp://enc-e2e-nginx:1935/live/soak1"}]')" >/dev/null
  local v2='{"codec":"h265","encoder":"x265","width":1280,"height":720,"fps":"25","bitrateKbps":2500,"preset":"veryfast"}'
  has_gpu && v2='{"codec":"h265","encoder":"nvenc","width":1920,"height":1080,"fps":"25","bitrateKbps":4000}'
  api POST /channels "$(channel_json s2 '{"type":"test","pattern":"ball"}' "$v2" \
    '[{"id":"srt","type":"srt","enabled":true,"url":"srt://:9400","srt":{"mode":"listener"}},{"id":"mc","type":"udp","enabled":true,"url":"udp://239.20.0.1:5000"}]' '{"overlay":{"timecode":true,"clock":true}}')" >/dev/null
  api POST /channels "$(channel_json s3 '{"type":"test","pattern":"smpte"}' '{"codec":"h264","encoder":"x264","width":1280,"height":720,"fps":"30","bitrateKbps":3000,"lowLatency":true}' \
    '[{"id":"whip","type":"whip","enabled":true,"url":"http://enc-e2e-mediamtx:8889/soak3/whip"},{"id":"hls","type":"hls","enabled":true,"url":"http://enc-e2e-rx:8088/soak3/index.m3u8"}]' '{"overlay":{"timecode":true}}')" >/dev/null
  api POST /channels "$(channel_json s4 '{"type":"test","pattern":"ball"}' '{"codec":"h265","encoder":"x265","width":1280,"height":720,"fps":"25","bitrateKbps":2500,"preset":"veryfast"}' \
    '[{"id":"ertmp","type":"rtmp","enabled":true,"url":"rtmp://enc-e2e-mediamtx:1935/soak4"},{"id":"rec","type":"file","enabled":true,"url":"/res/soak/s4-{ts}.ts"}]')" >/dev/null
  local chs="s1 s2 s3 s4"
  if [[ -n ${SOAK_PROD_RTMP:-} ]]; then
    api POST /channels "$(channel_json s5 "$in1" '{"codec":"h264","encoder":"x264","width":1280,"height":720,"fps":"30","bitrateKbps":2000}' \
      "[{\"id\":\"prod\",\"type\":\"rtmp\",\"enabled\":true,\"url\":\"$SOAK_PROD_RTMP\"}]")" >/dev/null
    chs+=" s5"
  fi
  for c in $chs; do wait_state "$c" live 60 || log "soak: $c not live"; done
  sleep 10
  # live readers for the whole soak (they also reconnect if the source drops)
  rxd "while true; do ffmpeg -nostdin -loglevel error -i 'srt://enc-e2e-enc:9400?mode=caller' -c copy -f null - ; sleep 1; done"
  rxd "while true; do ffmpeg -nostdin -loglevel error -i 'srt://enc-e2e-mediamtx:8890?streamid=read:soak1' -c copy -f null - ; sleep 1; done"
  rxd "while true; do ffmpeg -nostdin -loglevel error -i 'rtsp://enc-e2e-mediamtx:8554/soak3' -c copy -f null - ; sleep 1; done"
  local csv=$RES/soak.csv
  echo "t_s,channel,state,fps,kbps,cc,drift_ms,engine_restarts,stalls,engine_rss_mb,engine_cpu_s,engine_fds,out_restarts,out_rss_mb,encoderd_rss_mb,encoderd_fds" >"$csv"
  local t0
  t0=$(date +%s)
  local end=$((t0 + mins * 60))
  while (($(date +%s) < end)); do
    local t=$(($(date +%s) - t0))
    local m self_rss self_fds
    m=$(docker exec "$ENC" curl -s localhost:8090/metrics)
    self_rss=$(awk '/^encoderd_process_resident_memory_bytes/{printf "%.1f", $2/1048576}' <<<"$m")
    self_fds=$(awk '/^encoderd_process_open_fds/{print $2}' <<<"$m")
    for c in $chs; do
      status "$c" | jq -r --arg t "$t" --arg r "$self_rss" --arg f "$self_fds" \
        '[$t, .id, .state, .stats.fps, .stats.bitrateKbps, .stats.ccErrors, .stats.pcrDriftMs, .engine.restarts, .stalls,
          ((.engineProc.rssBytes // 0)/1048576|.*10|round/10), .engineProc.cpuSeconds, .engineProc.fds,
          ([.outputs[].process.restarts // 0]|add), ([.outputs[].proc.rssBytes // 0]|add/1048576|.*10|round/10), $r, $f] | @csv' >>"$csv"
    done
    sleep 30
  done
  # final checks
  local final
  final=$(for c in $chs; do status "$c"; done | jq -s '.')
  echo "$final" >"$RES/soak-final.json"
  for c in $chs; do api DELETE "/channels/$c" >/dev/null; done
  rx "pkill -f 'while true' ; pkill ffmpeg" || true
  soak_evaluate "$csv" "$mins"
}

# soak_evaluate CSV MINUTES — also usable on a finished run's soak.csv.
# The CSV fields are quoted by jq @csv: strip the quotes once, then compare
# numerically. Per channel: when it went live, a base window right after a
# 5-minute warm-up vs the last 10 minutes (means, not single samples: the RSS of
# a GStreamer engine moves ±100 MB with queue fill), plus the RSS slope.
soak_evaluate() {
  local csv=$1 mins=$2
  local plain=${csv%.csv}.plain.csv
  tr -d '"' <"$csv" >"$plain"
  local c
  for c in $(awk -F, 'NR>1{print $2}' "$plain" | sort -u); do
    local ev
    ev=$(awk -F, -v c="$c" -f "${E2E_DIR:-test/e2e}/suites/soak_eval.awk" "$plain")
    local det="${mins}min: $ev"
    local ok=1
    [[ $ev == live=never* ]] && ok=0
    if ((ok)); then
      local -A kv=()
      local tok
      for tok in $ev; do kv[${tok%%=*}]=${tok#*=}; done
      ((kv[live] <= 120)) || ok=0 # a channel waiting on HW must come up by itself (caps re-probe)
      [[ ${kv[state]} == live && ${kv[cc]} == 0 && ${kv[engine_restarts]} == 0 && ${kv[stalls]} == 0 && ${kv[out_restarts]} == 0 ]] || ok=0
      awk -v a="${kv[fps_avg]}" -v m="${kv[fps_med]}" 'BEGIN{exit !(a>=0.95*m)}' || ok=0
      awk -v a="${kv[rss_base]}" -v b="${kv[rss_end]}" 'BEGIN{exit !(b<=a*1.15+5)}' || ok=0
      ((kv[fds_end] <= kv[fds_base] + 2)) || ok=0
    fi
    ((ok)) && result soak "$c" PASS "$det" || result soak "$c" FAIL "$det"
  done

  # A/V drift on the s4 recording. Both streams are stamped from one pipeline
  # clock and mpegtsmux interleaves by running time, so the audio−video PTS
  # offset at a given mux position is constant up to one audio frame unless one
  # of them drifts. Sample it at 24 points along the file; drift = max − min,
  # in video frames (25 fps). The end-of-file span difference is NOT used: the
  # recorder stops mid-interleave, which reads as ~100 ms of fake "drift".
  local recf
  recf=$(rx "ls -t /res/soak/s4-*.ts 2>/dev/null | head -1")
  if [[ -n $recf ]]; then
    local vidx av
    vidx=$(rx "ffprobe -v error -select_streams v:0 -show_entries stream=index -of csv=p=0 $recf 2>/dev/null | grep -m1 .")
    rx "ffprobe -v error -show_entries packet=stream_index,pts_time -of csv=p=0 $recf 2>/dev/null > /res/soak/pkts.csv"
    av=$(awk -F, -v vi="$vidx" -f "${E2E_DIR:-test/e2e}/suites/soak_avdrift.awk" "$RES/soak/pkts.csv")
    rx "rm -f /res/soak/pkts.csv"
    local drift=${av%% *}
    if awk -v d="$drift" 'BEGIN{exit !(d<=1)}'; then
      result soak av-drift PASS "A/V offset varies $drift frames over the recording (${av#* })"
    else
      result soak av-drift FAIL "A/V offset varies $drift frames over the recording (${av#* })"
    fi
  fi

  local r0 r1 f0 f1
  read -r r0 r1 f0 f1 < <(awk -F, 'NR>1 && $2=="s1" { n++; t[n]=$1+0; r[n]=$15+0; f[n]=$16+0 }
    END { tl=t[n]; for (i=1;i<=n;i++) { if (t[i]>=300 && t[i]<900) { b+=r[i]; nb++; if (f0=="") f0=f[i] } if (t[i]>=tl-600) { e+=r[i]; ne++ } }
          printf "%.1f %.1f %s %s\n", b/nb, e/ne, f0, f[n] }' "$plain")
  if awk -v a="$r0" -v b="$r1" 'BEGIN{exit !(b<=a*1.2+5)}' && ((f1 <= f0 + 4)); then
    result soak encoderd PASS "encoderd RSS ${r0}→${r1} MB (mean 5–15 min vs last 10 min), fds ${f0}→${f1}"
  else
    result soak encoderd FAIL "encoderd RSS ${r0}→${r1} MB (mean 5–15 min vs last 10 min), fds ${f0}→${f1}"
  fi
}
