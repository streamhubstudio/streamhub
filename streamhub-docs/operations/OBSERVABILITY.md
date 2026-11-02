# Operations — Observability

streamhub-core ships first-class **Prometheus** instrumentation. This is the operator-facing
summary; the exhaustive metric catalog lives in
[`deploy/OBSERVABILITY.md`](../../deploy/OBSERVABILITY.md), and
a ready-to-edit scrape config in [`deploy/prometheus.yml`](../../deploy/prometheus.yml).

## 1. streamhub-core `/metrics`

- **Endpoint:** `GET /metrics` at the **root path** (deliberately not under `/api/v1`).
- **Format:** Prometheus text exposition.
- **Auth: default-DENY.** With **no `METRICS_TOKEN` set the endpoint returns `404`** and
  exposes nothing (it does not even confirm it exists) — a fresh install never leaks metrics
  publicly. Set `METRICS_TOKEN` to enable it; scrapers then send `Authorization: Bearer <token>`
  (or `?token=`), and a wrong/absent token gets `403`. Toggle Node/process collectors with
  `METRICS_DEFAULT_METRICS=off`. The installer generates a `METRICS_TOKEN` automatically, so a
  standard install has `/metrics` enabled and locked from the start.

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
| **Transcoding / GPU** | `streamhub_media_transcode_total{kind,accel,type}`, `streamhub_gpu_available{type}` (see `deploy/GPU.md`). |
| **Cluster / edge (master-side)** | `streamhub_cluster_node_up{node,type}`, `streamhub_cluster_node_cpu_ratio{node}`, `streamhub_cluster_node_mem_used_ratio{node}`, `streamhub_cluster_node_disk_used_ratio{node}`, `streamhub_cluster_node_gpu{node}`, `streamhub_cluster_node_vram_free_mb{node}`, `streamhub_cluster_node_weight{node}`, `streamhub_edge_assignments{status}`, `streamhub_edge_pending_assignments`, `streamhub_edge_eligible_nodes{gpu}`. Exported **only by the master** (see §1c). |
| **Errors** | `streamhub_errors_total{source,code}`. |
| **Process** | default `process_*` / `go_*` (CPU, RSS, open fds, goroutines, GC, heap) unless disabled (`METRICS_DEFAULT_METRICS=off`). The 2.x core's `nodejs_*` series (incl. event-loop lag) no longer exist. |

## 1c. Edge nodes are monitored VIA THE MASTER

Edge/compute nodes join over the master's API and **dial the WS control channel outbound**;
they run **no public inbound plane** and typically sit behind NAT, so **Prometheus cannot
scrape them directly**. Instead every node's telemetry (cpu/mem/disk + GPU/VRAM/weight) is
already streamed to the master on each heartbeat and persisted to the global `nodes` table.
The master **re-exports it on its own `/metrics`** as the `streamhub_cluster_node_*` gauges
above, recomputed per scrape from `nodes` + `edge_assignments` (defensive: a garbage stats
blob degrades to absent series, never a failed scrape). `node` is the registry node **name**.

Net effect: **scrape only the master** and you get the whole fleet's per-node health plus the
scheduler's placement state (`streamhub_edge_assignments`, `_pending_assignments`,
`_eligible_nodes{gpu}`). The shipped **`Edge nodes`** Grafana dashboard
(`deploy/observability/grafana/dashboards/edge-nodes.json`) is built entirely on these gauges,
and the "no capacity" alerts (`alerts.cluster.yml`) read `streamhub_edge_pending_assignments`
+ `streamhub_edge_eligible_nodes{gpu="true"}`. The same conditions also fire a central
`cluster.capacity` log line — query it with `GET /api/v1/logs?source=edge` or
`streamhub cluster events`.

## 1b. In-app resource history (dashboard dot charts)

A **lightweight, dependency-free** history of host resource usage, built into the core and
the dashboard — the complement to the heavyweight Prometheus/Grafana path above. Use it for
an at-a-glance trend without standing up a metrics stack; use Prometheus when you need
high-resolution, alerting, or long retention.

- **Sampler:** an in-process cron job samples the host **once per hour** into a single
  table (`resource_samples`) in the global DB — CPU %, RAM used/total, Disk used/total (for
  the `DATA_DIR` filesystem) and cumulative Network rx/tx bytes. A boot **catch-up** run
  fires when the newest sample is older than ~70 min. Rows are keyed by the hour bucket, so
  the scheduled run and a catch-up in the same hour collapse to one row.
