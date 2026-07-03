# Observability — StreamHub media stack

streamhub-core ships first-class **Prometheus** instrumentation. This doc covers:

1. The `/metrics` endpoint and what it exposes.
2. Enabling **LiveKit's native** Prometheus metrics.
3. Standing up Prometheus (with the provided `deploy/prometheus.yml`).
4. Adding Grafana on top.

---

## 1. streamhub-core `/metrics`

- **Endpoint:** `GET /metrics` — served at the **root path** (deliberately NOT
  under the `api/v1` prefix, to match the ecosystem convention).
- **Format:** Prometheus text exposition (`text/plain; version=0.0.4`).
- **Auth:** public by default (it carries no secrets). Set `METRICS_TOKEN` to
  require `Authorization: Bearer <token>` (or `?token=<token>`). The route is
  marked `@Public()` so it bypasses the app Bearer/API-token auth guard.
- **Toggle Node/process metrics:** `METRICS_DEFAULT_METRICS=off` disables the
  `process_*` / `nodejs_*` default collectors.

Quick check:

```bash
curl -s http://127.0.0.1:3020/metrics | grep streamhub_
# with a token:
curl -s -H "Authorization: Bearer $METRICS_TOKEN" http://127.0.0.1:3020/metrics
```

### Metrics exposed by streamhub-core

All app metrics are prefixed `streamhub_`. DB-derived gauges are recomputed from
SQLite on every scrape, so they always match the source of truth.

**HTTP (from a global interceptor)**

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `streamhub_http_requests_total` | counter | `method`, `route`, `status` | Requests handled. `route` is the matched pattern (e.g. `/apps/:app/streams/:id`), never the concrete URL, so cardinality stays bounded; unmatched requests → `unmatched`. |
| `streamhub_http_request_duration_seconds` | histogram | `method`, `route`, `status` | Request latency. |
| `streamhub_http_requests_in_flight` | gauge | – | In-progress requests. |

**Streams**

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `streamhub_active_streams` | gauge | `app` | Live streams per app (from the per-app `streams` table). |
| `streamhub_stream_viewers` | gauge | `app`, `room` | Last observed subscriber/viewer count (when the app enables the viewer counter). |
| `streamhub_stream_events_total` | counter | `app`, `event` | Lifecycle events: `stopped`, `snapshot`. |

**Recording / VODs**

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `streamhub_recordings_started_total` | counter | `app` | Recording sessions started. |
| `streamhub_vods_generated_total` | counter | `app` | VODs uploaded + marked `ready`. |
| `streamhub_recording_failures_total` | counter | `app`, `reason` | Recording/upload failures. |
| `streamhub_upload_queue_depth` | gauge | `app` | VODs pending upload (`recording`+`uploading`). |
| `streamhub_vods` | gauge | `app`, `status` | VOD rows by status (`recording`/`uploading`/`ready`/`failed`). |

**S3 / egress upload**

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `streamhub_s3_uploads_total` | counter | `provider`, `result` | Uploads, `result` = `ok`\|`fail`. |
| `streamhub_s3_upload_bytes_total` | counter | `provider` | Bytes uploaded to S3. |
| `streamhub_s3_errors_total` | counter | `op` | S3 op errors (`upload`/`presign`/`delete`/`exists`). |

**Callbacks (outbound app webhooks)**

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `streamhub_callbacks_total` | counter | `app`, `event`, `result` | Deliveries, `result` = `delivered`\|`failed`\|`dropped`. |

**Tenancy / quotas**

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `streamhub_apps` | gauge | `tenant` | Registered apps per tenant. |
| `streamhub_tenant_quota` | gauge | `tenant`, `metric` | Configured quota per tenant (`maxApps`, `maxConcurrentStreams`, `maxRecordingMinutesMonth`, `maxEgressGbMonth`, `maxStorageGb`; `-1` = unlimited). |
| `streamhub_tenant_usage` | gauge | `tenant`, `metric` | Current usage per tenant (`apps`, `concurrentStreams`, `recordingMinutesMonth`, `egressGbMonth`, `storageGb`). |

**Errors**

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `streamhub_errors_total` | counter | `source`, `code` | Errors surfaced to clients (e.g. `source=http`, `code=500`). |

