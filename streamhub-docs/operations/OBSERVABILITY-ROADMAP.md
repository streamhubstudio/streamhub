# Operations — Observability Roadmap (hacia el tablero más completo)

Documento de diseño a **medio plazo**: cómo pasar de "tenemos `/metrics`" a un
**tablero operativo completo** (server global + por-aplicación + media/latencia), con
alerting y un camino de logs, **priorizado y realizable en el nodo actual**.

> Extiende — no duplica — [OBSERVABILITY.md](./OBSERVABILITY.md) (endpoint `/metrics`,
> catálogo de métricas actuales, LiveKit nativo, Prometheus + Grafana "next") y
> [../architecture/cluster.md](../architecture/cluster.md) §Observability across nodes.
> Aquí va lo que **falta**: qué medir además, cómo tratar los logs, qué desplegar, qué
> paneles construir, qué alertar y en qué orden.

**Nodo de referencia**: VPS plain-server, **8 cores, 8 GB RAM + 8 GB swap, SIN GPU**. Forma de despliegue: LiveKit + core
nativos (systemd), `ingress`/`egress`/`redis` en Docker, nginx + certbot para TLS.
**Cuello de botella = RAM** (cada `egress` es un Chrome headless). Prometheus/Grafana/Loki
**aún no están desplegados**. Todo presupuesto de esta guía se mide contra esos 8 GB.

---

## 1. Inventario actual — qué se mide hoy

### 1.1 Métricas propias del core (`/metrics`, prefijo `streamhub_`)

Ya documentadas en [OBSERVABILITY.md](./OBSERVABILITY.md) y en
[`../../streamhub-core/deploy/OBSERVABILITY.md`](../../streamhub-core/deploy/OBSERVABILITY.md).
Resumen del **estado real** (leído de `streamhub-core/src/modules/metrics/metrics.service.ts`):

| Dominio | Métricas | Notas de cardinalidad / origen |
|---|---|---|
| HTTP | `streamhub_http_requests_total{method,route,status}`, `..._duration_seconds` (hist), `..._in_flight` | `route` = patrón matcheado (acotado); no-match → `unmatched`. Interceptor global. |
| Streams | `streamhub_active_streams{app}`, `streamhub_stream_viewers{app,room}`, `streamhub_stream_events_total{app,event}` | `active_streams` derivado de SQLite en cada scrape. `stream_viewers` ver §1.3 (gap). |
| Grabación / VOD | `streamhub_recordings_started_total{app}`, `streamhub_vods_generated_total{app}`, `streamhub_recording_failures_total{app,reason}`, `streamhub_upload_queue_depth{app}`, `streamhub_vods{app,status}` | Gauges derivados de SQLite en cada scrape. |
| S3 / egress upload | `streamhub_s3_uploads_total{provider,result}`, `streamhub_s3_upload_bytes_total{provider}`, `streamhub_s3_errors_total{op}` | Contadores in-line. |
| Callbacks | `streamhub_callbacks_total{app,event,result}` | `result` = delivered\|failed\|dropped. |
| Tenancy / quotas | `streamhub_apps{tenant}`, `streamhub_tenant_quota{tenant,metric}`, `streamhub_tenant_usage{tenant,metric}` | `metric` ∈ {maxApps, maxConcurrentStreams, maxRecordingMinutesMonth, maxEgressGbMonth, maxStorageGb} / usos análogos. |
| Transcode / GPU | `streamhub_media_transcode_total{kind,accel,type}`, `streamhub_gpu_available{type}` | Útil en cluster para saber dónde cayó el trabajo. |
| Errores | `streamhub_errors_total{source,code}` | Hoy sólo `source=http` (5xx). |
| Proceso | `process_*` / `nodejs_*` (default collectors) | **Sólo el proceso Node del core**, no el host. |

### 1.2 Métricas nativas de LiveKit — **DESACTIVADAS hoy**

`docker-compose.yml` fija `livekit/livekit-server:v1.8.4` y su `LIVEKIT_CONFIG_BODY`
**no define `prometheus_port`** → LiveKit **no** expone `/metrics` actualmente. `ingress` y
`egress` tampoco. Habilitarlo es requisito para el tablero de media/latencia (§4.3, §5.C).
Nombres de métricas verificados contra la referencia de LiveKit (§5.C) — **varían entre
versiones**; confirmá siempre contra el endpoint vivo.

