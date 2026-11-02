# Operations — Cluster Observability (3 nodos + logs)

Cómo monitorear una **flota StreamHub de varios nodos** con **un solo** Prometheus +
Grafana + Loki corriendo en el master, más un **agente liviano** en cada nodo. Extiende
el stack single-node de [`deploy/observability/`](../../deploy/observability/) (Fase 1,
[OBSERVABILITY.md](./OBSERVABILITY.md) / [OBSERVABILITY-ROADMAP.md](./OBSERVABILITY-ROADMAP.md))
**sin romperlo**: los archivos de cluster son aditivos (`prometheus.cluster.yml`,
`alerts.cluster.yml`, `cluster/`, dashboards `cluster-*`, datasource Loki).

> Esto es la **Fase 3** del roadmap (Prometheus central scrapeando todos los nodos +
> Loki para logs). El stack Fase 1 sigue disponible tal cual para un nodo suelto.

---

## 1. Topología real

| Nodo | IP | Rol | Forma de despliegue |
|---|---|---|---|
| **stream01** | `203.0.113.10` | **master** — corre el stack de observabilidad | core + livekit **nativos** (systemd: `skyline-core.service`, `livekit.service`); ingress/egress/redis en **docker**; nginx delante |
| **stream02** | `203.0.113.11` | nodo | core+livekit+ingress+egress+redis en **docker** (compose); nginx delante |
| **stream03** | `203.0.113.12` | nodo | idem stream02 |

**La restricción que define todo el diseño:** en cada nodo, `streamhub-core` expone
`/metrics` **sólo en `127.0.0.1:3020`** — no es alcanzable de afuera. Por eso el
Prometheus del master **no puede scrapear `.57`/`.58` directo**: cada nodo **re-expone**
sus métricas por su propio nginx (TLS, allowlist del master) y su node_exporter por
`:9100` (firewalled al master). Los logs viajan al revés: cada nodo **empuja** a Loki.

```
                          MASTER stream01 (203.0.113.10)
   ┌──────────────────────────────────────────────────────────────────┐
   │  Prometheus(:9091)  Grafana(:3001)  Loki(:3100)  Promtail(:9080)  │
   │  node_exporter(:9100)      todo bindeado a 127.0.0.1              │
   │        ▲ scrape (pull)                       ▲ push (logs)         │
   └────────┼─────────────────────────────────────┼───────────────────┘
            │ https://nodo/metrics* (Bearter/TLS)  │ https://master/loki/api/v1/push
            │ http://nodo:9100  (ufw allow-master) │ (nginx master, allow node IPs)
   ┌────────┴──────────────┐              ┌────────┴──────────────┐
   │  stream02 .57         │              │  stream03 .58         │
   │  nginx  ─► core:3020  │              │  nginx  ─► core:3020  │
   │         ─► lk:6789…   │              │         ─► lk:6789…   │
   │  node_exporter:9100   │              │  node_exporter:9100   │
   │  promtail ─(docker)─► │              │  promtail ─(docker)─► │
   └───────────────────────┘              └───────────────────────┘
```

Cada serie (métrica y log) lleva un label **`node`** = `stream01|stream02|stream03`, así
los dashboards agregan/filtran por nodo.

### 1.1 Nodos EDGE (Vision Edge, tras NAT) — se monitorean VÍA EL MASTER

Lo de arriba aplica a los nodos **`common`** (media completa, IP pública, nginx delante). Los
nodos **`edge`** (Vision Edge: cómputo/visión) son otra cosa: **no tienen plano inbound
público**, **marcan el canal WS de control hacia afuera** y suelen estar **tras NAT** — el
Prometheus del master **no puede scrapearlos ni por nginx**. No les pongas node_exporter ni un
job de scrape por-nodo.

