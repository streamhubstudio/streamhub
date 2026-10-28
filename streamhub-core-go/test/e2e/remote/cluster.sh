#!/usr/bin/env bash
# Cluster control plane against two REAL Go cores on one host: the origin
# (up.sh, :P_CORE, STREAMHUB_CLUSTER_TOKEN set) and a second node B
# (:P_CORE_B, own DATA_DIR). Node B joins via its own POST /cluster/join-master,
# heartbeats with the installer's heartbeat script, goes stale when it stops,
# and serves the grid agent routes. Appends to results.txt.
set -uo pipefail
source "$(dirname "$0")/env.sh"
cd "$E2E_DIR"
log() { printf '    %s\n' "$*"; }
result() { printf '%-4s %-28s %s\n' "$2" "$1" "${3:-}" | tee -a results.txt; }
TOKEN="$(cat .token)"
CORE_B="http://127.0.0.1:$P_CORE_B"
# call BASE TOKEN METHOD PATH [JSON] [extra curl args…] → $BODY $CODE
call() {
  local base="$1" tok="$2" m="$3" p="$4" d="${5:-}"; shift 5 2>/dev/null || shift $#
  local out
  out="$(curl -s -m 30 -w '\n%{http_code}' -X "$m" ${tok:+-H "authorization: Bearer $tok"} -H 'content-type: application/json' \
    "$@" "$base/api/v1$p" ${d:+-d "$d"})"
  CODE="${out##*$'\n'}"; BODY="${out%$'\n'*}"
}
data() { jq -c '.data // .' <<<"$BODY"; }
poll() { local n="$1"; shift; for _ in $(seq 1 "$n"); do "$@" && return 0; sleep 1; done; return 1; }

# --- node B --------------------------------------------------------------------
start_b() { # [extra env…]
  rm -rf nodeb/data; mkdir -p nodeb/data
  sed -e "s|^PORT=.*|PORT=$P_CORE_B|" -e "s|^DATA_DIR=.*|DATA_DIR=$E2E_DIR/nodeb/data|" \
      -e "s|^PUBLIC_BASE_URL=.*|PUBLIC_BASE_URL=$CORE_B|" -e '/^STREAMHUB_CLUSTER_TOKEN=/d' core.env > nodeb/core.env
  for kv in "$@"; do echo "$kv" >> nodeb/core.env; done
  ( set -a; source nodeb/core.env; set +a; cd nodeb || exit 1
    nohup ../streamhub >>../logs/core-b.log 2>&1 &
    echo $! > ../.core-b.pid )
  poll 30 curl -sf -o /dev/null "$CORE_B/api/v1/health"
}
stop_b() { # SIGTERM + wait for the graceful shutdown to release the port
  [ -f .core-b.pid ] || return 0
  local pid; pid="$(cat .core-b.pid)"; kill "$pid" 2>/dev/null
  for _ in $(seq 1 40); do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
  kill -9 "$pid" 2>/dev/null; rm -f .core-b.pid
}
login_b() {
  call "$CORE_B" "" POST /auth/login "{\"user\":\"$ADMIN_USER\",\"password\":\"$ADMIN_PASS\"}"
  TOKEN_B="$(jq -r '.data.token // .token' <<<"$BODY")"
}

echo "== (h) grid agent disabled without STREAMHUB_CLUSTER_TOKEN"
start_b || { result cluster SKIP "node B did not boot: $(tail -3 logs/core-b.log)"; exit 0; }
call "$CORE_B" "" POST /grid/workers '{"pluginId":"yolo","appName":"live","command":"/bin/true"}' -H "x-cluster-token: $CLUSTER_TOKEN"
log "no token configured → $CODE $BODY"
[ -s installer.sh ] || { result cluster SKIP "installer.sh not staged"; exit 0; }
if [ "$CODE" = 503 ] || [[ "$BODY" == *"STREAMHUB_CLUSTER_TOKEN unset"* ]]; then result grid-disabled PASS "$CODE $(jq -r .message <<<"$BODY")"
else result grid-disabled FAIL "$CODE $BODY"; fi
stop_b

