#!/usr/bin/env bash
# Vision Edge against the Go core with the REAL runtime: the vision_edge
# daemon of the composed `occupancy` bundle (plugins-vendor/occupancy/worker)
# in a venv (EDGE_VENV, built by run.sh / by hand: ultralytics + CPU torch).
# It dials /api/v1/edge/ws, receives an occupancy assignment on a live RTMP
# stream (a looped photo with people, played through LiveKit → HLS), runs
# YOLO on it and posts occupancy.* events back; then logs / ping round-trip,
# revoke, disconnect and re-offer. Appends to results.txt.
set -uo pipefail
source "$(dirname "$0")/env.sh"
cd "$E2E_DIR"
log() { printf '    %s\n' "$*"; }
result() { printf '%-4s %-28s %s\n' "$2" "$1" "${3:-}" | tee -a results.txt; }
TOKEN="$(cat .token)"
EDGE_VENV="${EDGE_VENV:-}"; EDGE_VENV="${EDGE_VENV:-$HOME/sh-e2e-edge/venv}"
WORKER_DIR="$E2E_DIR/plugins-vendor/occupancy/worker"
api() {
  local out
  out="$(curl -s -m 60 -w '\n%{http_code}' -X "$1" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
    "$CORE/api/v1$2" ${3:+-d "$3"})"
  CODE="${out##*$'\n'}"; BODY="${out%$'\n'*}"
}
data() { jq -c '.data // .' <<<"$BODY"; }
poll() { local n="$1"; shift; for _ in $(seq 1 "$n"); do "$@" && return 0; sleep 1; done; return 1; }
FF_PID=""; EDGE_PID=""
cleanup() { [ -n "$FF_PID" ] && kill "$FF_PID" 2>/dev/null; [ -n "$EDGE_PID" ] && kill "$EDGE_PID" 2>/dev/null; }
trap cleanup EXIT

[ -x "$EDGE_VENV/bin/python" ] || { result edge SKIP "no runtime venv at $EDGE_VENV"; exit 0; }
[ -d "$WORKER_DIR/vision_edge" ] || { result edge SKIP "no vendored occupancy bundle"; exit 0; }

# --- edge node registration (installer --node-type edge: POST /cluster/join) ---
out="$(curl -s -w '\n%{http_code}' -X POST "$CORE/api/v1/cluster/join" -H "x-cluster-token: $CLUSTER_TOKEN" \
  -H 'content-type: application/json' -d '{"name":"edge-1","ip":"127.0.0.1","region":"lab","type":"edge"}')"
EDGE_ID="$(jq -r '.data.nodeId // empty' <<<"${out%$'\n'*}")"
log "cluster/join type=edge → ${out##*$'\n'} nodeId=$EDGE_ID"

# The daemon's stdout IS its log file (VISION_EDGE_LOG), which the master's
# log_tail command reads back over the WS.
start_edge() {
  ( cd "$WORKER_DIR" || exit 1
    STREAMHUB_MASTER_URL="$CORE" STREAMHUB_CLUSTER_TOKEN="$CLUSTER_TOKEN" STREAMHUB_NODE_ID="$EDGE_ID" \
      VISION_EDGE_LOG="$E2E_DIR/logs/edge-daemon.log" VISION_EDGE_PYTHON="$EDGE_VENV/bin/python" \
      PYTHONPATH="$WORKER_DIR" PYTHONUNBUFFERED=1 YOLO_CONFIG_DIR="$E2E_DIR/yolo-cfg" \
      nohup "$EDGE_VENV/bin/python" -m vision_edge --edge >>"$E2E_DIR/logs/edge-daemon.log" 2>&1 &
    echo $! > "$E2E_DIR/.edge.pid" )
  EDGE_PID="$(cat .edge.pid)"
}
node_view() { api GET /edge/nodes; data | jq -c --arg id "$EDGE_ID" '.[] | select(.id==$id)'; }
connected() { [ "$(node_view | jq -r .connected)" = true ]; }