En su lugar, cada edge ya **empuja su telemetría al master** en cada heartbeat (cpu/mem/disco +
GPU/VRAM/weight), que se persiste en la tabla global `nodes`. El master la **re-exporta en su
propio `/metrics`** como los gauges `streamhub_cluster_node_*` (y el estado del scheduler:
`streamhub_edge_assignments`, `streamhub_edge_pending_assignments`,
`streamhub_edge_eligible_nodes{gpu}`), recomputados por scrape desde `nodes` + `edge_assignments`.
El label `node` es el **nombre** del nodo en el registro.

Consecuencia práctica: **con scrapear el master alcanza** para ver la salud por-nodo de toda la
flota edge + el estado de colocación. El dashboard **`Edge nodes`**
(`grafana/dashboards/edge-nodes.json`) se construye 100% sobre estos gauges, y las alertas de
capacidad en `alerts.cluster.yml` (`EdgePendingAssignments`, `EdgeNoGpuCapacity`) leen
`streamhub_edge_pending_assignments` + `streamhub_edge_eligible_nodes{gpu="true"}`. Las mismas
condiciones dejan un evento central `cluster.capacity` — consultable por
`GET /api/v1/logs?source=edge`, el dashboard **Cluster logs**, o `streamhub cluster events`.

> Distinción clave: `common` node = se scrapea (nginx TLS + node_exporter, esta guía). `edge`
> node = NO se scrapea; su telemetría llega por el master. Un cluster puede tener ambos.

---

## 2. Modelo de exposición y firewall (qué puerto se abre y a quién)

**Regla de oro:** el único puerto público de un nodo sigue siendo **443** (nginx). Todo
lo demás es loopback o firewalled al master. Nada de este stack se abre a Internet.

### 2.1 Métricas (pull: master → nodo)

| Qué | En el nodo | Cómo lo alcanza el master | Regla de firewall en el NODO |
|---|---|---|---|
| `streamhub-core` `/metrics` | `127.0.0.1:3020` (loopback) | `https://<nodo>/metrics` vía nginx `location =`, `allow 203.0.113.10; deny all;`. Bearer viaja **dentro** del TLS. | ninguna extra (443 ya abierto) |
| LiveKit `/metrics` | `127.0.0.1:6789` | `https://<nodo>/metrics/livekit` (nginx, allow-master) | `ufw deny 6789` (sólo por nginx) |
| ingress `/metrics` | `127.0.0.1:6790` | `https://<nodo>/metrics/ingress` | `ufw deny 6790` |
| egress `/metrics` | `127.0.0.1:6791` | `https://<nodo>/metrics/egress` | `ufw deny 6791` |
| node_exporter | `:9100` (todas las ifaces) | `http://<nodo-ip>:9100` directo | `ufw allow from 203.0.113.10 to any port 9100 proto tcp` |

Snippet nginx del nodo: [`cluster/nginx-metrics-export.conf`](../../deploy/observability/cluster/nginx-metrics-export.conf).
El agente node_exporter+promtail lo levanta [`cluster/node-agent-compose.yml`](../../deploy/observability/cluster/node-agent-compose.yml).

> **`allow`/`deny` ve la IP directa** (`$remote_addr`). Prometheus conecta DIRECTO al
> nginx del nodo, así que `$remote_addr` = master. Si el nodo estuviera detrás de un
> CDN/proxy, ajustá con `real_ip`/`X-Forwarded-For`.

### 2.2 Logs (push: nodo → master)

| Qué | En el master | Cómo empuja el nodo | Regla de firewall en el MASTER |
|---|---|---|---|
| Loki push | `127.0.0.1:3100` (loopback) | **Opción A (recomendada):** `https://<master>/loki/api/v1/push` vía nginx del master, `allow 203.0.113.11; allow 203.0.113.12; deny all;` (TLS, cifrado) | ninguna extra (443 ya abierto) |
| Loki push | IP alcanzable:3100 | **Opción B (simple):** `http://203.0.113.10:3100/loki/api/v1/push` (cleartext) | `ufw allow from 203.0.113.11 to any port 3100` y `.58` |

