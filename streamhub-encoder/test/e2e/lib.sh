#!/usr/bin/env bash
# Shared helpers of the e2e suites. Everything runs in containers on one
# Docker host (Linux, nvidia runtime for the NVENC cases):
#   enc-e2e-enc       encoderd under test (cap NET_ADMIN for tc netem, GPU)
#   enc-e2e-rx        receiver/measurement box (ffmpeg/ffprobe/gst/tesseract)
#   enc-e2e-mediamtx  MediaMTX (SRT/RTMP/WHIP/RTSP receiver)
#   enc-e2e-nginx     nginx-rtmp
# Results: test/e2e/results/<run>/summary.tsv (+ per-test artefacts).

E2E_NET=${E2E_NET:-enc-e2e-net}
E2E_IMAGE=${E2E_IMAGE:-enc-e2e:dev}
MEDIAMTX_IMAGE=${MEDIAMTX_IMAGE:-bluenviron/mediamtx:1.19.2-ffmpeg}
NGINX_IMAGE=${NGINX_IMAGE:-tiangolo/nginx-rtmp:latest}
ENC=enc-e2e-enc
RX=enc-e2e-rx
MTX=enc-e2e-mediamtx
NGX=enc-e2e-nginx
TOKEN=e2e-token
REAL_MEDIA=${REAL_MEDIA:-}   # host path of a real .mp4 (read-only bind)
GPU=${GPU:-auto}             # auto|on|off
RUN_ID=${RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)}
RES=${RES:-$PWD/test/e2e/results/$RUN_ID}
SUMMARY=$RES/summary.tsv

log() { printf '\033[36m[%s]\033[0m %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }

has_gpu() {
  case $GPU in on) return 0 ;; off) return 1 ;; esac
  docker info 2>/dev/null | grep -q 'Runtimes:.*nvidia' && command -v nvidia-smi >/dev/null && nvidia-smi -L >/dev/null 2>&1
}

# result SUITE TEST PASS|FAIL|SKIP "metrics / notes"
result() {
  printf '%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$4" >>"$SUMMARY"
  local c=32; [[ $3 == FAIL ]] && c=31; [[ $3 == SKIP ]] && c=33
  printf '\033[%sm%-5s\033[0m %-10s %-42s %s\n' "$c" "$3" "$1" "$2" "$4" >&2
}

infra_up() {
  mkdir -p "$RES"
  chmod 777 "$RES"
  [[ -f $SUMMARY ]] || printf 'suite\ttest\tresult\tdetails\n' >"$SUMMARY"
  docker network inspect "$E2E_NET" >/dev/null 2>&1 || docker network create "$E2E_NET" >/dev/null
  infra_down_containers
  local gpu_args=()
  if has_gpu; then gpu_args=(--runtime nvidia --gpus all -e NVIDIA_DRIVER_CAPABILITIES=video,compute,utility); fi
  local media_args=()
  [[ -n $REAL_MEDIA && -f $REAL_MEDIA ]] && media_args=(-v "$REAL_MEDIA:/media/real.mp4:ro")
  docker run -d --name "$MTX" --network "$E2E_NET" "$MEDIAMTX_IMAGE" >/dev/null
  docker run -d --name "$NGX" --network "$E2E_NET" "$NGINX_IMAGE" >/dev/null
  docker run -d --name "$RX" --network "$E2E_NET" --cap-add NET_ADMIN --entrypoint sleep \
    -v "$RES:/res" "${media_args[@]}" "$E2E_IMAGE" infinity >/dev/null
  docker run -d --name "$ENC" --network "$E2E_NET" --cap-add NET_ADMIN "${gpu_args[@]}" \
    -e ENCODERD_API_TOKEN=$TOKEN -e ENCODERD_TLS=off -e ENCODERD_LOG_LEVEL=info -e GST_PLUGIN_FEATURE_RANK=${E2E_DECODER_RANK:-} -v "$RES:/res" "${media_args[@]}" "$E2E_IMAGE" serve >/dev/null
  local i
  for i in $(seq 1 120); do
    docker exec "$ENC" curl -sf localhost:8090/api/v1/health >/dev/null 2>&1 && break
    sleep 0.5
  done
  docker exec "$RX" bash -c 'mkdir -p /tmp/w' >/dev/null
  log "infra up (gpu: $(has_gpu && echo yes || echo no)); results in $RES"
  api GET /system/capabilities >"$RES/capabilities.json"
}

infra_down_containers() {
  docker rm -f "$ENC" "$RX" "$MTX" "$NGX" >/dev/null 2>&1 || true
}

infra_down() {
  docker logs "$ENC" >"$RES/encoderd.log" 2>&1 || true
  infra_down_containers
  docker network rm "$E2E_NET" >/dev/null 2>&1 || true
}