echo "== (n) edge runtime registers over /api/v1/edge/ws"
start_edge
if poll 60 connected; then
  V="$(node_view)"
  log "edge node: $(jq -c '{id,name,type,weight,status,connected,stale,lastSeenAt,caps:.stats.capabilities,agent:.stats.agentVersion}' <<<"$V")"
  result edge-register PASS "node=$EDGE_ID type=$(jq -r .type <<<"$V") weight=$(jq -r .weight <<<"$V") connected=true"
else
  result edge-register FAIL "not connected after 60 s: $(node_view); daemon: $(tail -5 logs/edge-daemon.log | tr '\n' ' ')"
  exit 0
fi

# --- a real stream with people: a looped photo pushed over RTMP → LiveKit → HLS
echo "== (o) assignment on a live stream → edge runs YOLO → occupancy events"
api POST "/apps/$APP/plugins/occupancy/install" '{"config":{"device":"cpu","fps":2,"confidence":0.3}}'
log "install occupancy → $CODE"
[ -s bus.jpg ] || curl -sfL -o bus.jpg https://ultralytics.com/images/bus.jpg
api POST "/apps/$APP/ingress" '{"inputType":"rtmp","room":"e2e-edge","participantIdentity":"edgecam","enableTranscoding":true}'
ROOM="$(data | jq -r '.roomName // empty')"; URL="$(data | jq -r '.url')"; KEY="$(data | jq -r '.streamKey')"
ffmpeg -nostdin -loglevel error -re -loop 1 -framerate 10 -i bus.jpg -f lavfi -i anullsrc=r=44100:cl=mono -t 900 \
  -vf scale=640:-2,format=yuv420p -c:v libx264 -preset veryfast -tune stillimage -g 20 -b:v 600k -c:a aac -b:a 32k \
  -f flv "${URL%/}/$KEY" >logs/ffmpeg-edge.log 2>&1 &
FF_PID=$!
active() { api GET "/apps/$APP/streams"; SID="$(data | jq -r --arg r "$ROOM" '[.[] | select(.status=="active" and .room==$r)][0].streamId // empty')"; [ -n "$SID" ]; }
poll 45 active || { result edge-assignment FAIL "stream for $ROOM never active"; exit 0; }
SID_ENC="$(jq -rn --arg s "$SID" '$s|@uri')"
api POST "/apps/$APP/streams/$SID_ENC/hls/start" '{}'; log "hls start → $CODE"
playlist() { curl -sf "$CORE/hls/$APP/$ROOM/index.m3u8" | grep -q EXTINF; }
poll 60 playlist || log "WARN: no HLS playlist yet"
ZONES='{"zones":[{"id":"z1","tag":"frame","detect":"personas","points":[[0,0],[1,0],[1,1],[0,1]],"confidence":0.3,"alertLimit":1,"alertAfterSec":5}]}'
api POST "/apps/$APP/edge/assignments" "{\"pluginId\":\"occupancy\",\"streamId\":\"$SID\",\"config\":{\"room\":\"$ROOM\",\"settings\":$ZONES}}"
log "create assignment → $CODE $(data | jq -c '{id,nodeId,status,detail}')"
AID="$(data | jq -r '.id // empty')"
a_status() { api GET "/apps/$APP/edge/assignments"; data | jq -r --arg id "$AID" '.[] | select(.id==$id) | .status'; }
running() { [ "$(a_status)" = running ]; }
# The shipped runtime builds its AssignmentSupervisor without on_status, so it
# never sends assignment_status frames: "the edge runs it" is proven by the
# child process + the events it posts, and the master-side status is reported.
child_up() { pgrep -f 'vision_edge --model occupancy' >/dev/null; }
if [ -n "$AID" ] && poll 60 child_up; then
  CHILD="$(pgrep -af 'vision_edge --model occupancy' | head -1)"
  sleep 5; ST="$(a_status)"
  log "edge child: ${CHILD:0:200}"; log "master-side assignment status: $ST"
  result edge-assignment PASS "assignment=$AID offered→edge child pid $(cut -d' ' -f1 <<<"$CHILD") (master status=$ST)"