Snippet nginx del master: [`cluster/nginx-loki-push.conf`](../../deploy/observability/cluster/nginx-loki-push.conf).

**Loki no tiene auth propia** (`auth_enabled: false`) → la allowlist de nginx (o el ufw de
la Opción B) **ES** el control de acceso. Preferí la Opción A (TLS): los logs pueden
contener datos sensibles y en cleartext viajan expuestos por Internet entre nodos OVH.

### 2.3 Resumen de puertos

| Puerto | Nodo | Master | Quién lo abre / a quién |
|---|---|---|---|
| 443 (nginx) | público | público | ya abierto; sirve app + métricas (allowlist) + loki push (allowlist) |
| 9100 (node_exporter) | abierto **sólo** al master | loopback | `ufw allow from 203.0.113.10` |
| 3100 (Loki) | — | loopback (Opción A) / node IPs (Opción B) | nginx allowlist o `ufw allow from <node IPs>` |
| 3020 / 6789 / 6790 / 6791 | **loopback / deny** | loopback | nunca públicos: salen sólo por nginx |
| 9091 / 3001 / 9080 (prom/grafana/promtail) | — | loopback | túnel SSH o nginx con auth |

---

## 3. Loki push URL scheme

La URL que cada nodo pone en `MASTER_LOKI_PUSH_URL` (env de
[`cluster/.env.node.example`](../../deploy/observability/cluster/.env.node.example)):

```
# Opción A — vía nginx del master (TLS + allowlist).  RECOMENDADA.
https://<fqdn-del-master>/loki/api/v1/push

# Opción B — directo a Loki (cleartext, requiere ufw allow del master).
http://203.0.113.10:3100/loki/api/v1/push
```

El path `/loki/api/v1/push` es el endpoint estándar de ingesta de Loki; el nginx del
master lo proxya a `127.0.0.1:3100` sin reescribir el path (`proxy_pass http://127.0.0.1:3100;`).

---

## 4. Desplegar

### 4.1 En el master (stream01)

```bash
cd deploy/observability
cp .env.example .env                     # setear GRAFANA_ADMIN_PASSWORD
cp secrets/metrics_token.example secrets/metrics_token   # METRICS_TOKEN real (mismo en la flota)
cluster/install-cluster-observability.sh # levanta prom(cluster)+grafana+node_exporter+loki+promtail
```

Equivale a (idempotente, re-corré cuando quieras):

```bash
docker compose -f docker-compose.observability.yml \
               -f cluster/docker-compose.cluster.yml \
               --env-file .env up -d
```

El overlay `cluster/docker-compose.cluster.yml`:
- cambia el `--config.file` de Prometheus a `prometheus.cluster.yml` (3 nodos) y suma
  `alerts.cluster.yml`;
- agrega **Loki** (`127.0.0.1:3100`, volumen `loki_data`, retención 30d) y **Promtail**
  del master (journald de `skyline-core`/`livekit` + docker de ingress/egress/redis + nginx).

Aplicá en el master el snippet [`cluster/nginx-loki-push.conf`](../../deploy/observability/cluster/nginx-loki-push.conf)
(salvo que uses la Opción B directa).

### 4.2 En cada nodo (stream02 / stream03)

```bash
# 1) nginx: pegar cluster/nginx-metrics-export.conf en el server{} 443 del nodo
sudo nginx -t && sudo systemctl reload nginx

# 2) agente node_exporter + promtail
cd deploy/observability/cluster
cp .env.node.example .env.node           # NODE_NAME=stream02|stream03 + MASTER_LOKI_PUSH_URL
./install-node-agent.sh

# 3) ufw
sudo ufw allow from 203.0.113.10 to any port 9100 proto tcp
sudo ufw deny 6789 ; sudo ufw deny 6790 ; sudo ufw deny 6791
```