### 1.3 Señales ya calculadas pero **no exportadas** (gap `/stats` vs `/metrics`)

`GET /api/v1/stats` (`health.service.ts` + `stats-response.dto.ts`) ya computa datos que el
tablero necesita y que **no** están en Prometheus. Exportarlos es fruta madura:

| Dato en `/stats` | Hoy en `/metrics` | Acción |
|---|---|---|
| `cpu.loadAvg/cores`, `memory.*`, `disk.*` del **host** | No (sólo proceso Node) | node_exporter (§4.5) + opcional gauge de disco de `DATA_DIR`. |
| `counts.rooms`, `counts.activeStreams` | `activeStreams` sí; `rooms` no | `livekit_room_total` cubre rooms; o gauge propio. |
| `egress`/`ingress` `{reachable,active,total}` | No | Nuevos gauges (§2). |
| `storage.dbSizeBytes/appsDbSizeBytes/vodTotalBytes/vodCount` | No | Nuevos gauges de storage (§2). |
| `version`, `uptimeSeconds` | `process_start_time_seconds` sí; `version` no | `streamhub_build_info{version}` (§2). |

### 1.4 Qué **no** se está midiendo (en ninguna parte)

- **Viewers por room/app en tiempo real y agregados.** `stream_viewers{app,room}` se
  **resetea en cada scrape** (`refreshDbGauges()` lo limpia) y sólo se repuebla cuando
  alguien llama `streams.get` — no es una señal continua ni hay total por app/servidor.
- **Egress/grabaciones activas** (sesiones en curso). Hay contador `recordings_started_total`
  y `upload_queue_depth`, pero **no** un gauge de "cuántas grabaciones corriendo ahora".
- **Latencia de ingest** (publish→primer media) y salud del pipeline en vivo.
- **Bytes in/out por app** (ingesta RTMP/WHIP/WebRTC y egress). LiveKit cuenta paquetes a
  nivel nodo, no por app.
- **Storage real**: tamaño de DB global/per-app y bytes/objetos de VOD por app (está en
  `/stats`, no en Prometheus). Uso de bucket S3.
- **Errores de callbacks** más allá del contador (ok, ese sí existe) — **pero** no hay
  métrica de tasa de error/warn por subsistema (`recording`, `hls`, `livekit-webhook`…).
- **Quotas cerca del tope** como serie temporal alertable (los gauges existen; falta el uso
  en tablero/alertas).
- **Vencimiento de certificado TLS** (certbot) y salud del reverse-proxy.
- **Swap** (el nodo tiene 8 GB swap; su uso es el canario de presión de RAM por egress).

---

## 2. Métricas a agregar al core (prom-client)

Lista concreta, priorizada por fase. **Reglas de cardinalidad** (estrictas, el nodo es
chico): label `app` = **OK** (acotado, decenas). Label `room` = **sólo** en gauges que se
resetean en cada scrape y con tope (`MAX_METRIC_ROOMS`, p. ej. 500) + limpieza; **jamás** en
counters (crecen sin fin). **Nunca** `identity`/participante como label (cardinalidad
ilimitada + PII). Todo hook nuevo es `@Optional()` como los actuales: si falta MetricsService,
el flujo de negocio no se rompe.