**Transcoding / GPU** (see `deploy/GPU.md`)

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `streamhub_media_transcode_total` | counter | `kind`, `accel`, `type` | Media ops by `kind` (`egress`\|`ingress`), `accel` (`gpu`\|`cpu`) and GPU `type` (`nvidia`\|`vaapi`\|`none`). Tells you whether the last egress/ingress used GPU vs CPU. |
| `streamhub_gpu_available` | gauge | `type` | `1` on the active `type` when a usable GPU is detected on the node, else `type="none"` = `1`. |

**Plus** the default `process_*` / `nodejs_*` collectors (CPU, RSS/heap,
event-loop lag, GC, handles) unless disabled.

---

## 2. LiveKit native Prometheus metrics

LiveKit exports its OWN Prometheus metrics (rooms, participants, tracks, packet
loss, egress/ingress, CPU) — you do NOT proxy them through streamhub-core.
Enable the exporter in `livekit.yaml`:

```yaml
# livekit.yaml
port: 7880
prometheus_port: 6789   # <-- enables GET http://<livekit>:6789/metrics
rtc:
  tcp_port: 7881
  # ...
keys:
  APIKey: APISecret
```

Then scrape `http://<livekit-host>:6789/metrics` (job `livekit` in the sample
config). If you run egress/ingress as separate services, they expose their own
metrics the same way — add `prometheus_port` to their configs and a scrape job.

Docs: https://docs.livekit.io/home/self-hosting/deployment/#Prometheus

---

## 3. Prometheus

A ready-to-edit config is at [`deploy/prometheus.yml`](./prometheus.yml). It
scrapes streamhub-core `/metrics`, LiveKit `:6789`, and (optionally)
node_exporter. Adjust the `targets` to your hostnames/ports and, if you set
`METRICS_TOKEN`, uncomment the `authorization:` block under the streamhub-core
job.

Run it with Docker:

```bash
docker run -d --name prometheus \
  -p 9090:9090 \
  -v "$PWD/deploy/prometheus.yml:/etc/prometheus/prometheus.yml:ro" \
  prom/prometheus

# host metrics (optional):
docker run -d --name node-exporter -p 9100:9100 prom/node-exporter
```

Or as a compose service:

```yaml
services:
  prometheus:
    image: prom/prometheus
    ports: ["9090:9090"]
    volumes:
      - ./deploy/prometheus.yml:/etc/prometheus/prometheus.yml:ro
    restart: unless-stopped
```

If streamhub-core / LiveKit run in the same compose network, the service names
(`streamhub-core`, `livekit`) resolve directly as scrape targets. For a
host/systemd deploy, use `127.0.0.1:3020` and `127.0.0.1:6789` and keep the
`/metrics` port bound to localhost (Prometheus scrapes locally).

Verify targets at `http://<host>:9090/targets` — all jobs should be `UP`.

---

## 4. Grafana (next)

```yaml
  grafana:
    image: grafana/grafana
    ports: ["3000:3000"]
    restart: unless-stopped
```

1. Open `http://<host>:3000` (default `admin`/`admin`).
2. Add a **Prometheus** data source → URL `http://prometheus:9090` (compose) or
   `http://127.0.0.1:9090`.
3. Build panels / import dashboards, e.g.:
   - **Active streams:** `sum(streamhub_active_streams)` and by app
     `streamhub_active_streams`.
   - **Request rate:** `sum by (route,status) (rate(streamhub_http_requests_total[5m]))`.
   - **p95 latency:** `histogram_quantile(0.95, sum by (le,route) (rate(streamhub_http_request_duration_seconds_bucket[5m])))`.
   - **Upload success rate:** `sum(rate(streamhub_s3_uploads_total{result="ok"}[5m])) / sum(rate(streamhub_s3_uploads_total[5m]))`.
   - **VOD backlog:** `sum(streamhub_upload_queue_depth)`.
   - **Callback failures:** `sum by (event) (rate(streamhub_callbacks_total{result="failed"}[5m]))`.
   - **Tenant usage vs quota:** `streamhub_tenant_usage` / `streamhub_tenant_quota`.
   - For LiveKit, import a community LiveKit dashboard or chart
     `livekit_room_total`, `livekit_participant_total`, etc.

Recommended alerts: streamhub-core target down, `streamhub_upload_queue_depth`
sustained high, `rate(streamhub_recording_failures_total[15m]) > 0`,
`rate(streamhub_callbacks_total{result="failed"}[15m])` high.