- **Retention:** rows older than `STREAMHUB_METRICS_HISTORY_RETENTION_DAYS` (default **30**)
  are pruned after every sample. Precision is fixed at 1 hour.
- **Source of truth:** CPU % is the average-over-the-hour derived from the delta of the
  cumulative `os.cpus()` idle/total times (loadavg fallback on the first sample). Network is
  stored cumulative and rendered as per-bucket **deltas** (clamped ≥0 across reboots). Disk
  uses `fs.statfsSync`.
- **Cross-platform:** degrades gracefully. On non-Linux hosts (e.g. a macOS dev box) the
  Network counters aren't available and store `null` (the chart shows a gap); disk falls back
  to `null` where `statfs` is unsupported. CPU/RAM work everywhere.

**Endpoint:** `GET /api/v1/system/metrics/history` — **global-scope (superadmin)** surface,
same gate as `/system/settings` and `/system/backups` (app-scoped tokens get `403`).

| Query param | Values | Default | Meaning |
|---|---|---|---|
| `range` | `24h` \| `7d` \| `30d` \| `90d` | `30d` | Time window. |
| `metric` | `cpu` \| `mem` \| `disk` \| `net` | *(all)* | Narrow to one series. |

Returns `{ range, retentionDays, now, bucketMs, series }`, where each series is an array of
time-bucketed points ready for a scatter/dot plot (`cpu`/`disk`: `{ts, value}`; `mem`:
`{ts, used, total, pct}`; `net`: `{ts, rx, tx}` deltas).

**Dashboard:** the sidebar's **Resource history** (superadmin-only) renders four hand-rolled
SVG dot charts (CPU / RAM / Network / Disk) over a selectable window (default 30d) — no chart
library, theme-aware light/dark.

```bash
curl -s -H "Authorization: Bearer $SK_GLOBAL" \
  'http://127.0.0.1:3020/api/v1/system/metrics/history?range=7d&metric=cpu'
```

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

Use [`deploy/prometheus.yml`](../../deploy/prometheus.yml)
(scrapes core `/metrics`, LiveKit `:6789`, and optionally node_exporter). Adjust targets to
your hosts; if `METRICS_TOKEN` is set, uncomment the `authorization:` block on the core job.

```bash
# NOTE: 9091, not 9090 — on a media node the LiveKit ingress already holds
# 127.0.0.1:9090 (see §4, gotcha 1). Prefer the ready-made deploy/observability/ stack.
docker run -d --name prometheus -p 9091:9090 \
  -v "$PWD/deploy/prometheus.yml:/etc/prometheus/prometheus.yml:ro" \
  prom/prometheus
```

For a host/systemd deploy scrape `127.0.0.1:3020` and `127.0.0.1:6789` and keep the metrics
port bound to localhost. Confirm all jobs are `UP` at `http://<host>:9090/targets`.

## 4. Connect Grafana + Prometheus — ready-to-run stack (verified on a live node)

A complete, self-contained stack lives in [`deploy/observability/`](../../deploy/observability/):
`docker-compose.observability.yml` (Prometheus + node_exporter + Grafana, all
`network_mode: host`, RAM-capped, bound to `127.0.0.1`), `prometheus.yml` (scrape jobs
below), `alerts.yml`, and three provisioned Grafana dashboards
(`grafana/dashboards/{server-global,per-app,media-latency}.json`). It is **separate** from
the media stack — bring it up and tear it down independently.

**Day-0 connect (validated end-to-end against a real StreamHub node — all targets `UP`,
`streamhub_*` + `livekit_*` series scraped, dashboards provisioned):**

```bash
cd deploy/observability
cp .env.example .env                       # set GRAFANA_ADMIN_PASSWORD
cp secrets/metrics_token.example secrets/metrics_token   # paste the core's METRICS_TOKEN
docker compose -f docker-compose.observability.yml --env-file .env up -d
curl -s http://127.0.0.1:9091/api/v1/targets | jq '.data.activeTargets[]|{job:.labels.job,health}'
```

Scrape jobs (all over `127.0.0.1`, since core/LiveKit run on the host network):

| Job | Target | Auth | Notes |
|---|---|---|---|
| `streamhub-core` | `127.0.0.1:3020/metrics` | Bearer (`credentials_file`) | `streamhub_*` + `process_*`/`nodejs_*` |
| `livekit` | `127.0.0.1:6789` | none | SFU: participants, packet loss, jitter |
| `livekit-ingress` | `127.0.0.1:6790` | none | RTMP/WHIP ingress |
| `livekit-egress` | `127.0.0.1:6791` | none | recording/HLS egress |
| `node` | `127.0.0.1:9100` | none | host CPU/RAM/disk/net |

