#!/usr/bin/env bash
# ============================================================================
# install-node-agent.sh — NODO del cluster (stream02 / stream03)
# ----------------------------------------------------------------------------
# Levanta el agente de observabilidad del nodo: node_exporter (:9100) + Promtail
# (empuja logs al Loki del master). Idempotente. NO toca el media stack.
#
# ESTO NO configura nginx ni ufw (requieren root/edición manual): el script te
# imprime EXACTAMENTE qué aplicar. La exposición de /metrics del core y de
# livekit/ingress/egress se hace por nginx (cluster/nginx-metrics-export.conf).
#
# Uso (en el nodo):
#   deploy/observability/cluster/install-node-agent.sh
#   deploy/observability/cluster/install-node-agent.sh --down
# ============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"   # deploy/observability/cluster
COMPOSE="node-agent-compose.yml"
MASTER_IP="203.0.113.10"

c_reset=$'\033[0m'; c_bold=$'\033[1m'; c_grn=$'\033[32m'; c_ylw=$'\033[33m'; c_red=$'\033[31m'
say()  { printf '%s\n' "$*"; }
ok()   { printf '%s[ok]%s %s\n' "$c_grn" "$c_reset" "$*"; }
warn() { printf '%s[!]%s %s\n'  "$c_ylw" "$c_reset" "$*"; }
die()  { printf '%s[x]%s %s\n'  "$c_red" "$c_reset" "$*" >&2; exit 1; }

cd "${SCRIPT_DIR}"

if [ "${1:-up}" = "--down" ]; then
  docker compose -f "${COMPOSE}" --env-file .env.node down
  ok "Agente de nodo detenido."
  exit 0
fi

command -v docker >/dev/null 2>&1 || die "docker no está instalado."
docker compose version >/dev/null 2>&1 || die "'docker compose' (v2) no disponible."
[ -f "${COMPOSE}" ] || die "No encuentro ${COMPOSE}."

if [ ! -f .env.node ]; then
  cp .env.node.example .env.node
  die ".env.node creado desde el ejemplo — EDITALO (NODE_NAME + MASTER_LOKI_PUSH_URL) y re-corré."
fi

# Chequeo mínimo de que se editó
grep -q '^NODE_NAME=stream0[23]' .env.node || warn "NODE_NAME no parece stream02/stream03 en .env.node — verificá."
grep -q 'example.com' .env.node && warn "MASTER_LOKI_PUSH_URL parece el placeholder (example.com) — poné el FQDN real del master."

say "Validando compose del agente..."
docker compose -f "${COMPOSE}" --env-file .env.node config -q && ok "compose config válido."

say "Levantando node_exporter (:9100) + Promtail..."
docker compose -f "${COMPOSE}" --env-file .env.node up -d
ok "Agente de nodo arriba."

NODE_NAME_VAL="$(grep -E '^NODE_NAME=' .env.node | cut -d= -f2)"

cat <<EOF

${c_bold}=== FALTA (manual, requiere root) en este nodo (${NODE_NAME_VAL:-?}) ===${c_reset}

1) nginx — exponer métricas al master:
   Pegá cluster/nginx-metrics-export.conf en el server{} TLS (443) del nodo, luego:
     sudo nginx -t && sudo systemctl reload nginx

2) ufw — abrir SÓLO al master:
     sudo ufw allow from ${MASTER_IP} to any port 9100 proto tcp   # node_exporter
     sudo ufw deny 6789 ; sudo ufw deny 6790 ; sudo ufw deny 6791   # métricas livekit sólo por nginx

3) Verificar DESDE EL MASTER:
     curl -s -H "Authorization: Bearer \$METRICS_TOKEN" https://<este-nodo>/metrics | head
     curl -s http://<IP-de-este-nodo>:9100/metrics | head

${c_bold}Health local del agente:${c_reset}
     curl -s http://127.0.0.1:9080/ready     # Promtail
     curl -s http://127.0.0.1:9100/metrics | head   # node_exporter
EOF
ok "Listo el agente. Aplicá nginx + ufw y el master empezará a scrapear/recibir logs."
