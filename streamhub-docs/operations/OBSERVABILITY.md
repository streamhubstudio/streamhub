# Operations — Observability

streamhub-core ships first-class **Prometheus** instrumentation. This is the operator-facing
summary; the exhaustive metric catalog lives in
[`streamhub-core/deploy/OBSERVABILITY.md`](../../streamhub-core/deploy/OBSERVABILITY.md), and
a ready-to-edit scrape config in [`streamhub-core/deploy/prometheus.yml`](../../streamhub-core/deploy/prometheus.yml).

## 1. streamhub-core `/metrics`

- **Endpoint:** `GET /metrics` at the **root path** (deliberately not under `/api/v1`).
- **Format:** Prometheus text exposition.
- **Auth:** public by default (carries no secrets). Set `METRICS_TOKEN` to require
  `Authorization: Bearer <token>` (or `?token=`). Toggle Node/process collectors with
  `METRICS_DEFAULT_METRICS=off`.

```bash
curl -s http://127.0.0.1:3020/metrics | grep streamhub_
```

DB-derived gauges are recomputed from SQLite on every scrape, so they always match the
source of truth.

### What's exposed (all prefixed `streamhub_`)

| Area | Key metrics |
|---|---|
| **HTTP** | `streamhub_http_requests_total{method,route,status}`, `streamhub_http_request_duration_seconds` (histogram), `streamhub_http_requests_in_flight`. `route` is the matched **pattern** (bounded cardinality; unmatched → `unmatched`). |
| **Streams** | `streamhub_active_streams{app}`, `streamhub_stream_viewers{app,room}`, `streamhub_stream_events_total{app,event}`. |
| **Recording / VODs** | `streamhub_recordings_started_total{app}`, `streamhub_vods_generated_total{app}`, `streamhub_recording_failures_total{app,reason}`, `streamhub_upload_queue_depth{app}`, `streamhub_vods{app,status}`. |
| **S3 / egress upload** | `streamhub_s3_uploads_total{provider,result}`, `streamhub_s3_upload_bytes_total{provider}`, `streamhub_s3_errors_total{op}`. |
| **Callbacks** | `streamhub_callbacks_total{app,event,result}` (`delivered`\|`failed`\|`dropped`). |
| **Tenancy / quotas** | `streamhub_apps{tenant}`, `streamhub_tenant_quota{tenant,metric}`, `streamhub_tenant_usage{tenant,metric}`. |
| **Transcoding / GPU** | `streamhub_media_transcode_total{kind,accel,type}`, `streamhub_gpu_available{type}` (see `streamhub-core/deploy/GPU.md`). |
| **Errors** | `streamhub_errors_total{source,code}`. |
| **Process** | default `process_*` / `nodejs_*` (CPU, RSS/heap, event-loop lag, GC, handles) unless disabled. |

## 2. LiveKit native metrics

LiveKit exports its own Prometheus metrics (rooms, participants, tracks, packet loss,
egress/ingress, CPU) — **do not** proxy them through core. Enable in `livekit.yaml`:

```yaml
port: 7880
prometheus_port: 6789   # → GET http://<livekit>:6789/metrics
```

Ingress/egress run as separate services and expose their own metrics the same way (add a
`prometheus_port` + scrape job each).

## 3. Prometheus

Use [`streamhub-core/deploy/prometheus.yml`](../../streamhub-core/deploy/prometheus.yml)
(scrapes core `/metrics`, LiveKit `:6789`, and optionally node_exporter). Adjust targets to
your hosts; if `METRICS_TOKEN` is set, uncomment the `authorization:` block on the core job.

```bash
docker run -d --name prometheus -p 9090:9090 \
  -v "$PWD/streamhub-core/deploy/prometheus.yml:/etc/prometheus/prometheus.yml:ro" \
  prom/prometheus
```

For a host/systemd deploy scrape `127.0.0.1:3020` and `127.0.0.1:6789` and keep the metrics
port bound to localhost. Confirm all jobs are `UP` at `http://<host>:9090/targets`.

## 4. Grafana (next)

Add a Grafana container, point it at Prometheus, and build panels. Useful queries:

- Active streams: `sum(streamhub_active_streams)`
- Request rate: `sum by (route,status) (rate(streamhub_http_requests_total[5m]))`
- p95 latency: `histogram_quantile(0.95, sum by (le,route) (rate(streamhub_http_request_duration_seconds_bucket[5m])))`
- Upload success: `sum(rate(streamhub_s3_uploads_total{result="ok"}[5m])) / sum(rate(streamhub_s3_uploads_total[5m]))`
- VOD backlog: `sum(streamhub_upload_queue_depth)`
- Callback failures: `sum by (event) (rate(streamhub_callbacks_total{result="failed"}[5m]))`
- Tenant usage vs quota: `streamhub_tenant_usage / streamhub_tenant_quota`

**Recommended alerts:** core target down; `streamhub_upload_queue_depth` sustained high;
`rate(streamhub_recording_failures_total[15m]) > 0`; high
`rate(streamhub_callbacks_total{result="failed"}[15m])`; per-node CPU/bandwidth (cluster).

## Logs

Structured pino logs go to stdout (`docker compose logs -f core` / `journalctl -u
streamhub-core`), a rotating file under `<DATA_DIR>/logs/` (`LOG_MAX_BYTES`/`LOG_MAX_FILES`),
and the `server_logs` table — queryable via `GET /api/v1/logs` (filter by app/level/date).
