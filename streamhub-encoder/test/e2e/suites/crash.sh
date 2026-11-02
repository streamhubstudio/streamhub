#!/usr/bin/env bash
# crash: kill -9 the engine (supervisor restart), kill -9 one output (only it
# restarts), SIGSTOP the engine (wedged pipeline → stall watchdog), restart
# the whole encoderd container (desired state persisted → channels resume).

now_ms() { date +%s%3N; }

# wait until the channel bus has packets newer than T0 (ms) → prints elapsed ms
wait_fresh() {
  local ch=$1 t0=$2 to=${3:-30} i last
  for ((i = 0; i < to * 10; i++)); do
    last=$(api GET "/channels/$ch/status" | jq -r '.stats.lastPacketAt // empty')
    if [[ -n $last ]]; then
      local lms
      lms=$(date -d "$last" +%s%3N 2>/dev/null || echo 0)
      if ((lms > t0 + 300)) && [[ $(api GET "/channels/$ch/status" | jq -r .state) =~ live|degraded ]]; then
        echo $(($(now_ms) - t0))
        return 0
      fi
    fi
    sleep 0.1
  done
  echo -1
  return 1
}

suite_crash() {
  local v='{"codec":"h264","encoder":"x264","width":1280,"height":720,"fps":"30","bitrateKbps":3000,"lowLatency":true}'
  local outs='[{"id":"udp","type":"udp","enabled":true,"url":"udp://enc-e2e-rx:5020"},{"id":"srt","type":"srt","enabled":true,"url":"srt://:9003","srt":{"mode":"listener"}}]'
  api POST /channels "$(channel_json cr '{"type":"test","pattern":"ball"}' "$v" "$outs")" >/dev/null
  wait_state cr live 40 || { result crash setup FAIL "not live"; return; }
  sleep 3

  # (a) engine SIGKILL
  local pid r0 t0 ms
  pid=$(status cr | jq .engine.pid)
  r0=$(status cr | jq .engine.restarts)
  t0=$(now_ms)
  encx "kill -9 $pid"
  sleep 0.3
  ms=$(wait_fresh cr "$t0" 20)
  local r1
  r1=$(status cr | jq .engine.restarts)
  if [[ $ms -gt 0 && $ms -lt 5000 && $r1 -eq $((r0 + 1)) ]]; then
    result crash engine-sigkill-recovery PASS "TS flowing again ${ms} ms after kill -9 (restarts $r0→$r1)"
  else
    result crash engine-sigkill-recovery FAIL "recovery=${ms}ms restarts $r0→$r1"
  fi
  local udp_r srt_r
  udp_r=$(status cr | jq '.outputs[]|select(.id=="udp")|.process.restarts')
  [[ $udp_r == 0 ]] && result crash outputs-survive-engine-crash PASS "output processes untouched" || result crash outputs-survive-engine-crash FAIL "udp restarts=$udp_r"

  # (b) one output SIGKILL
  sleep 2
  pid=$(status cr | jq '.outputs[]|select(.id=="srt")|.process.pid')
  local er
  er=$(status cr | jq .engine.restarts)
  encx "kill -9 $pid"
  if wait_output cr srt running 10 && sleep 1.5 && [[ $(status cr | jq '.outputs[]|select(.id=="srt")|.process.restarts') == 1 ]]; then
    local er2 udp2
    er2=$(status cr | jq .engine.restarts)
    udp2=$(status cr | jq '.outputs[]|select(.id=="udp")|.process.restarts')
    [[ $er2 == "$er" && $udp2 == 0 ]] && result crash output-sigkill-isolated PASS "srt output restarted alone (engine restarts $er, udp 0)" ||
      result crash output-sigkill-isolated FAIL "engine $er→$er2 udp=$udp2"
  else
    result crash output-sigkill-isolated FAIL "$(status cr | jq -c '.outputs[]|select(.id=="srt")')"
  fi

  # (c) wedged engine (SIGSTOP) → stall watchdog (grace 20 s from engine start)
  sleep 22
  pid=$(status cr | jq .engine.pid)
  local s0
  s0=$(status cr | jq .stalls)
  t0=$(now_ms)
  encx "kill -STOP $pid"
  ms=$(wait_fresh cr "$t0" 30)
  local s1
  s1=$(status cr | jq .stalls)
  if [[ $ms -gt 0 && $s1 -eq $((s0 + 1)) ]]; then
    result crash wedged-engine-watchdog PASS "stall detected and engine replaced; TS back after ${ms} ms (stall timeout 6 s)"
  else
    result crash wedged-engine-watchdog FAIL "ms=$ms stalls $s0→$s1"
  fi

  # (d) encoderd restart → desired state resumes
  t0=$(now_ms)
  docker restart "$ENC" >/dev/null
  local i
  for i in $(seq 1 120); do docker exec "$ENC" curl -sf localhost:8090/api/v1/health >/dev/null 2>&1 && break; sleep 0.25; done
  if wait_state cr live 40; then
    result crash encoderd-restart-resume PASS "channel live again $(($(now_ms) - t0)) ms after docker restart (config persisted)"
  else
    result crash encoderd-restart-resume FAIL "$(status cr | jq -c '{state,error}')"
  fi
  # no orphan gst-launch after the restart: exactly engine + 2 outputs
  local n
  n=$(encx "pgrep -c gst-launch-1.0")
  [[ $n == 3 ]] && result crash no-orphan-processes PASS "3 gst-launch (engine+2 outputs)" || result crash no-orphan-processes FAIL "$n gst-launch processes"
  api DELETE /channels/cr >/dev/null
  sleep 2
  n=$(encx "pgrep -c gst-launch-1.0 || true")
  [[ $n == 0 ]] && result crash delete-cleans-up PASS "0 processes after delete" || result crash delete-cleans-up FAIL "$n left"
}
