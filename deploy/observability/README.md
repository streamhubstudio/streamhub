# Observabilidad StreamHub — Fase 1

Stack Prometheus + Grafana + node_exporter, **separado** del media stack
(`docker-compose.yml` en la raíz del repo — ciclo de vida independiente, no se
tocan sus servicios). Materializa la Fase 1 de
[operations/OBSERVABILITY-ROADMAP](https://streamhub.studio/docs/operations/OBSERVABILITY-ROADMAP)
(§4). Leé ese documento para el diseño completo (inventario de métricas,
tableros panel-por-panel, alerting, fases 2/3) — acá sólo el **cómo desplegar**.

Nodo de referencia (`stream01`): 8 GB RAM + 8 GB swap, sin GPU, compartido con
el media stack (LiveKit + core nativos por systemd; `ingress`/`egress`/`redis`
en Docker). Cuello de botella = RAM (cada `egress` es un Chrome headless) → **todo
este stack bindea a `127.0.0.1` y nunca se expone directo a Internet.**

## Requisitos previos

Antes de habilitar los jobs `livekit` / `livekit-ingress` / `livekit-egress` en
`prometheus.yml`, el media stack necesita `prometheus_port` en cada
`*_CONFIG_BODY` (roadmap §4.3) — **eso lo maneja el despliegue del media
stack, no este directorio**. Si esos puertos aún no están habilitados, esos
tres jobs simplemente van a aparecer `down` en Prometheus (no rompen nada, ver
alertas `LiveKitDown` / `LiveKitEgressDown` / `LiveKitIngressDown`).

## 1. Configurar secretos

```bash
cd deploy/observability

# Password de admin de Grafana (obligatorio, sin default)
cp .env.example .env
$EDITOR .env    # setear GRAFANA_ADMIN_PASSWORD

# Token de streamhub-core para el job de scrape (si METRICS_TOKEN está seteado
# en el core — ver https://streamhub.studio/docs/operations/ENV). Si el core corre con
# METRICS_TOKEN unset (endpoint público), este archivo puede quedar con el
# placeholder: el header Bearer de más no rompe nada.
cp secrets/metrics_token.example secrets/metrics_token
$EDITOR secrets/metrics_token   # pegar el METRICS_TOKEN real (mtk_…)
```

`secrets/metrics_token` y `.env` quedan **gitignoreados** (ver `.gitignore` en
este directorio y el patrón `**/.env` del `.gitignore` raíz) — nunca commitear
el valor real. `prometheus.yml` referencia el archivo vía `credentials_file`,
no lleva el token en texto plano.

## 2. Levantar el stack

Desde la raíz del repo:

```bash
docker compose -f deploy/observability/docker-compose.observability.yml \
  --env-file deploy/observability/.env up -d
```

Verificar:

```bash
# Targets — todos deberían pasar a UP (salvo ingress/egress si aún no tienen
# prometheus_port habilitado, ver "Requisitos previos"):
curl -s http://127.0.0.1:9090/api/v1/targets | jq '.data.activeTargets[] | {job: .labels.job, health}'

# Grafana arriba:
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3001/login
```

Bajar el stack: `docker compose -f deploy/observability/docker-compose.observability.yml down`
(los datos de Prometheus/Grafana persisten en los volúmenes nombrados `prom_data`
/ `grafana_data` — `down -v` si además querés borrarlos).

## 3. Acceder a Grafana (nunca expuesto público)

Grafana bindea a `127.0.0.1:3001` en el nodo — por diseño, **no hay puerto
publicado al mundo**. Dos formas de entrar, elegí una:

### Opción A — túnel SSH (más simple, sin tocar nginx)

```bash
ssh -N -L 3001:127.0.0.1:3001 usuario@stream01
# abrir http://127.0.0.1:3001 en el browser local
```

### Opción B — nginx con auth (acceso más cómodo, requiere mantenimiento aparte)

Agregar un `server{}` / `location{}` en la config de nginx del nodo (fuera de
este directorio — no forma parte de este stack) que:

- Proxyea a `http://127.0.0.1:3001`.
- Exige **Basic Auth** (`auth_basic` + `htpasswd`) o restringe por IP
  (`allow`/`deny`), además del login propio de Grafana.
- Usa un subdominio/subpath dedicado (p. ej. `obs.streamhub.example.com`) con
  TLS de certbot, igual que el resto del nodo (ver `deploy/nginx-streamhub.conf`
  del repo como referencia de patrón, sin copiarlo tal cual).

En cualquier caso, el usuario/password de Grafana es sólo la **segunda** capa
(`GF_SECURITY_ADMIN_PASSWORD` del `.env`) — la primera es no tener el puerto
público y/o el auth de nginx.

## 4. Presupuesto de RAM (nodo de 8 GB, compartido con el media stack)

| Componente | `mem_limit` en el compose | Real esperado |
|---|---|---|
| Prometheus | 512m (reserva 256m) | 150–300 MB con el volumen de métricas actual |
| Grafana | 256m (reserva 128m) | 80–150 MB |
| node_exporter | 64m | ~20 MB |
| **Total** | **~832 MB tope duro** | **~250–470 MB real** |

Esto compite directamente con el headroom de `egress` (cada uno es un Chrome
headless) — por eso los `mem_limit` son topes explícitos y por eso, si el nodo
empieza a apretar, la Fase 2 del roadmap mueve todo este stack a una VM chica
aparte (§4.1 de OBSERVABILITY-ROADMAP.md) en vez de subir límites acá.

Retención de Prometheus: `--storage.tsdb.retention.time=15d` (default, override
con `PROMETHEUS_RETENTION_TIME` en `.env`) + tope duro de disco
`--storage.tsdb.retention.size=4GB` (`PROMETHEUS_RETENTION_SIZE`). 30 días de
retención es el objetivo **al mover la observabilidad a un nodo dedicado**, no
en `stream01` (mismo criterio que el roadmap para Loki, §3.4).

## 5. Qué incluye este directorio

| Archivo | Rol |
|---|---|
| `docker-compose.observability.yml` | Stack separado: prometheus + grafana + node-exporter, `network_mode: host`, todo bindeado a `127.0.0.1`. |
| `prometheus.yml` | Scrape configs: `streamhub-core` (con bearer token vía `credentials_file`), `livekit`, `livekit-ingress`, `livekit-egress`, `node`, `prometheus`. |
| `alerts.yml` | Reglas: RAM/swap/disco del host, `streamhub-core`/LiveKit/egress/ingress down, fallos de grabación, backlog VOD, callbacks fallidos, spike de errores por log, vencimiento de cert TLS. |
| `.env.example` / `secrets/metrics_token.example` | Plantillas de secretos — copiar y completar, nunca commitear los reales. |
| `scripts/cert-expiry-textfile.sh` | Hook opcional de certbot que alimenta la alerta `TlsCertExpiringSoon` (textfile collector de node_exporter). |
| `grafana/provisioning/` | Datasource Prometheus + provider de dashboards (auto-carga al boot de Grafana, sin click-ops). |
| `grafana/dashboards/server-global.json` | Tablero 5.A del roadmap: salud del host + del servicio. |
| `grafana/dashboards/per-app.json` | Tablero 5.B: variable `$app`, viewers/streams/grabaciones/VODs/callbacks/quota por app. |
| `grafana/dashboards/media-latency.json` | Tablero 5.C: métricas nativas de LiveKit (RTT, forward latency, packet loss, NACK/PLI, rooms). |

## 6. Modo cluster (multi-nodo + logs)

Para monitorear una **flota de 3 nodos** (master `stream01` + `stream02`/`stream03`)
con **un solo** Prometheus + Grafana + **Loki** en el master, este directorio trae un
set **aditivo** de assets bajo `cluster/` + `prometheus.cluster.yml` + `alerts.cluster.yml`
+ los dashboards `cluster-overview.json` / `cluster-logs.json` + el datasource Loki. El
stack single-node de arriba **no se toca**: el modo cluster es un overlay opcional.

Guía completa (arquitectura, firewall port-by-port, cómo agregar/quitar un nodo, seguridad):
[operations/CLUSTER-OBSERVABILITY](https://streamhub.studio/docs/operations/CLUSTER-OBSERVABILITY).

**En el master** (levanta prom-cluster + grafana + node_exporter + Loki + Promtail):

```bash
cd deploy/observability
cp .env.example .env                       # GRAFANA_ADMIN_PASSWORD
cp secrets/metrics_token.example secrets/metrics_token   # METRICS_TOKEN (mismo en la flota)
cluster/install-cluster-observability.sh   # o: docker compose -f docker-compose.observability.yml \
                                           #      -f cluster/docker-compose.cluster.yml --env-file .env up -d
```

Aplicar en el master el snippet `cluster/nginx-loki-push.conf` (ingreso de logs de los nodos).

**En cada nodo** (`stream02`/`stream03`):

```bash
# nginx: pegar cluster/nginx-metrics-export.conf en el server{} 443 del nodo → reload
cd deploy/observability/cluster
cp .env.node.example .env.node             # NODE_NAME + MASTER_LOKI_PUSH_URL
./install-node-agent.sh                    # node_exporter :9100 + Promtail
sudo ufw allow from 203.0.113.10 to any port 9100 proto tcp
```

| Archivo (cluster) | Rol |
|---|---|
| `prometheus.cluster.yml` | Scrape de los 3 nodos (core/livekit/ingress/egress/node), label `node` por target. Master local `127.0.0.1`; nodos vía nginx TLS + `:9100`. |
| `alerts.cluster.yml` | Alertas por-nodo (core/livekit/exporter down por nodo, nodo totalmente inalcanzable, Loki/Promtail down, RAM/disco por nodo). |
| `cluster/docker-compose.cluster.yml` | Overlay del master: cambia Prometheus a la config cluster + agrega Loki y Promtail(master). |
| `cluster/loki-config.yml` | Loki single-binary, filesystem, retención 30d, `127.0.0.1:3100`. |
| `cluster/promtail-master.yml` | journald (`skyline-core`/`livekit`) + docker (ingress/egress/redis) + nginx. |
| `cluster/promtail-node.yml` | docker (core/livekit/ingress/egress/redis) + nginx; push al Loki del master. |
| `cluster/node-agent-compose.yml` | Agente de nodo: node_exporter (:9100) + Promtail. |
| `cluster/nginx-metrics-export.conf` | Snippet nginx del NODO: expone `/metrics*` sólo al master. |
| `cluster/nginx-loki-push.conf` | Snippet nginx del MASTER: recibe push de logs sólo de las IPs de nodo. |
| `cluster/install-cluster-observability.sh` / `install-node-agent.sh` | Instaladores idempotentes (master / nodo). |
| `grafana/dashboards/cluster-overview.json` / `cluster-logs.json` | Tableros: salud/recursos por nodo · explorador de logs por `node`/`service` + tasa de error. |

## Qué queda fuera de este stack (Fase 2/3 del roadmap)

- **Chunks de Loki en S3** (hoy filesystem local en el master) y **Alloy** como
  agente alternativo a Promtail — ver el comentario de `cluster/loki-config.yml`
  y §3.3 del roadmap. Loki ya está integrado en modo cluster (sección 6).
- **Alertmanager** — este directorio sólo trae las *reglas* (`alerts.yml`);
  el ruteo/notificación (Slack, email, PagerDuty…) no está desplegado. En el
  ínterin, revisar `http://127.0.0.1:9090/alerts` o las alertas nativas de
  Grafana (`Alerting` en la UI, ya apunta al datasource provisionado).
- **`prometheus_port` en `docker-compose.yml`** (livekit/ingress/egress) —
  cambio en el compose del media stack, fuera del alcance de este directorio.
- Métricas fase 2/3 del core (`streamhub_bytes_ingest_total`,
  `streamhub_bytes_egress_total`, `streamhub_ingest_latency_seconds`,
  `streamhub_s3_bucket_bytes`, `streamhub_recording_duration_seconds`) — el
  panel "Ingest por protocolo" de `per-app.json` ya está armado para cuando
  existan, pero hoy queda vacío.
- Job de purga 30 días de `server_logs` en el core (mencionado en el roadmap
  §3.4/§7 fase 1) — es un cambio de código del core, no de este stack de
  despliegue.
- **Alertmanager con routing** para el cluster (Slack/email/PagerDuty) —
  `alerts.cluster.yml` ya trae las reglas por-nodo; el ruteo no está desplegado.
  El resto de "cluster / multi-nodo" (Prometheus central, dashboards agregados)
  **ya está** — ver sección 6 y `CLUSTER-OBSERVABILITY.md`.
