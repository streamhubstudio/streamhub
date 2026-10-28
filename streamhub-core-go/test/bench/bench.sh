#!/usr/bin/env bash
# Node-vs-Go core benchmark driver (internal design notes).
# Layout of $ROOT (a scratch dir on the bench box):
#   streamhub-core/   dist + package*.json + scripts/seed-token.js, `npm ci --omit=dev` (Node 24)
#                     — the retired NestJS core: build it from branch legacy/node-2.x (tag 2.24.0)
#   streamhub-go      linux build of streamhub-core-go/cmd/streamhub
#   loadgen           linux build of streamhub-core-go/test/bench/loadgen
#   VERSION
# Run EVERYTHING inside a private netns (see netns.sh):  sudo ./netns.sh ./bench.sh …
# Usage:
#   bench.sh seed                       # seeded DATA_DIR template (Node boot + seed-token)
#   bench.sh start node|go              # fresh copy of the template, feeder + server (pinned)
#   bench.sh stop                       # kill server + feeder
#   bench.sh hls  node|go [ramp]        # HLS fan-out ramp → results/<impl>-hls.jsonl
#   bench.sh api  node|go [rates]       # API ramp → results/<impl>-api.jsonl
#   bench.sh mixed node|go <viewers>    # HLS at <viewers> + API probes at 50 rps
set -euo pipefail
ROOT=${ROOT:-$HOME/scratch/gobench}
PORT=${PORT:-3410}
SERVER_CPUS=${SERVER_CPUS:-0-7}   # server pinned to 8 hardware threads
LOAD_CPUS=${LOAD_CPUS:-8-23}      # load generator on the rest
TOKEN=sk_bench_global_token_0123456789abcdef0123456789abcdef
METRICS_TOKEN=bench-metrics
cd "$ROOT"
mkdir -p results run
source "$HOME/.nvm/nvm.sh" >/dev/null && nvm use 24 >/dev/null

coreenv() {
  cat <<EOF
NODE_ENV=production
PORT=$PORT
HOST=127.0.0.1
DATA_DIR=$1
ADMIN_USER=admin
ADMIN_PASS=bench-admin-pass
STREAMHUB_JWT_SECRET=bench-jwt-secret-0123456789abcdef0123
REDIS_URL=redis://127.0.0.1:63999
LIVEKIT_URL=ws://127.0.0.1:1
LIVEKIT_API_KEY=benchkey
LIVEKIT_API_SECRET=benchsecret0123456789abcdef0123456789
METRICS_TOKEN=$METRICS_TOKEN
STREAMHUB_AUTHZ_ENFORCE=on
STREAMHUB_PUBLIC_REGISTRATION=off
STREAMHUB_IP_ACCESS_MODE=off
STREAMHUB_IP_AUTOBAN=off
EOF
}

waitup() {
  for _ in $(seq 1 120); do
    curl -fsS "http://127.0.0.1:$PORT/api/v1/health" >/dev/null 2>&1 && return 0
    sleep 0.5
  done
  echo "server did not come up" >&2; return 1
}

startcore() { # impl datadir
  local impl=$1 data=$2
  coreenv "$data" > run/env
  set -a; source run/env; set +a
  # prod units set LimitNOFILE=200000 (deploy/streamhub-core.service); Node
  # does not raise its soft limit itself, Go does
  ulimit -n 200000
  if [ "$impl" = node ]; then
    (cd run && exec taskset -c "$SERVER_CPUS" node "$ROOT/streamhub-core/dist/main.js" > "$ROOT/run/$impl.log" 2>&1) &
  else
    (cd run && exec taskset -c "$SERVER_CPUS" "${GO_BIN:-$ROOT/streamhub-go}" > "$ROOT/run/$impl.log" 2>&1) &
  fi
  echo $! > run/server.pid
  waitup
  # the subshell exec'd, so $! is the server itself
  echo "$impl up (pid $(cat run/server.pid))"
}

case ${1:-} in
seed)
  rm -rf template && mkdir -p template
  cp VERSION run/ 2>/dev/null || true
  startcore node "$ROOT/template"
  kill "$(cat run/server.pid)"; sleep 2
  echo -n "$TOKEN" | DATA_DIR="$ROOT/template" NODE_PATH="$ROOT/streamhub-core/node_modules" \
    node streamhub-core/scripts/seed-token.js - bench-global
  ls template template/apps
  ;;
start)
  impl=$2
  rm -rf "data-$impl" && cp -a template "data-$impl"
  cp VERSION run/ 2>/dev/null || true
  taskset -c "$LOAD_CPUS" ./loadgen feeder -dir "$ROOT/data-$impl/apps/live/hls/bench" > run/feeder.log 2>&1 &
  echo $! > run/feeder.pid
  startcore "$impl" "$ROOT/data-$impl"
  ;;
stop)
  for p in server feeder; do [ -f run/$p.pid ] && kill "$(cat run/$p.pid)" 2>/dev/null || true; rm -f run/$p.pid; done
  sleep 2
  ;;
hls)
  impl=$2; ramp=${3:-100,500,1000,2500,5000,10000}
  ulimit -n 200000
  taskset -c "$LOAD_CPUS" ./loadgen hls -label "$impl" -url "http://127.0.0.1:$PORT/hls/live/bench/index.m3u8" \
    -ramp "$ramp" -hold "${HOLD:-30s}" -joinrate "${JOINRATE:-500}" -pid "$(cat run/server.pid)" \
    -metrics "http://127.0.0.1:$PORT/metrics?token=$METRICS_TOKEN" | tee -a "results/$impl-hls.jsonl"
  ;;
api)
  impl=$2; rates=${3:-100,250,500,1000,2000,4000,8000}
  ulimit -n 200000
  taskset -c "$LOAD_CPUS" ./loadgen api -label "$impl" -base "http://127.0.0.1:$PORT" -token "$TOKEN" \
    -rates "$rates" -hold "${HOLD:-20s}" -pid "$(cat run/server.pid)" \
    -metrics "http://127.0.0.1:$PORT/metrics?token=$METRICS_TOKEN" | tee -a "results/$impl-api.jsonl"
  ;;
mixed)
  impl=$2; viewers=$3
  ulimit -n 200000
  taskset -c "$LOAD_CPUS" ./loadgen hls -label "$impl-mixed" -url "http://127.0.0.1:$PORT/hls/live/bench/index.m3u8" \
    -ramp "$viewers" -hold "${MIXHOLD:-90s}" -joinrate "${JOINRATE:-500}" -pid "$(cat run/server.pid)" > "results/$impl-mixed-hls.jsonl" &
  hp=$!
  sleep 20   # viewers joined + warm
  taskset -c "$LOAD_CPUS" ./loadgen api -label "$impl-mixed" -base "http://127.0.0.1:$PORT" -token "$TOKEN" \
    -rates 50 -duration 60s -hold 15s \
    -metrics "http://127.0.0.1:$PORT/metrics?token=$METRICS_TOKEN" | tee -a "results/$impl-mixed-api.jsonl"
  wait $hp; cat "results/$impl-mixed-hls.jsonl"
  ;;
*) sed -n 2,16p "$0"; exit 2 ;;
esac
