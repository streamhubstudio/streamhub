#!/usr/bin/env bash
# density: how many 1080p channels one box sustains in real time, per backend.
# Each channel transcodes a REAL clip (REAL_MEDIA, looped; else a moving test
# pattern) → encode → internal bus (outputs are cheap TS relays and are left
# out). A step passes when EVERY channel holds ≥ 96 % of its frame rate over a
# 40 s window after a 45 s warm-up, with no engine restart/stall (an idle
# single channel measures 24.4–24.8 fps for 25: the clip is 24 fps and is
# rate-converted). Decoding is forced to CPU (E2E_DECODER_RANK) so a busy GPU
# shared with other jobs does not skew software-encoder numbers. Records host
# CPU % and GPU %.

host_cpu_sample() { docker exec "$ENC" head -1 /proc/stat | awk '{t=0; for(i=2;i<=NF;i++)t+=$i; print t, $5+$6}'; }

density_step() { # backend codec n video_json
  local be=$1 codec=$2 n=$3 v=$4
  # Real content from the looped clip. A file input is paced in real time by
  # the engine but catches up after a slow start (lookahead), so the window is
  # measured only after a 60 s warm-up, in steady state (a live UDP feed was
  # tried: its own loop gaps dominated the measurement).
  local in='{"type":"test","pattern":"ball"}'
  [[ -n $REAL_MEDIA ]] && in='{"type":"file","uri":"/res/density-long.mp4","loop":true}'
  local i
  for ((i = 1; i <= n; i++)); do
    api POST /channels "$(channel_json "d$i" "$in" "$v" '[]' '{"audio":{"bitrateKbps":128}}')" >/dev/null
  done
  sleep 45 # warm-up: lookahead, catch-up, NVENC init
  local c0 c1 fail=0 minfps=999 i_fps restarts=0 gpu=""
  c0=$(host_cpu_sample)
  local want
  want=$(jq -r .fps <<<"$v")
  local -A low=() f0=() t0=()
  # fps = encoded frames over the whole 40 s window (robust to 5 s dips such as a file-loop restart)
  for ((i = 1; i <= n; i++)); do
    f0[$i]=$(status "d$i" | jq -r '.stats.videoFrames // 0')
    t0[$i]=$(date +%s.%N)
  done
  for s in 1 2 3 4 5 6 7 8; do
    sleep 5
    if has_gpu && [[ $be == nvenc ]]; then gpu+="$(docker exec "$ENC" nvidia-smi --query-gpu=utilization.gpu,utilization.encoder --format=csv,noheader,nounits 2>/dev/null | head -1 | tr -d ' ') "; fi
  done
  for ((i = 1; i <= n; i++)); do
    local f1 t1
    f1=$(status "d$i" | jq -r '.stats.videoFrames // 0')
    t1=$(date +%s.%N)
    i_fps=$(awk -v a="${f0[$i]}" -v b="$f1" -v s="${t0[$i]}" -v e="$t1" 'BEGIN{printf "%.2f", (b-a)/(e-s)}')
    awk -v a="$i_fps" -v m="$minfps" 'BEGIN{exit !(a<m)}' && minfps=$i_fps
    ge "$i_fps" "$(awk -v f="$want" 'BEGIN{print f*0.96}')" || low[$i]=$i_fps
  done
  c1=$(host_cpu_sample)
  local cpu
  cpu=$(awk -v a="$c0" -v b="$c1" 'BEGIN{split(a,x," "); split(b,y," "); dt=y[1]-x[1]; di=y[2]-x[2]; printf "%.0f", (dt>0)?(1-di/dt)*100:0}')
  for ((i = 1; i <= n; i++)); do
    local st
    st=$(status "d$i")
    restarts=$((restarts + $(jq '.engine.restarts + .stalls' <<<"$st")))
    [[ $(jq -r .state <<<"$st") =~ live|degraded ]] || { fail=1; low[$i]="state=$(jq -r .state <<<"$st") $(jq -r '.error // ""' <<<"$st" | cut -c1-120)"; }
  done
  ((${#low[@]})) && fail=1
  ((restarts)) && fail=1
  local enc_util=""
  [[ -n $gpu ]] && enc_util=" gpu(util,enc)%=[$(tr ' ' '\n' <<<"$gpu" | sort -t, -k2 -n | tail -1)]"
  local det="$n× $(jq -r '"\(.width)x\(.height)p\(.fps) \(.bitrateKbps)kbps"' <<<"$v") min_fps=$minfps host_cpu=${cpu}%${enc_util} restarts=$restarts"
  ((${#low[@]})) && det+=" below: $(for k in "${!low[@]}"; do printf 'd%s=%s ' "$k" "${low[$k]}"; done)"
  for ((i = 1; i <= n; i++)); do api DELETE "/channels/d$i" >/dev/null; done
  sleep 3
  if ((fail)); then
    result density "$be-$codec-${n}ch" FAIL "$det"
    return 1
  fi
  result density "$be-$codec-${n}ch" PASS "$det"
}

density_backend() { # backend codec video_json steps...
  # one ~9.5 min file (the clip ×41): no fallbacksrc loop restart (≈1–2 s without
  # frames each time) inside a 100 s measurement
  [[ -n $REAL_MEDIA ]] && rx "test -s /res/density-long.mp4 || ffmpeg -nostdin -loglevel error -stream_loop 40 -i /media/real.mp4 -c copy /res/density-long.mp4"
  local be=$1 codec=$2 v=$3
  shift 3
  local n best=0
  for n in "$@"; do
    if density_step "$be" "$codec" "$n" "$v"; then best=$n; else break; fi
  done
  result density "$be-$codec-MAX" INFO "max real-time channels: $best (last passing step)"
}

suite_density() {
  # 1080i50-class workload: 1920x1080 at 25 frames/s (= 50 fields/s), real clip transcoded.
  density_backend x265-medium h265 '{"codec":"h265","encoder":"x265","width":1920,"height":1080,"fps":"25","bitrateKbps":4000,"preset":"medium","bframes":3}' ${DENSITY_X265M:-1 2 3}
  density_backend x265-faster h265 '{"codec":"h265","encoder":"x265","width":1920,"height":1080,"fps":"25","bitrateKbps":4000,"preset":"faster","bframes":3}' ${DENSITY_X265:-1 2 3 4 5 6}
  density_backend x264-veryfast h264 '{"codec":"h264","encoder":"x264","width":1920,"height":1080,"fps":"25","bitrateKbps":6000,"preset":"veryfast"}' ${DENSITY_X264:-4 8 12 16 20}
  if has_gpu; then
    density_backend nvenc h265 '{"codec":"h265","encoder":"nvenc","width":1920,"height":1080,"fps":"25","bitrateKbps":4000}' ${DENSITY_NVENC:-2 4 8 12}
  fi
}