# api METHOD PATH [JSON] → body on stdout
api() {
  local m=$1 p=$2 b=${3:-}
  if [[ -n $b ]]; then
    docker exec -i "$ENC" curl -s -X "$m" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
      --data-binary @- "localhost:8090/api/v1$p" <<<"$b"
  else
    docker exec "$ENC" curl -s -X "$m" -H "Authorization: Bearer $TOKEN" "localhost:8090/api/v1$p"
  fi
}

rx() { docker exec "$RX" bash -c "$*"; }
rxd() { docker exec -d "$RX" bash -c "$*"; }
encx() { docker exec "$ENC" bash -c "$*"; }

delete_all_channels() {
  local id
  for id in $(api GET /channels | jq -r '.[].config.id'); do api DELETE "/channels/$id" >/dev/null; done
}

# wait_state CH STATE TIMEOUT_S
wait_state() {
  local ch=$1 want=$2 t=${3:-40} i st
  for ((i = 0; i < t * 2; i++)); do
    st=$(api GET "/channels/$ch/status" | jq -r .state)
    [[ $st == "$want" ]] && return 0
    sleep 0.5
  done
  log "channel $ch state=$st (wanted $want)"
  return 1
}

# wait_output CH OUT STATE TIMEOUT
wait_output() {
  local ch=$1 o=$2 want=$3 t=${4:-30} i st
  for ((i = 0; i < t * 2; i++)); do
    st=$(api GET "/channels/$ch/status" | jq -r --arg o "$o" '.outputs[]|select(.id==$o)|.state')
    [[ $st == "$want" ]] && return 0
    sleep 0.5
  done
  return 1
}

status() { api GET "/channels/$1/status"; }

# ffprobe_streams FILE_OR_URL (inside rx) → compact JSON {v:{…},a:{…}}
probe() {
  local i out
  for i in 1 2 3; do # live sources: a probe that lands mid-GOP may miss a stream; retry
    out=$(rx "timeout 40 ffprobe -v error -rw_timeout 15000000 -analyzeduration 10M -probesize 20M -show_entries stream=codec_name,profile,width,height,r_frame_rate,avg_frame_rate,field_order,channels,sample_rate,bit_rate -of json '$1' 2>/dev/null" |
      jq -c '{v: ([.streams[]|select((.width // 0) > 0)][0] // {}), a: ([.streams[]|select(.channels!=null)][0] // {})}')
    [[ $(jq -r '.v.codec_name != null and .a.codec_name != null' <<<"$out" 2>/dev/null) == true ]] && break
  done
  echo "$out"
}

# record URL SECONDS OUTFILE(in rx, under /res) [extra ffmpeg input args]
record() {
  rx "timeout $(($2 + 25)) ffmpeg -nostdin -hide_banner -loglevel error -y ${4:-} -rw_timeout 15000000 -i '$1' -map 0 -c copy -t $2 -f mpegts '$3' 2>>/res/ffmpeg-record.log"
}

# analyze FILE (in rx) → tsanalyze JSON
analyze() { rx "encoderd tsanalyze '$1'"; }

# decode_errors FILE → number of decoder error lines over the whole file
decode_errors() { rx "ffmpeg -nostdin -v error -i '$1' -f null - 2>&1 | grep -vc '^\$' || true"; }

# selected NAME: honour ONLY=<regex> to run a subset of cases
selected() { [[ -z ${ONLY:-} || $1 =~ $ONLY ]]; }

within() { # within VALUE TARGET PCT
  awk -v v="$1" -v t="$2" -v p="$3" 'BEGIN{d=(v-t)/t*100; if(d<0)d=-d; exit !(d<=p)}'
}

ge() { awk -v a="$1" -v b="$2" 'BEGIN{exit !(a>=b)}'; }

channel_json() { # channel_json ID INPUT_JSON VIDEO_JSON [OUTPUTS_JSON] [EXTRA_JSON]
  jq -cn --arg id "$1" --argjson in "$2" --argjson v "$3" --argjson o "${4:-[]}" --argjson x "${5:-{\}}" \
    '{id:$id,enabled:true,input:$in,video:$v,outputs:$o} + $x'
}

# no-op suite: `KEEP=1 test/e2e/run.sh none` just brings the infra up for manual debugging
suite_none() { :; }

# probe_rec URL: record 8 s of a live source with ffmpeg -c copy, then probe the
# file (what a real receiver keeps; avoids ffprobe live stream-detection races)
probe_rec() {
  local f=/tmp/probe-$RANDOM.ts
  rx "timeout 40 ffmpeg -nostdin -loglevel error -y -rw_timeout 15000000 -i '$1' -map 0 -c copy -t 8 -f mpegts $f"
  probe "$f"
}