else
  result edge-assignment FAIL "assignment=$AID status=$(a_status); daemon: $(tail -5 logs/edge-daemon.log | tr '\n' ' ')"
fi
occ_events() { [ -s receiver.jsonl ] && jq -e -s '[.[] | select((.event // "") | startswith("occupancy."))] | length > 0' receiver.jsonl >/dev/null; }
if poll 240 occ_events; then
  EV="$(jq -s -c '[.[] | select((.event // "") | startswith("occupancy."))]' receiver.jsonl)"
  log "events: $(jq -c '[.[] | {event, sigValid, data: (.body.data | {zone,tag,occupancy,nodeId,model})}] | .[0:3]' <<<"$EV")"
  result edge-events PASS "$(jq 'length' <<<"$EV") occupancy.* callbacks ($(jq -r '[.[].event] | unique | join(",")' <<<"$EV")), signatures valid=$(jq '[.[] | select(.sigValid)] | length' <<<"$EV")"
else
  result edge-events FAIL "no occupancy.* event in 240 s; edge child log: $(grep -h -iE 'error|detect|event' logs/edge-*.log 2>/dev/null | tail -4 | tr '\n' ' ' | cut -c1-400)"
fi

echo "== (p) command + logs round-trip over the WS"
api POST "/edge/nodes/$EDGE_ID/command" '{"command":"ping"}'; P="$CODE $(data | jq -c .)"
api GET "/edge/nodes/$EDGE_ID/logs?lines=20"; L="$CODE"; LN="$(data | jq -r '(.lines // .) | length' 2>/dev/null)"
log "ping → $P"; log "logs → $L lines=$LN sample=$(data | jq -c '(.lines // .)[-2:]' 2>/dev/null | cut -c1-300)"
if [[ "$P" == 201* ]] && [[ "$P" == *'"ok":true'* ]] && [ "$L" = 200 ] && [ "${LN:-0}" -gt 0 ]; then result edge-commands PASS "ping ok, log_tail $LN lines"
else result edge-commands FAIL "ping=$P logs=$L/$LN"; fi

echo "== (q) revoke → child stops"
api DELETE "/apps/$APP/edge/assignments/$AID"; R="$CODE $(data | jq -c '{status}' 2>/dev/null)"
child_gone() { ! pgrep -f 'vision_edge --model occupancy' >/dev/null; }
if poll 30 child_gone; then result edge-revoke PASS "revoke $R, edge child exited"
else result edge-revoke FAIL "revoke $R, child still running"; fi

echo "== (r) disconnect → node offline, assignment parks; reconnect → re-offered"
api POST "/apps/$APP/edge/assignments" "{\"pluginId\":\"occupancy\",\"streamId\":\"$SID\",\"config\":{\"room\":\"$ROOM\",\"settings\":$ZONES}}"
AID="$(data | jq -r '.id // empty')"; poll 60 child_up
kill "$EDGE_PID" 2>/dev/null; for _ in $(seq 1 20); do kill -0 "$EDGE_PID" 2>/dev/null || break; sleep 0.5; done; EDGE_PID=""
offline() { [ "$(node_view | jq -r .connected)" = false ]; }
poll 30 offline; OFF="$(node_view | jq -c '{connected,stale}')"; S1="$(a_status)"
log "after kill: node=$OFF assignment=$S1"
GONE="$(child_up && echo still-running || echo stopped)"
start_edge
poll 60 connected; S2=""; poll 90 child_up && S2=re-offered
log "after restart: node=$(node_view | jq -c '{connected}') assignment=$(a_status) child=$S2"
if [[ "$OFF" == *'"connected":false'* ]] && [ "$GONE" = stopped ] && [ "$S2" = re-offered ]; then result edge-disconnect PASS "kill → node offline, children stopped (assignment $S1); restart → re-offered, child back"
else result edge-disconnect FAIL "node=$OFF children=$GONE while-down=$S1 after=$S2"; fi
api DELETE "/apps/$APP/edge/assignments/$AID" >/dev/null
api POST "/apps/$APP/streams/$SID_ENC/hls/stop" '{}' >/dev/null
