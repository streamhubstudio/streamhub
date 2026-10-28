# StreamHub Vision Edge runtime

The Python runtime a **StreamHub master** orchestrates to run computer vision at
the edge (or co-located on the master host). It ships four vision models —
**occupancy**, realtime **counting**, **crowd**, **demography** — plus the
**edge control-channel daemon** that dials the master out over a WebSocket,
receives stream×model assignments and supervises one worker process each.

It imports **nothing** from the core: every input arrives via env/args, results
leave over HTTP (batched, signed-friendly) and the model's own state files. So
the same code runs as a plugin worker on the master or as a systemd service on a
remote GPU box — the master schedules identically either way.

```
                       master (StreamHub core)
   HLS  ◄── pull ─────  /hls/<app>/<room>/index.m3u8
    │                    /api/v1/edge/ws   ◄── edge dials OUT (wss) ── edge daemon
    ▼                    events channel    ◄── batched detections ──┐   (supervisor)
  YOLO11 + ByteTrack / InsightFace                                  │      │ spawns
    │  per-model pure engine (zones / lines / threshold / faces)    │      ▼
    └─ occupancy.* · count.* · crowd.* · demography.* ──────────────┘   worker × N
```

## Run modes

| Mode | Command | Config | Role |
|---|---|---|---|
| **worker** | `python -m vision_edge --model <m> --room <r>` | `VISION_*` + `STREAMHUB_*` env | one model bound to one room; spawned by a per-app worker-manager OR by the edge supervisor |
| **worker-manager** | `python -m vision_edge --mode worker-manager --model <m> --app <a>` | `VISION_*` + `STREAMHUB_*` env | CO-LOCATED per-app manager: runs ONE model across all the app's active rooms, one manager per Studio App (`--model` REQUIRED) |
| **edge** | `python -m vision_edge --edge` | `STREAMHUB_*` env | long-lived daemon: WS client + supervisor; receives assignments and manages worker children itself |

With neither `--edge`/`--mode` flag the mode is inferred from the environment
(an edge WS / master URL present ⇒ edge, else worker). Since the `vision` plugin
was split into four Studio Apps (occupancy / counting / crowd / demography), the
core spawns ONE `worker-manager` per app bound to that app's single model; each
worker-manager reads per-room settings from the app's per-model db
`<VISION_DATA_DIR>/<model>.db` (table `stream_settings(room, config_json)`,
read-only — the core owns it).

## Models

Each model pairs a **pure-logic core** (unit-tested, no torch/cv2) with a runner
that wires the real HLS reader + detector.

- **occupancy** — multi-**polygon** POI zones (`cv2.pointPolygonTest`-equivalent
  on the bbox foot/center), persons *or* vehicles per zone (`detect:
  personas|vehiculos` → COCO class filter), sessions with an empty-grace + a
  minimum duration, and a count-based `occupancy.alert` (occupancy ≥ `alertLimit`
  sustained `alertAfterSec`). Uses **adaptive frame sampling** (Vision One's
  4–19 skip). Ports Vision One's `PeoplePOIZone`/`VehiclePOIZone` state machine.
- **counting** — realtime line crossing at a **FIXED 3.5 FPS** cadence (not
  adaptive — ByteTrack/BoT-SORT are ID-swap sensitive when the frame gap varies).
  Multi-line, each tagged; drives `count.in`/`count.out` + a rolling
  `count.occupancy`. `LineCrossingCounter` is a verbatim logic port of Vision
  One's (cross-product side + buffered segment intersection + `max_crossing_speed`
  ID-switch rejection + per-track cooldown + near-line cleanup).
- **crowd** — one snapshot every `intervalSec`, CLAHE, YOLO-count persons inside
  each polygon, **multi-cycle threshold** (Vision One `CrowdStateManager`): the
  consecutive-cycle counter must reach `ceil(alertAfterSec/intervalSec)` before
  `crowd.threshold` fires (re-arms on drop). `crowd.count` every cycle.