**Gotchas learned validating this live — bake them in:**

1. **Prometheus binds `9091`, never `9090`.** On a node running the media stack the LiveKit
   **ingress holds `127.0.0.1:9090`** (its debug/health server) — a Prometheus on 9090
   crash-loops with `bind: address already in use`. The shipped compose now uses
   `${PROMETHEUS_PORT:-9091}`. (Ingress *metrics* are separately on `6790`.)
2. **`/metrics` is default-DENY.** With **no `METRICS_TOKEN`** the endpoint `404`s and serves
   nothing at all (not just "nothing sensitive"). With a token set, a matching `Authorization:
   Bearer` gets `200`, a wrong/absent one gets `403` — put the exact token in
   `secrets/metrics_token` (Prometheus sends it as the bearer). So a scrape 404 means "no token
   configured on that core", a 403 means "token mismatch".
3. **Never expose Grafana/Prometheus to the internet.** They bind `127.0.0.1`; reach Grafana
   (`:3001`) via an SSH tunnel — `ssh -L 3001:127.0.0.1:3001 <host>` → `http://localhost:3001`
   — or an nginx location with auth.
4. **Cluster:** run this stack on the origin and add one scrape job per edge (its public/
   private `:3020` with the same token, plus `:6789/:6790/:6791`), or push node_exporter
   from each edge. Set a distinct `external_labels.node` per node.

Handy Grafana queries (used by the shipped dashboards):

- Active streams: `sum(streamhub_active_streams)`
- Request rate: `sum by (route,status) (rate(streamhub_http_requests_total[5m]))`
- p95 latency: `histogram_quantile(0.95, sum by (le,route) (rate(streamhub_http_request_duration_seconds_bucket[5m])))`
- Upload success: `sum(rate(streamhub_s3_uploads_total{result="ok"}[5m])) / sum(rate(streamhub_s3_uploads_total[5m]))`
- VOD backlog: `sum(streamhub_upload_queue_depth)`
- Callback failures: `sum by (event) (rate(streamhub_callbacks_total{result="failed"}[5m]))`
- Tenant usage vs quota: `streamhub_tenant_usage / streamhub_tenant_quota`
- LiveKit packet loss: `avg(livekit_packet_loss_percent)`

**Recommended alerts** (`alerts.yml`): core target down; `streamhub_upload_queue_depth`
sustained high; `rate(streamhub_recording_failures_total[15m]) > 0`; high
`rate(streamhub_callbacks_total{result="failed"}[15m])`; per-node CPU/bandwidth (cluster).

## 5. Using an EXISTING (external) Prometheus / Grafana

You don't have to run the shipped compose stack — an external Prometheus/Grafana works fine:

1. **Scrape the master with the token.** Add one job pointing at the master's `:3020/metrics`
   with the `METRICS_TOKEN` as a bearer (remember `/metrics` is default-DENY — no token → 404):
   ```yaml
   - job_name: streamhub-master
     scheme: http                 # https if you scrape through the public domain
     authorization: { type: Bearer, credentials: '<METRICS_TOKEN from the master .env>' }
     static_configs: [ { targets: ['MASTER_IP:3020'], labels: { node: 'master' } } ]
   ```
   Because edge nodes are exported **by the master** (§1c), this one job already carries the
   whole fleet's `streamhub_cluster_node_*` + `streamhub_edge_*` series — **do not** add per-edge
   scrape jobs for these (the edges have no inbound `/metrics`).
2. **Import the dashboards.** In Grafana, *Dashboards → New → Import* each JSON from
   [`deploy/observability/grafana/dashboards/`](../../deploy/observability/grafana/dashboards/)
   (`edge-nodes.json`, `cluster-overview.json`, `server-global.json`, …) and pick your
   Prometheus datasource. The JSON references a datasource **uid `prometheus`**; if yours differs,
   select it at import time (or set its uid to `prometheus`).
3. **Load the alert rules.** Point your Prometheus `rule_files` at `alerts.yml` (single-node) and
   `alerts.cluster.yml` (adds the edge capacity rules — `EdgePendingAssignments`,
   `EdgeNoGpuCapacity`).

## Logs

Structured pino logs go to stdout (`docker compose logs -f core` / `journalctl -u
streamhub-core`), a rotating file under `<DATA_DIR>/logs/` (`LOG_MAX_BYTES`/`LOG_MAX_FILES`),
and the `server_logs` table — queryable via `GET /api/v1/logs` (filter by app/level/date).