echo "== (i) origin self-registered"
call "$CORE" "$TOKEN" GET /cluster/nodes
ORIGIN_ROWS="$(data | jq 'length')"
log "origin /cluster/nodes → $CODE $(data | jq -c '[.[] | {id,name,status,stale,last_seen_at}]')"
call "$CORE" "$TOKEN" GET /cluster/info; log "cluster/info → $CODE $(data | jq -c '{enabled,nodesCount,joinCommand}')"
[ "${ORIGIN_ROWS:-0}" -ge 1 ] && result origin-self-register PASS "rows=$ORIGIN_ROWS" || result origin-self-register FAIL "$BODY"

echo "== (j) node B joins via POST /cluster/join-master"
start_b "STREAMHUB_CLUSTER_TOKEN=$CLUSTER_TOKEN" || { result cluster-join FAIL "node B did not boot"; exit 0; }
login_b
call "$CORE_B" "$TOKEN_B" POST /cluster/join-master "{\"masterUrl\":\"$CORE\",\"clusterToken\":\"$CLUSTER_TOKEN\",\"nodeName\":\"node-b\",\"region\":\"lab\",\"nodeIp\":\"127.0.0.1\",\"nodeUrl\":\"$CORE_B\"}"
log "join-master → $CODE $(head -c 400 <<<"$BODY")"
NODE_B="$(data | jq -r '.nodeId // empty')"
call "$CORE_B" "$TOKEN_B" GET /auth/config; ROLE_B="$(jq -r '.nodeRole // .data.nodeRole // empty' <<<"$BODY")"
call "$CORE" "$TOKEN" GET /cluster/nodes
ROW="$(data | jq -c --arg id "$NODE_B" '.[] | select(.id==$id)')"
log "origin row for B: $ROW; node B role: $ROLE_B"
if [ -n "$NODE_B" ] && [ -n "$ROW" ] && [ "$ROLE_B" = edge ]; then result cluster-join PASS "nodeId=$NODE_B role=$ROLE_B"
else result cluster-join FAIL "nodeId=$NODE_B role=$ROLE_B row=$ROW"; fi
# bad token is refused
call "$CORE" "" POST /cluster/join '{"name":"rogue","ip":"127.0.0.1"}' -H 'x-cluster-token: wrong'
log "join with a wrong token → $CODE $(jq -r .message <<<"$BODY" 2>/dev/null)"
[ "$CODE" = 401 ] && result cluster-join-bad-token PASS "401" || result cluster-join-bad-token FAIL "$CODE $BODY"

echo "== (k) heartbeat (installer script) → fresh last_seen + stats"
HB_ENV="$E2E_DIR/nodeb/heartbeat.env"
printf 'STREAMHUB_HB_URL=%s\nSTREAMHUB_HB_TOKEN=%s\nSTREAMHUB_HB_NODE_ID=%s\n' "$CORE" "$CLUSTER_TOKEN" "$NODE_B" > "$HB_ENV"
# the installer's /usr/local/bin/streamhub-heartbeat.sh, with its env path parameterized
sed -n '/^  cat > \/usr\/local\/bin\/streamhub-heartbeat.sh <<.HBEOF.$/,/^HBEOF$/p' installer.sh | sed '1d;$d' \
  | sed "s|/etc/streamhub/heartbeat.env|$HB_ENV|g" > nodeb/heartbeat.sh
chmod +x nodeb/heartbeat.sh
( for _ in $(seq 1 6); do ./nodeb/heartbeat.sh; sleep 5; done ) >>logs/heartbeat.log 2>&1
call "$CORE" "$TOKEN" GET /cluster/nodes
ROW="$(data | jq -c --arg id "$NODE_B" '.[] | select(.id==$id)')"
log "after heartbeats: $(jq -c '{status,stale,last_seen_at,stats:(.stats|{cores,cpu,memUsedRatio,grid})}' <<<"$ROW")"
SEEN="$(date -u -d "$(jq -r .last_seen_at <<<"$ROW")" +%s 2>/dev/null || true)"   # 'YYYY-MM-DD HH:MM:SS' UTC
AGE="${SEEN:+$(( $(date -u +%s) - SEEN ))}"
if [ "$(jq -r .stale <<<"$ROW")" = false ] && [ "${AGE:-999}" -le 15 ] && [ "$(jq -r '.stats.cores' <<<"$ROW")" != null ]; then
  result cluster-heartbeat PASS "last_seen ${AGE}s ago, stats.cores=$(jq -r .stats.cores <<<"$ROW") grid=$(jq -c .stats.grid <<<"$ROW")"
