#!/usr/bin/env bash
# ============================================================================
# install-cluster-observability.sh — MASTER (stream01)
# ----------------------------------------------------------------------------
# Levanta el stack de observabilidad en MODO CLUSTER: Prometheus (config de 3
# nodos) + Grafana + node_exporter + Loki + Promtail(master). Idempotente:
# re-correrlo reconcilia el estado (docker compose up -d).
#
# NO toca el media stack. NO abre puertos al mundo (todo bindea 127.0.0.1; el
# ingreso remoto de métricas/logs pasa por nginx del nodo/master con allowlist).
#
# Uso:
#   deploy/observability/cluster/install-cluster-observability.sh
#   deploy/observability/cluster/install-cluster-observability.sh --down   # baja el stack
#   deploy/observability/cluster/install-cluster-observability.sh --steps  # sólo imprime los pasos por-nodo
# ============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OBS_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"        # deploy/observability
BASE="docker-compose.observability.yml"
OVERLAY="cluster/docker-compose.cluster.yml"

MASTER_IP="203.0.113.10"
NODE_IPS=("203.0.113.11" "203.0.113.12")       # stream02, stream03

c_reset=$'\033[0m'; c_bold=$'\033[1m'; c_grn=$'\033[32m'; c_ylw=$'\033[33m'; c_red=$'\033[31m'
say()  { printf '%s\n' "$*"; }
ok()   { printf '%s[ok]%s %s\n'   "$c_grn" "$c_reset" "$*"; }
warn() { printf '%s[!]%s %s\n'    "$c_ylw" "$c_reset" "$*"; }
die()  { printf '%s[x]%s %s\n'    "$c_red" "$c_reset" "$*" >&2; exit 1; }

compose() { docker compose -f "${BASE}" -f "${OVERLAY}" --env-file .env "$@"; }

print_node_steps() {
  cat <<EOF

${c_bold}=== PASOS EN CADA NODO DEL CLUSTER (stream02=${NODE_IPS[0]}, stream03=${NODE_IPS[1]}) ===${c_reset}

Correr en el NODO (no en el master). Ver también cluster/install-node-agent.sh.

1) Exponer métricas al master vía nginx del nodo:
   - Pegá el contenido de cluster/nginx-metrics-export.conf dentro del server{}
     TLS (listen 443) que ya proxya la app a streamhub-core.
   - nginx -t && systemctl reload nginx
   - Verificá que livekit/ingress/egress tengan prometheus_port (6789/6790/6791)
     en sus *_CONFIG_BODY (si no, esos jobs quedan 'down', no rompe el resto).

2) Levantar el agente de nodo (node_exporter :9100 + Promtail):
   - cd deploy/observability/cluster
   - cp .env.node.example .env.node   # NODE_NAME + MASTER_LOKI_PUSH_URL
   - docker compose -f node-agent-compose.yml --env-file .env.node up -d

3) Firewall del NODO (ufw) — abrir SÓLO al master:
   sudo ufw allow from ${MASTER_IP} to any port 9100 proto tcp   # node_exporter
   # 443 ya está abierto (nginx). NO abras 3020/6789/6790/6791 al mundo:
   # el core es loopback-only y livekit/ingress/egress salen sólo por nginx.
   sudo ufw deny 6789 ; sudo ufw deny 6790 ; sudo ufw deny 6791   # por las dudas

${c_bold}=== FIREWALL DEL MASTER (stream01=${MASTER_IP}) ===${c_reset}

Ingreso de logs (elegí UNA opción de push en cada nodo):
  A) Vía nginx TLS (recomendado): pegá cluster/nginx-loki-push.conf en el
     server{} 443 del master. NO hace falta abrir :3100 (Loki es loopback).
  B) Directo (cleartext): si usás http://${MASTER_IP}:3100 como push URL,
     bindeá Loki a una IP alcanzable y:
       sudo ufw allow from ${NODE_IPS[0]} to any port 3100 proto tcp
       sudo ufw allow from ${NODE_IPS[1]} to any port 3100 proto tcp

Grafana/Prometheus del master siguen SIN puerto público (127.0.0.1). Entrá por
túnel SSH (ssh -L 3001:127.0.0.1:3001 stream01) o nginx con auth.

${c_bold}=== VERIFICAR (en el master) ===${c_reset}
  curl -s http://127.0.0.1:9091/api/v1/targets | jq '.data.activeTargets[]|{job:.labels.job,node:.labels.node,health}'
  curl -s http://127.0.0.1:3100/ready        # Loki listo
  curl -s http://127.0.0.1:9080/ready        # Promtail master listo
EOF
}

# ---- subcomandos ----------------------------------------------------------
cd "${OBS_DIR}"

case "${1:-up}" in
  --steps) print_node_steps; exit 0 ;;
  --down)
    say "Bajando el stack de observabilidad (los volúmenes persisten)..."
    compose down
    ok "Stack detenido. 'docker volume rm' para borrar datos de prom/grafana/loki."
    exit 0
    ;;
  up|"") : ;;
  *) die "Argumento desconocido: $1 (usá: up | --down | --steps)" ;;
esac

# ---- prechequeos ----------------------------------------------------------
command -v docker >/dev/null 2>&1 || die "docker no está instalado."
docker compose version >/dev/null 2>&1 || die "'docker compose' (v2) no disponible."
[ -f "${BASE}" ]    || die "No encuentro ${BASE} (¿corriendo desde el repo?)."
[ -f "${OVERLAY}" ] || die "No encuentro ${OVERLAY}."

if [ ! -f .env ]; then
  [ -f .env.example ] && cp .env.example .env
  warn "Creé .env desde .env.example — EDITÁ GRAFANA_ADMIN_PASSWORD antes de exponer Grafana."
fi
grep -q '^GRAFANA_ADMIN_PASSWORD=__CHANGE_ME__' .env 2>/dev/null && \
  warn "GRAFANA_ADMIN_PASSWORD sigue en __CHANGE_ME__ — cambialo en deploy/observability/.env"

if [ ! -f secrets/metrics_token ]; then
  cp secrets/metrics_token.example secrets/metrics_token
  warn "Creé secrets/metrics_token desde el ejemplo — PEGÁ el METRICS_TOKEN real (mismo en los 3 nodos)."
fi

# ---- render de config (validación rápida) --------------------------------
say "Validando la config de compose (base + overlay cluster)..."
compose config -q && ok "compose config válido."

# ---- levantar -------------------------------------------------------------
say "Levantando: Prometheus(cluster) + Grafana + node_exporter + Loki + Promtail..."
compose up -d
ok "Stack de cluster arriba."

# ---- health rápido --------------------------------------------------------
sleep 3
if curl -sf http://127.0.0.1:9091/-/ready >/dev/null 2>&1; then ok "Prometheus ready (:9091)."; else warn "Prometheus aún no ready en :9091 (dale unos segundos)."; fi
if curl -sf http://127.0.0.1:3100/ready   >/dev/null 2>&1; then ok "Loki ready (:3100)."; else warn "Loki aún no ready en :3100 (el primer boot tarda)."; fi

print_node_steps
ok "Listo. Los targets de stream02/03 pasarán a UP cuando apliques los pasos por-nodo."