- **demography** — one snapshot every `intervalSec` → faces:
  - `engine: local` — InsightFace **buffalo_l** (genderage + RetinaFace) with a
    softmax over the genderage logits and Vision One's asymmetric gender
    thresholds (male 0.95 / female 0.30 — counters buffalo's male bias) +
    HSEmotion (8→7 remap, anti-"angry" rule). InsightFace import is **lazy**.
  - `engine: openai | deepseek` — snapshot → base64 → a Chat Completions vision
    message with the operator's `aiPrompt`; the JSON reply is parsed to the same
    record. A **monthly budget guard** persists estimated spend and hard-stops
    over `aiBudgetMonthly`.

### Config (per-stream `config_json`, resolved by the master)

```jsonc
// occupancy / crowd
{ "zones": [ { "id": "z1", "tag": "entrance", "detect": "personas",
               "points": [[0.2,0.2],[0.8,0.2],[0.8,0.8],[0.2,0.8]],
               "confidence": 0.3, "alertLimit": 5, "alertAfterSec": 300 } ] }
// counting
{ "lines": [ { "id": "door", "tag": "main", "x": 0.5, "y": 0.5,
               "length": 0.6, "angle": 0, "inside": "bottom" } ],
  "fps": 3.5, "capacity": 50 }
// demography
{ "engine": "local", "intervalSec": 120,
  "roi": { "points": [[0.1,0.1],[0.9,0.1],[0.9,0.9],[0.1,0.9]] },
  "aiPrompt": "...", "aiBudgetMonthly": 25 }
```

## Events

Every event carries the common envelope `{app, room, tags, nodeId, model, ts}`
plus specifics, batched (≤1/s) to the framework EVENT channel with the per-start
`X-Plugin-Ingest-Token`: `STREAMHUB_EVENTS_URL` + `STREAMHUB_INGEST_TOKEN` when
the framework/edge resolver injects them (edge assignments carry these), falling
back to the legacy `VISION_EVENTS_URL` / `VISION_INGEST_TOKEN`. On outage they
spool to a bounded ring and retry.

| Event | Specifics |
|---|---|
| `occupancy.session_started` / `occupancy.session_ended` | `{zone, tag, kind, durationSec?}` |
| `occupancy.alert` | `{zone, tag, kind, occupancy, limit, sinceSec}` |
| `count.in` / `count.out` | `{line, tag, trackId, confidence}` |
| `count.occupancy` | `{inside, capacity?}` |
| `crowd.count` · `crowd.threshold` | `{zone, tag, count}` · `{…, threshold, cycles}` |
| `demography.face` | `{age, ageRange, gender, genderConfidence, emotion, emotionConfidence, tag?, engine}` |

## Worker env (`VISION_*`)

| Env | Meaning |
|---|---|
| `VISION_MODEL` | `occupancy` \| `counting` \| `crowd` \| `demography` (also selects the worker-manager's single model) |
| `VISION_APP` / `VISION_ROOM` | app slug + HLS room/stream id |
| `VISION_HLS_URL` / `VISION_HLS_DIR` | resolved HLS/RTSP source (worker) / on-disk HLS dir (worker-manager) |
| `STREAMHUB_EVENTS_URL` / `STREAMHUB_INGEST_TOKEN` | framework event channel + auth (preferred; legacy `VISION_EVENTS_URL` / `VISION_INGEST_TOKEN` as fallback) |
| `VISION_CONFIG_JSON` | resolved per-stream settings (zones/lines/demography) |
| `VISION_DEVICE` | `cpu` \| `cuda` |
| `VISION_ENGINE` | demography engine `local` \| `openai` \| `deepseek` |
| `VISION_MODEL_DIR` | shared YOLO/InsightFace weight cache |
| `VISION_DATA_DIR` / `VISION_DB` / `VISION_SNAPSHOT_DIR` | per-model data dir (`<appDir>/<model>`) + per-model db + snapshot dir |
| `VISION_NODE_ID` / `VISION_TAGS` | node id + stream tags (echoed in events) |
| `VISION_AI_API_KEY` / `VISION_AI_BASE_URL` | AI-engine credentials (demography, LOCAL placement only) |

## Edge env (`STREAMHUB_*`)

| Env | Meaning |
|---|---|
| `STREAMHUB_EDGE_WS_URL` | edge control WS (`wss://<domain>/api/v1/edge/ws`) — else derived from `STREAMHUB_MASTER_URL` |
| `STREAMHUB_CLUSTER_TOKEN` | cluster auth (rides `X-Cluster-Token`) |
| `STREAMHUB_NODE_ID` | this node's id in the master `nodes` registry |
| `VISION_EDGE_ALLOW_REBOOT` | permit the master's `reboot` command (`systemctl reboot`); off by default |
| `VISION_EDGE_LOG` | runtime log path the master's `log_tail` reads |
| `VISION_EDGE_CAPABILITIES` | advertised caps (default `vision,yolo`) |
| `VISION_EDGE_APPSTORE_DIR` | bundle cache root for pinned appstore versions (default `~/.streamhub/appstore`) |

The edge daemon sends `register` on connect, `telemetry` every 15 s
(cpu/mem/disk via stdlib+optional psutil, gpu/vram via `nvidia-smi`), replies to
`ping`, and handles `assign`/`revoke`/`cmd`(`ping`|`restart`|`reboot`)/`log_tail`
— the exact Wave-1A frame protocol (`streamhub-core/.../edge.protocol.ts`).

## App versioning — pinned bundle cache

An `assign` frame may carry an **optional** `bundle` ref
(`{pluginId, version, sha256, url}`) when the assignment's install pins a
specific appstore version. Before spawning that assignment the daemon
(`vision_edge/appstore.py`) makes the pinned worker source available locally and
runs the child from it instead of the edge's own installed package:

1. **cache-check** `~/.streamhub/appstore/<pluginId>/<version>/extracted/<pluginId>/worker`
   (`VISION_EDGE_APPSTORE_DIR` overrides the base) — a valid hit skips the network;
2. **download** `url` over the same NAT-friendly gate as the WS channel — the
   `X-Cluster-Token` header, no inbound connection to the node;
3. **verify sha256** — a mismatch refuses to extract and marks the assignment
   `failed` with a clear detail (the daemon never crashes);
4. **extract atomically** (temp dir → `os.replace`) and drop a `.sha256` marker;
   a half-written / corrupt extract (missing or mismatched marker) is discarded
   and re-downloaded once. A per-version lock file serializes concurrent
   assignments for the same bundle so they can't race the extract;
5. **redirect the spawn** onto `…/extracted/<pluginId>/worker` — the Python
   mirror of the master's `spawn-redirect.util.ts`: the built-in dir prefix is
   swapped across `cwd`/args/env (derived from the frame's `PYTHONPATH`, since an
   edge frame drops the master's `cwd`), and `cwd` + `PYTHONPATH` are anchored on
   the pinned dir so `python -m <module>` imports the pinned code.

**Absent `bundle` → exactly today's behavior** (an older master simply omits the
field). A re-assign with a different version downloads the new one and leaves the
old cached, so a node-local rollback is instant. **Cache eviction is out of
scope** — an operator prunes `VISION_EDGE_APPSTORE_DIR`; nothing here deletes
old versions.

## Edge install (systemd)

The one-liner installer (`install.sh --node-type edge`) writes
`/etc/streamhub/edge.env` and a `streamhub-edge.service` unit. Ship the runtime
to `/usr/local/bin/streamhub-vision-edge` (a venv shim: `exec python -m
vision_edge --edge`) and the inert unit activates:

```ini
# /etc/systemd/system/streamhub-edge.service  (installed by install.sh)
[Unit]
Description=StreamHub Vision Edge runtime (dials the master WS control channel)
Wants=network-online.target
After=network-online.target
ConditionPathExists=/usr/local/bin/streamhub-vision-edge

[Service]
Type=simple
EnvironmentFile=-/etc/streamhub/edge.env      # STREAMHUB_MASTER_URL / _CLUSTER_TOKEN / _NODE_ID
ExecStart=/usr/local/bin/streamhub-vision-edge
Restart=on-failure
RestartSec=5
Nice=5

[Install]
WantedBy=multi-user.target
```

`systemctl restart` is exactly what the master's `restart` command relies on
(the runtime exits cleanly and systemd restarts it).

### Mono-node (no separate edge)

The **same runtime** runs ON the master host through the vision plugin's worker
lifecycle — no edge daemon, no WS. The plugin's `worker.spawn(ctx)` resolves the
`VISION_*` env and the framework owns start/stop/status/logs. Single-node
installs get every model with zero extra infrastructure.

## Minimum requirements

CPU-only is fine for a handful of streams; GPU is the multiplier. YOLO11 resizes
to 640 px for inference regardless of source resolution, so 720p vs 1080p mostly
changes decode cost.

| Resource | Minimum | Notes |
|---|---|---|
| CPU | 2 cores | yolo11n ≈ 80–150 ms/frame/core on 2020+ server cores. Counting at 3.5 FPS ≈ 0.3–0.5 core; occupancy's adaptive sampler less. Budget **~0.5 core per stream** + headroom. |
| RAM | 1.5 GB free/worker | CPU torch + ultralytics + opencv RSS ≈ 0.6–0.9 GB/process; the model itself is ~6 MB. |
| Disk | ~2.5 GB deps | torch CPU wheels + opencv; `yolo11n.pt` (~6 MB) auto-downloads; the `[demography]` extra adds insightface/onnxruntime + buffalo_l (~300 MB). |
| GPU | optional | Any CUDA GPU drops inference to <10 ms/frame. See the VRAM math below. |

### GPU VRAM capacity (how the master packs streams)

The scheduler (and this runtime's telemetry) use Vision One's LoadBalancer math:
reserve a **500 MB** buffer per node, budget **~200 MB per vision stream** →

```
max_streams = (vram_free_mb − 500) / 200
```

So a **Tesla T4 (16 GB, ~14.2 GB free)** hosts ≈ **68** streams by VRAM; in
practice compute caps it lower (a T4 runs yolo11n @720p at ~59 FPS → ~15–25
concurrent streams at 2–5 FPS sampling — measured 2026-07-10). The edge reports
`grid.vramFreeMb` + `grid.capacityStreams` in telemetry so the master never
over-assigns.

## Tests

Pure-logic only — **no torch, opencv, insightface, websockets or network**:

```bash
cd vision-edge-runtime && python3.12 -m pytest
```

Covers polygon zone membership + tagging, the `LineCrossingCounter` port
(crossing / direction / ID-switch reject / cooldown / cleanup), fixed-cadence +
adaptive sampler math, crowd multi-cycle threshold, demography gender/age/emotion
mapping + AI response parsing + budget guard, event batching/spool, the WS frame
codec + backoff + inbound dispatch, supervisor restart caps/backoff/lifecycle,
the app-versioning bundle cache (ref parsing, cache hit/miss, sha256
mismatch, atomic extract, concurrent lock, spawn redirect + token header),
telemetry parsing + VRAM math, and config parsing. Inference, frame reading, the
WS transport and the bundle downloader are injected fakes; the heavy libs are
imported lazily only in runtime paths.

## Provenance & license

The vision algorithms are ports of **Vision One** (`storehub-vision-one`):
occupancy pipeline + POI-zone sessions, `LineCrossingCounter`, crowd
`CrowdStateManager`, demography buffalo_l/softmax/emotion, and the
AdaptiveFrameSampler — re-expressed over normalized coordinates and upgraded to
polygons/tags, with StoreHub coupling removed.

**YOLO11 (ultralytics) is AGPL-3.0**, so this runtime is licensed
**AGPL-3.0-or-later**. RT-DETR / YOLOX are documented as future non-AGPL swaps.
The local demography engine adds InsightFace (MIT) + HSEmotion (Apache-2.0); the
AI-API engines need neither.