| Métrica | Tipo | Labels | Fuente / cómo | Fase |
|---|---|---|---|---|
| `streamhub_build_info` | gauge=1 | `version`, `node` | set al boot; surface de versión | 1 |
| `streamhub_viewers` | gauge | `app` | **suma por app** (sin `room`) refrescada en `refreshDbGauges()` desde LiveKit/estado — total alertable y barato | 1 |
| `streamhub_active_recordings` | gauge | `app` | grabaciones/egress en curso (desde `streams`/egress activos) | 1 |
| `streamhub_media_endpoint_up` | gauge | `kind` (egress\|ingress) | `1/0` de reachability (ya en `/stats`) | 1 |
| `streamhub_media_sessions_active` | gauge | `kind` | sesiones activas egress/ingress (ya en `/stats`) | 1 |
| `streamhub_storage_db_bytes` | gauge | `scope` (global\|apps) | tamaño DB (ya en `/stats.storage`) | 1 |
| `streamhub_storage_vod_bytes` | gauge | `app` | suma `size_bytes` de VOD por app | 1 |
| `streamhub_storage_vod_count` | gauge | `app` | nº de VOD por app | 1 |
| `streamhub_disk_bytes` | gauge | `kind` (total\|used\|free) | disco de `DATA_DIR` (complementa node_exporter; barato) | 1 |
| `streamhub_log_events_total` | counter | `source`, `level` | **puente log→métrica**: incrementar en `LogsService.write` — da tasa error/warn por subsistema **sin Loki** | 1 |
| `streamhub_recording_duration_seconds` | histogram | `app` | duración de grabación al cerrar VOD | 2 |
| `streamhub_bytes_ingest_total` | counter | `app`, `protocol` (rtmp\|whip\|webrtc) | bytes ingeridos por app (requiere contabilización en ingest/webhook) | 2 |
| `streamhub_bytes_egress_total` | counter | `app` | bytes servidos/egresados por app | 2 |
| `streamhub_ingest_latency_seconds` | histogram | `app`, `protocol` | publish→primer media (needs timestamping) | 3 |
| `streamhub_s3_bucket_bytes` | gauge | `app` | uso real del bucket (list/HEAD periódico, cacheado) | 3 |

**Notas de implementación:**

- `streamhub_viewers{app}`: hoy el único dato de viewers (`stream_viewers{app,room}`) es
  frágil (§1.4). Convertirlo en **gauge derivado en scrape** (como `active_streams`) —
  sumando participantes suscriptores por app desde LiveKit o desde el estado de rooms —
  arregla el reset y habilita el panel per-app. Mantener `{app,room}` sólo con el tope de
  cardinalidad; el agregado `{app}` es el que alimenta tablero y alertas.
- `streamhub_log_events_total{source,level}`: **la opción liviana de §3.2**. Una línea en
  `LogsService.write` (`this.metrics?.logEvent(source, level)`) convierte cada log en un tick
  de contador. Coste RAM ≈ 0; habilita alertas de "explosión de errores en `recording`" sin
  un almacén de logs.

---

## 3. Logs → observabilidad

**Prometheus no consume logs.** Hay dos caminos y conviene combinarlos.

### 3.1 Estado actual de los logs (leído del código)

`LogsService` (`modules/logs/logs.service.ts`) escribe cada evento a **tres** destinos:

1. **stdout** (pino JSON, `service: streamhub-core`) → `journalctl -u streamhub-core` / `docker
   compose logs -f core`.
2. **Archivo rotativo** `RotatingFileStream` → `$DATA_DIR/logs/streamhub.log` + archivados
   `streamhub-<ISO>.log`. Rota por **tamaño** (`LOG_MAX_BYTES`, def. 10 MB) **y por día**;
   conserva `LOG_MAX_FILES` (def. **10**) archivados. **No es retención por 30 días**.
3. **Tabla `server_logs`** (DB global): `ts, level, source, app_id, message, meta_json`.
   Consultable por `GET /api/v1/logs` (filtros app/level/desde/hasta, paginado). **No hay
   pruning temporal**: sólo `purgeAppLogs(app)` borra por app manualmente. La tabla crece
   sin límite → **gap a cerrar** si se quiere "retención 30 días" real.

`source` observados hoy: `recording`, `livekit`, `livekit-webhook`, `transcoding`,
`broadcast`, `hls`, `callbacks`, `system`, `logs`, `plugins`. Eventos de negocio ricos
(inicio/fin de grabación, VOD ready, egress hwaccel, entrega de callbacks, webhooks de
LiveKit) ya se loguean estructurados → excelente materia prima para Loki **y** para el puente
log→métrica.

### 3.2 Opción A — puente log→métrica en el core (sin almacén de logs)

