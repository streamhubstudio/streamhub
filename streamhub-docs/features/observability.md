# Observability (metrics, health, stats, logs)

## What it does

Prometheus metrics, a liveness probe, an authenticated server-stats endpoint,
and a structured, queryable log store.

## Prometheus /metrics

`prom-client` exposition at the **root** path `/metrics` (excluded from the
`/api/v1` prefix, per Prometheus convention). `@Public()` — no Bearer needed;
if `METRICS_TOKEN` is set, a `Bearer <token>` header **or** `?token=` is required.
Content-Type `text/plain; version=0.0.4`, `no-store`.

### Exported metric families (prefix `streamhub_`)

| Metric | Type | Notes |
|--------|------|-------|
| `streamhub_http_requests_total` | counter | HTTP requests handled |
| `streamhub_http_request_duration_seconds` | histogram | request latency |
| `streamhub_http_requests_in_flight` | gauge | concurrent requests |
| `streamhub_active_streams` | gauge | active live streams, by app |
| `streamhub_stream_viewers` | gauge | last observed viewer count per stream |
| `streamhub_stream_events_total` | counter | stream lifecycle (stop, snapshot) |
| `streamhub_recordings_started_total` | counter | recordings started |
| `streamhub_vods_generated_total` | counter | VODs uploaded + ready |
| `streamhub_recording_failures_total` | counter | recording/upload failures, by reason |
| `streamhub_upload_queue_depth` | gauge | VODs pending upload, by app |
| `streamhub_vods` | gauge | VOD rows by status, by app |
| `streamhub_s3_uploads_total` | counter | S3 uploads, by provider+result |
| `streamhub_s3_upload_bytes_total` | counter | bytes uploaded, by provider |
| `streamhub_s3_errors_total` | counter | S3 errors, by op |
| `streamhub_callbacks_total` | counter | outbound callbacks, by event+result |
| `streamhub_tenant_quota` | gauge | configured quota per tenant+metric |
| `streamhub_tenant_usage` | gauge | current usage per tenant+metric |
| `streamhub_apps` | gauge | registered apps, by tenant |
| `streamhub_errors_total` | counter | client-surfaced errors, by source+code |
| `streamhub_media_transcode_total` | counter | egress/ingress ops, by accel+GPU type |
| `streamhub_gpu_available` | gauge | usable GPU present (1/0), by type |

LiveKit also exposes native Prometheus metrics; scrape both. Grafana/alerts are
downstream.

## Health & stats

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/api/v1/health` | public | Liveness: `{ status, up, version, ts, uptimeSeconds }` |
| GET | `/api/v1/stats` | Bearer | Server stats |
| GET | `/metrics` | public (+ optional METRICS_TOKEN) | Prometheus scrape |

### GET /api/v1/stats — StatsResponse

```json
{
  "ts": "2026-06-30T12:00:00.000Z",
  "uptimeSeconds": 1234,
  "version": "0.1.0",
  "cpu": { "loadAvg": [0.5,0.4,0.3], "cores": 8 },
  "memory": { "totalBytes": 16777216000, "freeBytes": 8388608000, "usedBytes": 8388608000 },
  "disk": { "totalBytes": 500000000000, "freeBytes": 250000000000, "usedBytes": 250000000000 },
  "livekitReachable": true,
  "counts": { "apps": 3, "rooms": 2, "activeStreams": 4 },
  "egress": { "reachable": true, "active": 1, "total": 2 },
  "ingress": { "reachable": true, "active": 1, "total": 2 }
}
```

## Logs

Structured logger (pino) → console + rotating file (`logs/`) + `server_logs`
table. Queryable:

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/api/v1/logs?app&level&since&until&limit&offset` | Bearer | Filtered, paginated logs (newest first) |

Filters: `app`, `level` ∈ {trace,debug,info,warn,error,fatal}, `since`/`until`
(ISO-8601), `limit` 1..1000 (default 100), `offset` (default 0).

```json
{ "data": [ { "ts":"...", "level":"info", "source":"livekit-webhook",
              "app":"demo", "message":"event participant_joined", "meta":{...} } ],
  "total": 1234, "limit": 100, "offset": 0 }
```

## Examples

```bash
curl -s https://streamhub.example.com/api/v1/health
curl -s $BASE/stats -H "Authorization: Bearer $TOKEN"
curl -s "$BASE/logs?app=demo&level=error&limit=50" -H "Authorization: Bearer $TOKEN"
curl -s "https://streamhub.example.com/metrics?token=$METRICS_TOKEN"
```

## Notes

- `/health` is used by load balancers and the SPA; it never requires auth.
- Swagger/OpenAPI: UI at `/api/v1/docs`, JSON at `/api/v1/openapi.json`.
</content>