`install-cluster-observability.sh --steps` reimprime estos pasos en cualquier momento.

### 4.3 Verificar (en el master)

```bash
curl -s http://127.0.0.1:9091/api/v1/targets \
  | jq '.data.activeTargets[]|{job:.labels.job,node:.labels.node,health}'
curl -s http://127.0.0.1:3100/ready       # Loki
curl -s http://127.0.0.1:9080/ready       # Promtail master
```

Todos los targets deberían pasar a `up` con su label `node` correcto (ingress/egress
quedan `down` si el nodo aún no tiene `prometheus_port` habilitado — no rompe nada).
En Grafana: dashboards **StreamHub — Cluster overview** y **Cluster logs**.

---

## 5. Agregar / quitar un nodo

**Agregar `stream04` (ej. `203.0.113.13`):**

1. **Prometheus** (`deploy/observability/prometheus.cluster.yml`): en cada job
   (`streamhub-core`, `livekit`, `livekit-ingress`, `livekit-egress`, `node`) sumá un
   target con `labels: { node: stream04, ... }` (para core/livekit/ingress/egress:
   `"203.0.113.13:443"`; para node: `"203.0.113.13:9100"`). Recargá Prometheus:
   `curl -X POST http://127.0.0.1:9091/-/reload` (lifecycle habilitado) o
   `install-cluster-observability.sh`.
2. **nginx del nodo nuevo**: pegar `cluster/nginx-metrics-export.conf` (con `allow` del
   master); **nginx del master**: agregar `allow 203.0.113.13;` en `nginx-loki-push.conf`.
3. **Agente del nodo**: `install-node-agent.sh` con `NODE_NAME=stream04`.
4. **ufw del nodo**: `allow from 203.0.113.10 to any port 9100`.
5. Los dashboards y el template var `$node` se autopoblan (`label_values(up, node)`);
   nada que editar en Grafana.

**Quitar un nodo:** bajá su agente (`install-node-agent.sh --down`), sacá sus targets de
`prometheus.cluster.yml` y recargá, y quitá su `allow` del `nginx-loki-push.conf` del
master. Sus series históricas expiran con la retención (15d métricas / 30d logs).

---

## 6. Seguridad — checklist

- [ ] **Métricas del core sólo al master**: `location = /metrics` con `allow 203.0.113.10; deny all;` en CADA nodo. Sin esto, el `location /` general dejaría `/metrics` accesible (el core responde 403 sin token, pero igual restringilo).
- [ ] **Un mismo `METRICS_TOKEN` en la flota** (recomendado) → un solo `secrets/metrics_token`. Si difieren, un `credentials_file` por nodo (`secrets/metrics_token_stream0X`, ya gitignoreado) y partí el job `streamhub-core` por nodo.
- [ ] **Bearer siempre por TLS**: los nodos se scrapean por `https://` (nginx). Nunca `http://` a un nodo público (mandaría el token en claro).
- [ ] **node_exporter firewalled**: `ufw allow from 203.0.113.10 to any port 9100`; no dejarlo abierto al mundo.
- [ ] **Loki nunca público**: bindea `127.0.0.1:3100`; push sólo vía nginx allowlisted (Opción A) o ufw a las IPs de nodo (Opción B). `auth_enabled: false` → la allowlist ES el control.
- [ ] **Puertos de métricas de LiveKit** (`6789/6790/6791`) **no públicos**: con host-networking LiveKit puede bindearlos a `0.0.0.0`; `ufw deny` esos puertos — se alcanzan sólo por nginx/loopback.
- [ ] **Grafana/Prometheus sin puerto público**: túnel SSH (`ssh -L 3001:127.0.0.1:3001 stream01`) o nginx con auth. `GRAFANA_ADMIN_PASSWORD` es la 2ª capa, no la 1ª.
- [ ] **Secretos fuera de git**: `secrets/metrics_token`, `secrets/metrics_token_*`, `.env`, `cluster/.env.node` están gitignoreados. Nunca commitear el token real.

