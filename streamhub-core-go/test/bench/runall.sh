#!/usr/bin/env bash
# Full Node-vs-Go series, each scenario Node then Go back-to-back (so any
# concurrent host load hits both alike); host load is logged before/after
# every run into results/hostload.log. Run as:  sudo ./netns.sh ./runall.sh
cd "$(dirname "$0")"
hostload() {
  { echo "=== $(date -Is) $*"; uptime
    docker stats --no-stream --format '{{.Name}} cpu={{.CPUPerc}} mem={{.MemUsage}}' 2>/dev/null
  } >> results/hostload.log
}
run() { # scenario impl args…
  local sc=$1 impl=$2; shift 2
  ./bench.sh start "$impl" >/dev/null
  hostload "start $sc $impl"
  ./bench.sh "$sc" "$impl" "$@"
  hostload "end $sc $impl"
  ./bench.sh stop
}
for impl in node go; do run hls "$impl"; done
for impl in node go; do run api "$impl" 250,500,1000,2000,4000,8000,16000,32000; done
for v in ${MIXED_VIEWERS:-1000 2500}; do
  for impl in node go; do
    run mixed "$impl" "$v"
    mv "results/$impl-mixed-hls.jsonl" "results/$impl-mixed$v-hls.jsonl"
    mv "results/$impl-mixed-api.jsonl" "results/$impl-mixed$v-api.jsonl"
  done
done
echo ALLDONE