else result cluster-heartbeat FAIL "$ROW (age ${AGE}s)"; fi
call "$CORE" "$TOKEN" PATCH "/cluster/nodes/$NODE_B" '{"status":"draining"}'; D1="$CODE $(data | jq -r .status)"
call "$CORE" "$TOKEN" PATCH "/cluster/nodes/$NODE_B" '{"status":"active"}'; D2="$CODE $(data | jq -r .status)"
log "drain → $D1 ; reactivate → $D2"
[[ "$D1" == "200 draining" && "$D2" == "200 active" ]] && result cluster-drain PASS "$D1 / $D2" || result cluster-drain FAIL "$D1 / $D2"

echo "== (l) grid agent on node B (X-Cluster-Token)"
call "$CORE_B" "" POST /grid/workers '{"pluginId":"yolo","appName":"live","command":"/bin/true"}'
NOAUTH="$CODE"
call "$CORE_B" "" POST /grid/workers '{"pluginId":"yolo","appName":"live","command":"/bin/sh","args":["-c","echo grid-worker-up; echo to-stderr >&2; sleep 60"],"env":{"E2E":"1"}}' -H "x-cluster-token: $CLUSTER_TOKEN"
log "spawn → $CODE $(head -c 300 <<<"$BODY")"
GW="$(data | jq -r '.id // .workerId // empty')"
sleep 2
call "$CORE_B" "" GET "/grid/workers/$GW/status" "" -H "x-cluster-token: $CLUSTER_TOKEN"; ST1="$(data | jq -r '.status // .state // empty')"
call "$CORE_B" "" GET "/grid/workers/$GW/logs?limit=10" "" -H "x-cluster-token: $CLUSTER_TOKEN"; LOGS="$(data | jq -c '[.[] | (.line // .message // .)]')"
call "$CORE_B" "" POST "/grid/workers/$GW/stop" "" -H "x-cluster-token: $CLUSTER_TOKEN"; STOP="$CODE"
sleep 1
call "$CORE_B" "" GET "/grid/workers/$GW/status" "" -H "x-cluster-token: $CLUSTER_TOKEN"; ST2="$(data | jq -r '.status // .state // empty')"
call "$CORE_B" "" GET "/grid/workers/nope/status" "" -H "x-cluster-token: $CLUSTER_TOKEN"; NF="$CODE"
log "no token → $NOAUTH; status=$ST1 logs=$LOGS stop=$STOP after=$ST2 unknown=$NF"
if [ "$NOAUTH" = 401 ] && [ -n "$GW" ] && [ "$ST1" = running ] && [[ "$LOGS" == *grid-worker-up* ]] && [ "$STOP" = 200 ] && [ "$ST2" != running ] && [ "$NF" = 404 ]; then
  result grid-agent PASS "worker=$GW running→$ST2, logs ok, no-token 401, unknown 404"
else result grid-agent FAIL "noauth=$NOAUTH id=$GW st=$ST1 logs=$LOGS stop=$STOP after=$ST2 404=$NF"; fi

echo "== (m) heartbeat stops → node B goes stale (>90 s)"
stale() { call "$CORE" "$TOKEN" GET /cluster/nodes; [ "$(data | jq -r --arg id "$NODE_B" '.[] | select(.id==$id) | .stale')" = true ]; }
T0=$(date +%s)
if poll 130 stale; then result cluster-stale PASS "stale=true $(( $(date +%s) - T0 ))s after the last heartbeat (+~5 s)"
else result cluster-stale FAIL "still fresh after 130 s"; fi
echo "$NODE_B" > .node-b-id
stop_b