Añadir `streamhub_log_events_total{source,level}` (§2). Con eso, **sin Loki**, Grafana ya
muestra tasa de `error`/`warn` por subsistema y dispara alertas ("errores de `recording` en
aumento"). **Coste RAM ≈ 0.** No reemplaza la búsqueda de líneas concretas — para eso está el
API `/api/v1/logs` y `journalctl` — pero cubre el 80% del valor de alerting.

### 3.3 Opción B — Grafana Loki + agente (Promtail/**Alloy**)

Almacén de logs consultable desde Grafana (panel "logs recientes por app", correlación con
métricas). El agente **recomendado es Grafana Alloy** (sucesor de Promtail: un solo binario,
lee archivos **y** journald/docker, menor huella) leyendo:

- **(a) archivos del core**: glob `$DATA_DIR/logs/streamhub*.log` (pino JSON → parse directo,
  labels `source`, `level`, `appId`).
- **(b) journald/docker**: unidades `streamhub-core`, `livekit`, y contenedores
  `ingress`/`egress`/`redis`.

**Presupuesto RAM (crítico en 8 GB):** Loki single-binary (boltdb-shipper + filesystem)
ronda **300–500 MB** con ingesta real; Alloy **50–100 MB**. Sumado a Prometheus+Grafana
(§4.6) compite directamente con el headroom de Chrome/egress. **Chunks en S3** (reusar el
bucket ya configurado) mantiene el disco local chico; **retención 30 días** alinea con el
objetivo de retención de logs de la app.

### 3.4 Recomendación (nodo de 8 GB, RAM-bound)

- **Fase 1 (ahora, sin más RAM): Opción A.** Nada de Loki. `streamhub_log_events_total` +
  `GET /api/v1/logs` + `journalctl`/`docker logs` para forense puntual. Cierra además el gap
  de retención con un **job de purga 30 días de `server_logs`** en el core (hoy inexistente).
- **Fase 2 (cuando haya headroom o exista nodo de observabilidad aparte): Opción B.** Loki +
  Alloy, retención 30 días, chunks en S3. Idealmente **no en `your-server`** sino en el nodo de
  observabilidad (§4.1) — encaja con el diseño origin+edge (Prometheus/Loki central scrapea
  todos los nodos).

---

## 4. Stack de despliegue propuesto

### 4.1 Topología — mismo nodo vs nodo aparte

| Escenario | Dónde corre la observabilidad | Cuándo |
|---|---|---|
| **Fase 1 — un nodo** | Prometheus + Grafana + node_exporter **en `your-server`**, todo bindeado a `127.0.0.1`, expuesto vía nginx (subdominio/subpath con auth). Retención Prometheus ajustada (15 días). | Ahora. Cabe en 8 GB si se vigila (§4.6). |
| **Fase 2+ — nodo de observabilidad** | VM chica (2 GB) dedicada: Prometheus + Grafana + Loki. Scrapea `your-server` y futuros edges por su IP privada. | Al agregar Loki o el 2º nodo. Libera RAM de `your-server` y es el patrón de cluster.md. |

Convención: **compose separado** para no mezclar el ciclo de vida del media stack con el de
la observabilidad. Propuesta de ubicación en el repo (no crear aún):
`streamhub-core/deploy/observability/` con `docker-compose.observability.yml`,
`prometheus.yml` (extiende el actual), `alerts.yml`, `alloy.river` (fase 2) y
`grafana/dashboards/`.

### 4.2 `docker-compose.observability.yml` (fase 1, mismo nodo)

```yaml
# streamhub-core/deploy/observability/docker-compose.observability.yml
# Levantar aparte del media stack:
#   docker compose -f deploy/observability/docker-compose.observability.yml up -d
# Todo escucha en 127.0.0.1; nginx publica Grafana con auth. network_mode: host
# para scrapear los servicios nativos (core :3020, livekit :6789) por localhost.
services:
  prometheus:
    image: prom/prometheus:latest
    container_name: streamhub-prometheus
    network_mode: host
    restart: unless-stopped
    command:
      - --config.file=/etc/prometheus/prometheus.yml
      - --storage.tsdb.retention.time=15d      # Fase 1: 15d en 8 GB. Objetivo 30d fuera del nodo.
      - --storage.tsdb.retention.size=4GB
      - --web.listen-address=127.0.0.1:9090
    volumes:
      - ./prometheus.yml:/etc/prometheus/prometheus.yml:ro
      - ./alerts.yml:/etc/prometheus/alerts.yml:ro
      - prom_data:/prometheus

  node-exporter:
    image: prom/node-exporter:latest
    container_name: streamhub-node-exporter
    network_mode: host
    restart: unless-stopped
    pid: host
    command:
      - --path.rootfs=/host
      - --web.listen-address=127.0.0.1:9100
      - --collector.systemd            # estado de unidades (streamhub-core, livekit)
      - --collector.textfile.directory=/var/lib/node_exporter/textfile   # cert expiry (§6)
    volumes:
      - /:/host:ro,rslave

  grafana:
    image: grafana/grafana:latest
    container_name: streamhub-grafana
    network_mode: host
    restart: unless-stopped
    environment:
      GF_SERVER_HTTP_ADDR: 127.0.0.1
      GF_SERVER_HTTP_PORT: "3001"          # 3000 lo puede usar otro; publicá vía nginx
      GF_SERVER_ROOT_URL: https://obs.streamhub.example.com/
      GF_SECURITY_ADMIN_PASSWORD: __CHANGE_ME__
    volumes:
      - grafana_data:/var/lib/grafana
      - ./grafana/provisioning:/etc/grafana/provisioning:ro
      - ./grafana/dashboards:/var/lib/grafana/dashboards:ro

volumes:
  prom_data:
  grafana_data:
```

> Fase 2 añade a este compose los servicios `loki` (chunks en S3, retención 30d) y `alloy`
> (lee `$DATA_DIR/logs/streamhub*.log` + journald). Se omiten aquí para no gastar RAM antes de
> tiempo.

### 4.3 Habilitar métricas nativas de LiveKit / ingress / egress

Hoy **no** están habilitadas (§1.2). En `docker-compose.yml`, dentro de cada
`*_CONFIG_BODY`, agregar `prometheus_port`:

```yaml
# livekit (LIVEKIT_CONFIG_BODY)
prometheus_port: 6789     # → GET http://127.0.0.1:6789/metrics

# ingress (INGRESS_CONFIG_BODY)
prometheus_port: 6790

# egress (EGRESS_CONFIG_BODY)
prometheus_port: 6791
```

> `v1.8.4` ya soporta `prometheus_port`. El brief mencionaba `v1.13`: si se quiere el set de
> métricas más reciente (histogramas de RTT/forward-latency más ricos), **subir el pin** de
> la imagen es un cambio aparte y menor, pero verificá el `CONFIG_BODY` contra el changelog.
> Mantené los puertos **bindeados a localhost** (no abrir en el firewall).

### 4.4 Scrape config (extiende `deploy/prometheus.yml`)

El [`deploy/prometheus.yml`](../../streamhub-core/deploy/prometheus.yml) actual ya trae los
jobs `streamhub-core`, `livekit`, `node`, `prometheus`. Ajustes para este roadmap: **activar
el token del core**, apuntar todo a `127.0.0.1` (servicios nativos), agregar ingress/egress y
las reglas de alerta.

```yaml
global:
  scrape_interval: 15s
  evaluation_interval: 15s
  external_labels: { stack: streamhub, node: your-server }

rule_files:
  - /etc/prometheus/alerts.yml

scrape_configs:
  - job_name: streamhub-core
    metrics_path: /metrics
    authorization:                     # METRICS_TOKEN está seteado (mtk_… en install.sh)
      type: Bearer
      credentials: "REEMPLAZAR_CON_METRICS_TOKEN"
    static_configs:
      - targets: ["127.0.0.1:3020"]
        labels: { service: streamhub-core }

  - job_name: livekit                  # requiere §4.3
    static_configs:
      - targets: ["127.0.0.1:6789"]
        labels: { service: livekit }

  - job_name: livekit-ingress
    static_configs:
      - targets: ["127.0.0.1:6790"]
        labels: { service: ingress }

  - job_name: livekit-egress
    static_configs:
      - targets: ["127.0.0.1:6791"]
        labels: { service: egress }

  - job_name: node
    static_configs:
      - targets: ["127.0.0.1:9100"]
        labels: { service: host }

  - job_name: prometheus
    static_configs:
      - targets: ["127.0.0.1:9090"]
```

### 4.5 node_exporter — por qué es imprescindible

`process_*`/`nodejs_*` sólo miden el **proceso Node del core**. El techo del nodo es la
**RAM del host** (Chrome/egress), que node_exporter expone: `node_memory_MemAvailable_bytes`,
`node_memory_SwapFree_bytes`, `node_cpu_seconds_total`, `node_filesystem_avail_bytes`,
`node_network_*_bytes_total`, `node_load1`. Es el corazón del tablero "Server global" y de las
alertas de RAM/disco/swap. Ver comando en §4.2 (bindeado a `127.0.0.1:9100`).

### 4.6 Retención y presupuesto de recursos

| Componente | RAM aprox. | Disco | Retención |
|---|---|---|---|
| Prometheus | 150–300 MB | 2–4 GB (TSDB, volumen de métricas bajo) | **15 d** en nodo; **30 d** al mover fuera |
| Grafana | 80–150 MB | chico | — |
| node_exporter | ~20 MB | — | — |
| **Subtotal fase 1** | **~250–470 MB** | ~4 GB | — |
| Loki + Alloy (fase 2) | +350–600 MB | chunks en **S3** | **30 d** (alinea con retención de logs de la app) |

Fase 1 cabe en 8 GB **si se vigila** contra el headroom de egress: bindear todo a localhost,
`retention.size=4GB` como tope duro, y priorizar mover Loki a nodo aparte. Retención objetivo
**30 días** para logs y métricas se alcanza plenamente al llevar la observabilidad a la VM
dedicada (§4.1).

---

## 5. Tableros Grafana propuestos

Tres tableros. Usar **variable de plantilla** `$app = label_values(streamhub_active_streams, app)`
para el per-app, y `$node` cuando exista cluster.

### 5.A — Server global (salud del nodo y del servicio)

| Panel | Query (PromQL) |
|---|---|
| CPU host | `100 - avg(rate(node_cpu_seconds_total{mode="idle"}[5m]))*100` |
| RAM host (usada %) | `(1 - node_memory_MemAvailable_bytes/node_memory_MemTotal_bytes)*100` |
| Swap usado | `node_memory_SwapTotal_bytes - node_memory_SwapFree_bytes` |
| Disco `DATA_DIR` libre % | `node_filesystem_avail_bytes{mountpoint="/"} / node_filesystem_size_bytes{mountpoint="/"} * 100` |
| Red in/out | `rate(node_network_receive_bytes_total[5m])`, `..._transmit_...` |
| Streams activos (total) | `sum(streamhub_active_streams)` |
| Viewers totales | `sum(streamhub_viewers)` |
| Grabaciones/egress activas | `sum(streamhub_active_recordings)` / `sum(streamhub_media_sessions_active{kind="egress"})` |
| Rooms / participantes (LiveKit) | `livekit_room_total`, `livekit_participant_total` |
| Request rate & p95 | `sum by (route,status)(rate(streamhub_http_requests_total[5m]))` · `histogram_quantile(0.95, sum by (le,route)(rate(streamhub_http_request_duration_seconds_bucket[5m])))` |
| Errores 5xx / tasa | `sum(rate(streamhub_errors_total[5m]))` |
| Errores por subsistema (log→métrica) | `sum by (source)(rate(streamhub_log_events_total{level=~"error|fatal"}[15m]))` |
| Backlog de subida VOD | `sum(streamhub_upload_queue_depth)` |
| Core / LiveKit up | `up{job=~"streamhub-core|livekit"}` |
| Event-loop lag del core | `nodejs_eventloop_lag_seconds` |
| GPU disponible | `streamhub_gpu_available` |

### 5.B — Per-app (variable `$app`)

| Panel | Query |
|---|---|
| Viewers en el tiempo | `streamhub_viewers{app="$app"}` |
| Streams activos | `streamhub_active_streams{app="$app"}` |
| Ingest por protocolo | `sum by (protocol)(rate(streamhub_bytes_ingest_total{app="$app"}[5m]))` *(fase 2)* |
| Eventos de stream | `sum by (event)(rate(streamhub_stream_events_total{app="$app"}[15m]))` |
| Grabaciones iniciadas / fallidas | `rate(streamhub_recordings_started_total{app="$app"}[15m])` · `rate(streamhub_recording_failures_total{app="$app"}[15m])` |
| VODs por estado | `streamhub_vods{app="$app"}` |
| Storage S3 (bytes / objetos) | `streamhub_storage_vod_bytes{app="$app"}` · `streamhub_storage_vod_count{app="$app"}` |
| Callbacks fallidos por evento | `sum by (event)(rate(streamhub_callbacks_total{app="$app",result="failed"}[15m]))` |
| Uso vs quota (tenant) | `streamhub_tenant_usage / streamhub_tenant_quota` |
| Logs recientes | *(fase 2, Loki)* `{service="streamhub-core"} | json | appId="…"` |

### 5.C — Media / latencia (métricas nativas LiveKit — requiere §4.3)

Nombres verificados contra la referencia de LiveKit; **varían por versión**, confirmá en el
endpoint vivo.

| Panel | Query / métrica |
|---|---|
| RTT p50/p95 | `histogram_quantile(0.95, sum by (le,direction)(rate(livekit_rtt_ms_bucket[5m])))` — `livekit_rtt_ms{direction,source,type}` |
| Forward latency | `histogram_quantile(0.95, rate(livekit_forward_latency_bucket[5m]))` |
| Packet loss (aprox.) | `rate(livekit_packet_total{transmission="lost"}[5m]) / rate(livekit_packet_total[5m])` — `livekit_packet_total{direction,transmission}` |
| NACK / PLI (retransmisión) | `rate(livekit_nack_total[5m])`, `rate(livekit_pli_total[5m])` (label `direction`) |
| Rooms / duración de sesión | `livekit_room_total`, `livekit_room_duration_seconds`, `livekit_session_start_time_ms` |
| Participantes | `livekit_participant_total` |
| CPU/carga del nodo LiveKit | métricas de nodo de LiveKit (CpuLoad/MemoryUsed) + node_exporter |
| Egress/ingress activos | de los jobs `livekit-egress` / `livekit-ingress` |

> Simulcast/capas espaciales por versión no siempre se exponen como serie Prometheus estable;
> si se necesita granularidad de capa, complementarlo con la Analytics API de LiveKit. Como
> base, importar un **dashboard community de LiveKit** y recortarlo.

---

## 6. Alerting mínimo viable

Reglas Prometheus (`alerts.yml`, referenciado en §4.4). Notificación vía Alertmanager o
alertas nativas de Grafana. Umbrales pensados para un nodo de 8 GB RAM-bound.

```yaml
groups:
  - name: streamhub-node
    rules:
      - alert: HostMemoryHigh
        expr: (1 - node_memory_MemAvailable_bytes/node_memory_MemTotal_bytes) > 0.85
        for: 5m
        labels: { severity: critical }
        annotations: { summary: "RAM del host >85% (riesgo para egress/Chrome)" }

      - alert: HostSwapThrash
        expr: (node_memory_SwapTotal_bytes - node_memory_SwapFree_bytes) > 2e9
        for: 10m
        labels: { severity: warning }
        annotations: { summary: "Swap >2 GB en uso — presión de RAM sostenida" }

      - alert: HostDiskLow
        expr: node_filesystem_avail_bytes{mountpoint="/"} / node_filesystem_size_bytes{mountpoint="/"} < 0.10
        for: 10m
        labels: { severity: critical }
        annotations: { summary: "Disco del host <10% libre" }

  - name: streamhub-service
    rules:
      - alert: CoreDown
        expr: up{job="streamhub-core"} == 0
        for: 2m
        labels: { severity: critical }
        annotations: { summary: "streamhub-core no responde a /metrics" }

      - alert: LiveKitDown
        expr: up{job="livekit"} == 0
        for: 2m
        labels: { severity: critical }

      - alert: EgressEndpointDown
        expr: streamhub_media_endpoint_up{kind="egress"} == 0
        for: 5m
        labels: { severity: warning }
        annotations: { summary: "egress inalcanzable — grabaciones fallarán" }

      - alert: RecordingFailures
        expr: rate(streamhub_recording_failures_total[15m]) > 0
        for: 15m
        labels: { severity: warning }

      - alert: UploadBacklogStuck
        expr: sum(streamhub_upload_queue_depth) > 5
        for: 30m
        labels: { severity: warning }
        annotations: { summary: "VODs sin subir acumulándose" }

      - alert: CallbacksFailing
        expr: sum(rate(streamhub_callbacks_total{result="failed"}[15m])) > 0.2
        for: 15m
        labels: { severity: warning }

      - alert: ErrorLogSpike
        expr: sum by (source)(rate(streamhub_log_events_total{level=~"error|fatal"}[10m])) > 1
        for: 10m
        labels: { severity: warning }
        annotations: { summary: "Errores en subsistema {{ $labels.source }}" }

      - alert: TlsCertExpiringSoon        # requiere textfile collector con certbot (§4.5)
        expr: (node_cert_not_after_seconds - time()) < 14*24*3600
        labels: { severity: warning }
        annotations: { summary: "Certificado TLS vence en <14 días" }
```

> **Cert expiry**: el más simple es un hook de renovación certbot que escribe
> `node_cert_not_after_seconds <epoch>` en el directorio textfile de node_exporter; alternativa
> más completa es `blackbox_exporter` sondeando `https://<dominio>` (`probe_ssl_earliest_cert_expiry`).

---

## 7. Roadmap por fases

| Fase | Objetivo | Entregables | Esfuerzo | Requiere más RAM |
|---|---|---|---|---|
| **0 (hecho)** | Instrumentación base | `/metrics` + catálogo + `deploy/prometheus.yml` | — | No |
| **1** | **Tablero operativo en `your-server`** | Prometheus+Grafana+node_exporter (compose §4.2, localhost+nginx, 15d); habilitar `prometheus_port` en livekit/ingress/egress (§4.3); token en scrape (§4.4); métricas core fase 1 (§2: build_info, viewers{app}, active_recordings, media_endpoint/sessions, storage_*, disk, **log_events_total**); dashboards A y C base + community LiveKit; alertas host/target/recording (§6); job de purga 30d de `server_logs` | **~1–2 días** (config + ~200 líneas de core) | **No** (cabe, §4.6) |
| **2** | **Tablero per-app completo + logs** | Métricas fase 2 (§2: bytes_ingest/egress por app, recording_duration); dashboard B completo; **Loki + Alloy** (retención 30d, chunks en S3) para "logs recientes por app"; alertas basadas en logs; evaluar **mover la observabilidad a nodo aparte** | **~3–5 días** | Sí (Loki) — preferible fuera de `your-server` |
| **3** | **Cluster / avanzado** | Prometheus central scrapeando todos los nodos (origin+edge, cluster.md); ingest latency histogram, `s3_bucket_bytes`; Alertmanager con routing; dashboards por-nodo + agregado cluster; opcional exemplars/tracing | **~1–2 semanas** | Depende del cluster |

**Fase 1 es autocontenida y realizable en el nodo actual sin más RAM** — es el 80% del valor
(salud del host + del servicio + por-app básico + alertas), y deja el terreno listo para Loki
y multi-nodo sin retrabajo.

---

## Referencias

- [OBSERVABILITY.md](./OBSERVABILITY.md) — endpoint `/metrics`, catálogo actual, Grafana next.
- [`../../streamhub-core/deploy/OBSERVABILITY.md`](../../streamhub-core/deploy/OBSERVABILITY.md) · [`prometheus.yml`](../../streamhub-core/deploy/prometheus.yml) — assets de despliegue.
- [RUNBOOK.md](./RUNBOOK.md) — day-2, `/stats`, `/metrics`, db-admin. · [ENV.md](./ENV.md) — `METRICS_TOKEN`, `LOG_MAX_*`, `DATA_DIR`.
- [../architecture/cluster.md](../architecture/cluster.md) — observabilidad multi-nodo.
- LiveKit self-hosting / Prometheus: https://docs.livekit.io/home/self-hosting/deployment/ · métricas: https://deepwiki.com/livekit/livekit/8.5-prometheus-metrics
- Grafana Loki: https://grafana.com/docs/loki/ · Alloy: https://grafana.com/docs/alloy/
