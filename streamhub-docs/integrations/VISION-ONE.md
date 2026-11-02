# StreamHub + Vision One — retail & CCTV intelligence

**What this is.** [Vision One](https://gitlab.com/digitalhub_com_ar/streamhub-vision-one) (internally "StoreHub
Vision One", ~13k LOC Python) is a production, multi-model computer-vision framework for retail CCTV analytics.
This doc explains its models, and the concrete plan to make **StreamHub the media/registry/dashboard layer under
Vision One's analytics brain** — turning the two into a self-hosted retail-intelligence platform that Ant Media
and Wowza have no native equivalent for.

The clincher: Vision One's real-time model **already pulls HLS from an Ant Media box** (`stream02.vivet.app/StoreHub/`).
Its three input modalities map exactly onto what StreamHub produces, so this is a **replacement path, not greenfield**.

## The five models

| Model | Weights / stack | Tracker | Input | Output |
|---|---|---|---|---|
| **Occupancy** (real-time, daemon) | YOLO11m, PyTorch, fp16 | ByteTrack (`custom_bytetrack*.yaml`) | **HLS** (`cv2.VideoCapture(url, CAP_FFMPEG)`) | POI-zone sessions → Postgres `{tenant}_cctv_places_occupancy`; dwell **webhook** alerts; `/metrics` + MJPEG debug |
| **People counting** (nightly cron, 3-step) | YOLO11m→YOLOv8m fallback | BoT-SORT (`custom_botsort.yaml`, `classes=[0]`) | **recorded video** (Records API → mp4) | line-crossing IN/OUT → Postgres `{tenant}_cctv_occupancy`; `load_completed` webhook |
| **Crowd** (cron/min) | YOLO26m, conf 0.42 | — (snapshot detection) | **camera snapshots** (CDN) | agglomeration alerts + annotated image → StoreHub API; local `state.json` |
| **Demography** (cron/2min) | InsightFace `buffalo_l` (genderage) + HSEmotion `enet_b0_8_best_vgaf`, onnxruntime | — | **snapshots** with `demography_enabled` | age ±5 / gender / 7 emotions → Postgres `{tenant}_cctv_demographics` |
| **Benchmark** | YOLO26m/yolov8m | — | — | GPU/CPU perf report |

Framework: an abstract `VisionModel` (setup→execute→teardown), `@register_model` auto-discovery, 4 execution modes
(CRON/DAEMON/BATCH/ONE_SHOT), **each model an isolated OS process** with file heartbeats (no Redis), a circuit
breaker on webhooks, FastAPI (~40 endpoints) + a single-file dashboard, and a **master/slave GPU cluster over HTTP**
(`X-Cluster-Token`, VRAM-sized load balancer, `DISTRIBUTABLE_MODELS = {occupancy, people_counting}`). Prod today:
vision01 (RTX A4000) + vision02 (RTX 5060, people counting).

## Why it fits StreamHub (input/output mapping)

| Vision One needs | StreamHub already produces |
|---|---|
| HLS stream per camera (occupancy) | HLS egress (`/hls/<app>/<room>/index.m3u8`) |
| Recorded mp4s per camera/day (people counting) | per-app S3 recordings (egress → bucket) |
| Camera snapshots (crowd, demography) | ws-mjpeg `frame.jpg` + egress snapshots |
| Camera + zone/line config, per tenant | per-app `config.yaml` + ingress/ws-ingest registry; **apps = tenants** |
| A place to push events + visualize | HMAC webhooks + **player-overlay plugins** on the dashboard |

Zone geometry is already **normalized 0–1** (`zones.py`) and the counting line is normalized
position/length/orientation — so both drop straight onto StreamHub player-overlays as coordinates.

## Integration architecture

**StreamHub = media plane + camera registry + dashboard. Vision One = analytics plane.** Two paths + one event bridge:

1. **Occupancy → StreamHub worker plugin (real-time).** Highest fit: it's already a standalone
   `python -m vision_one.models.occupancy` daemon with file heartbeats — exactly StreamHub's `needsWorker` plugin
   shape. StreamHub's plugin framework spawns it per app on the GPU node and injects:
   - the **HLS egress URL** via `stream_base_url` override (`occupancy/model.py`), and
   - the **device + zone list** via `_assigned_devices` / `CLUSTER_ASSIGNED_DEVICES_FILE` — bypassing the StoreHub
     management API entirely. Each device dict needs `tenant_id`, `legacy_name`, `store_id`, `domain_id` and a
     `places_occupancy_config` (normalized zones) — all sourced from the app's `config.yaml`.
2. **People counting → nightly job over StreamHub S3 (batch).** Replace the StoreHub Records API with an S3-prefix
   lister returning `[{record_url: <mp4>}]` per device/day (the only shape `download.py` needs). Counts flow to
   Postgres idempotently as today.
3. **Events → StreamHub → overlays.** Point occupancy's `alert_webhook_url` and people-counting's `load_completed`
   webhook at a StreamHub ingest endpoint; StreamHub **re-signs (HMAC)** and fans out to webhook consumers and
   **player-overlay plugins** (live occupancy zones, footfall counters, crowd heat, demographics cards).

Shared GPU: Vision One's master/slave cluster co-locates with StreamHub's cluster + the GPU node
(`streamhub-docs/operations/CAPACITY-G2.md` VM200 RTX 3090) — StreamHub does ingest/SFU + control plane, the GPU
node runs the vision models.

## The glue — three thin adapters (no algorithm changes)

1. **Device/zone config source** — feed Vision One its device list from StreamHub apps (via `_assigned_devices`
   file/env, or a `/devices/available` shim), instead of `manage.storehub.cloud`.
2. **S3 record lister** — a tiny endpoint (or prefix-lister) matching `download.py`'s `[{record_url}]` shape over
   StreamHub's per-app bucket.
3. **HMAC webhook bridge** — a StreamHub receiver that accepts Vision One's (currently unsigned) events and re-emits
   them signed; note occupancy's quirk of POSTing alerts via `requests.get(url, json=...)`.

## Gaps to close

- **Config coupling:** cameras/zones come from the StoreHub API today → move to StreamHub app config (adapter #1).
- **Persistence coupling:** models write **directly to multi-tenant Postgres**. Either share that DB, or add an
  *event-only* mode (occupancy already has a `test_mode` CSV sink to model it) so StreamHub owns storage.
- **Webhook contract:** unsigned JSON + the GET-with-body quirk → bridge or a small signing patch.
- **Tenancy mapping:** everything is keyed by `tenant_id`+`legacy_name`/`store_id`/`domain_id` → define the
  StreamHub app/room → Vision One identity mapping.
- **GPU/lifecycle ownership:** as a StreamHub worker, StreamHub's supervisor owns start/stop; Vision One's own
  answer to GPU contention (one GPU per cluster node) still applies.

## Phased plan

1. **P1 — Occupancy live (M).** Worker plugin wraps the occupancy daemon; StreamHub HLS + app-config zones in,
   HMAC webhook out, zone overlay on the player. Swaps Ant Media (`stream02.vivet.app`) for StreamHub as the source.
2. **P2 — People counting batch (M).** S3 record lister + nightly job; footfall overlays + `/apps/:app/analytics`.
3. **P3 — Crowd + demography (M).** Snapshot feed from StreamHub; demographics/crowd cards as panel plugins.
4. **P4 — Unify (L).** Fold Vision One's Core SDK model-runner into StreamHub's worker framework + one cluster, so
   there's a single control plane, GPU scheduler and dashboard.

**Positioning:** this is the flagship next-gen move — it makes StreamHub a retail-intelligence product (retail, fuel,
parking, QSR) on primitives that already exist, using a vision suite already in production. See
`streamhub-docs/FABLE-NEXT-LEVEL-BRIEF.md` and the competitive/roadmap brief.