---

## 7. Presupuesto de recursos (el master comparte 8 GB con su media stack)

| Componente (master) | `mem_limit` | Real esperado |
|---|---|---|
| Prometheus | 512m | 150–350 MB (más series: 3 nodos) |
| Grafana | 256m | 80–150 MB |
| node_exporter | 64m | ~20 MB |
| **Loki** | 512m | 300–500 MB con ingesta real |
| **Promtail (master)** | 128m | 50–100 MB |
| **Total** | **~1.5 GB tope** | **~600 MB–1.1 GB real** |

Agente por nodo (node_exporter 64m + promtail 128m) ≈ **~70–120 MB real** por nodo.

Loki agrega **~300–500 MB** al master — es el ítem que más aprieta contra el headroom de
egress (Chrome). El roadmap (§4.1) recomienda, si el master queda ajustado, **mover todo
el stack de observabilidad a una VM chica dedicada** que scrapee los 3 nodos por su IP —
misma config, sólo cambia dónde corre. Retención: métricas 15d (`PROMETHEUS_RETENTION_TIME`),
logs 30d (`retention_period` en `cluster/loki-config.yml`). Chunks de Loki en filesystem
local; para moverlos a S3 (reusando el bucket ya configurado), ver el comentario en
`cluster/loki-config.yml`.

---

## 8. Supuestos a verificar en el despliegue real

1. **Datasource de Prometheus en Grafana apunta a `:9091`.** El compose bindea Prometheus
   en `9091` (no `9090`: el ingress de LiveKit toma `9090`). Verificá que
   `grafana/provisioning/datasources/prometheus.yml` use `http://127.0.0.1:9091` — si dice
   `9090`, los dashboards (single-node **y** cluster) salen vacíos. (Ver nota en
   `deploy/observability/README.md`.)
2. **Mismo `METRICS_TOKEN` en los 3 nodos** (ver §6). Si difieren, per-node credentials.
3. **`prometheus_port` habilitado** en livekit/ingress/egress de cada nodo (6789/6790/6791
   en los `*_CONFIG_BODY`). Sin eso, esos jobs quedan `down` (esperado, no rompe).
4. **Nombres de servicio de compose** en los nodos: el Promtail de nodo etiqueta por
   `com.docker.compose.service` esperando `core|livekit|ingress|egress|redis`. Si el media
   compose usa otros nombres (p. ej. prefijo `skyline-`), ajustá los `regex` de
   `cluster/promtail-node.yml`.
5. **journald del master accesible al container**: Promtail monta `/var/log/journal` +
   `/etc/machine-id`. La imagen `grafana/promtail` reciente trae soporte journald; si tu
   versión no, o no hay journal persistente, alterná a tail de archivo del core
   (`$DATA_DIR/logs/streamhub*.log`, pino JSON) para `skyline-core`.
6. **`$remote_addr` = master en el nginx del nodo** (sin proxy intermedio) para que la
   allowlist funcione (§2.1).
7. **TLS por IP**: `prometheus.cluster.yml` scrapea los nodos por IP con
   `insecure_skip_verify: true` (cifra, no valida CN). Para validación estricta, cambiá
   los targets a FQDN y poné `insecure_skip_verify: false`.

---

## Referencias

- [OBSERVABILITY.md](./OBSERVABILITY.md) · [OBSERVABILITY-ROADMAP.md](./OBSERVABILITY-ROADMAP.md) — single-node + diseño/roadmap.
- [`deploy/observability/README.md`](../../deploy/observability/README.md) — cómo desplegar (sección "Modo cluster").
- [../architecture/cluster.md](../architecture/cluster.md) — cluster StreamHub (origin/edge, registro de nodos).
- Grafana Loki: https://grafana.com/docs/loki/ · Promtail: https://grafana.com/docs/loki/latest/send-data/promtail/
