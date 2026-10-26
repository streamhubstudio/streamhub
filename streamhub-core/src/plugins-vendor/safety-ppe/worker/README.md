# StreamHub safety-ppe worker (EXPERIMENTAL)

Python worker for the **`safety-ppe`** StreamHub plugin: realtime PPE/EPP
(helmet / hi-viz vest) compliance monitoring. It pulls an app's live stream
over **HLS**, runs a pretrained **YOLOv8m PPE model through plain
onnxruntime**, associates PPE items to persons per configured **work zone**
during the **work-hours schedule**, and turns sustained non-compliance into
`ppe.violation` events — evidence JPEG + SQLite row + HMAC-signed webhook
POST. One worker per app/room.

```
HLS  /hls/<app>/<room>/index.m3u8
  │           (opencv + ffmpeg backend, throttled to SAFETY_PPE_FPS)
  ▼         schedule gate (work hours/days — off-schedule frames skipped)
YOLOv8m PPE (safety-ppe.onnx — onnxruntime cpu|cuda)
  │           letterbox → decode → per-class NMS → role mapping
  ▼           person / helmet / no_helmet / vest / no_vest (normalized boxes)
zone assignment (feet anchor) → person↔PPE association (containment)
  ▼
ViolationTracker  (> N consecutive frames, cooldown per zone+item)
  ▼
ppe.violation ──► <EVIDENCE_DIR>/<app>/<ts>-<room>-<zone>-<items>.jpg
              ──► INSERT INTO violations (<SAFETY_PPE_DB>)
              ──► POST <SAFETY_PPE_CALLBACK_URL>  (X-StreamHub-Signature)
              ──► {"event":"violation", …} log line (dashboard table)
```

Structured JSON log lines go to stdout; when run via the plugin's worker-hook
the core mirrors them into the plugin **Logs** dialog, and the dashboard tab
builds its violations table from the `violation` lines.

## Model & license (read before shipping/selling anything on top)

- **Model:** [`Hexmon/vyra-yolo-ppe-detection`](https://huggingface.co/Hexmon/vyra-yolo-ppe-detection)
  (YOLOv8m fine-tune, 640² input, 14 classes). The worker downloads the
  repo's **`best.onnx`** (~100 MB) once into `SAFETY_PPE_MODEL_DIR` (atomic
  `.part` + rename). Classes used: `Person`, `Hardhat`, `NO-Hardhat`,
  `Safety Vest`, `NO-Safety Vest`; the other 9 (gloves, goggles, masks,
  cones, …) are ignored.
- **Licenses:** model card **CC BY 4.0**; dataset (Roboflow "PPE Combined
  Model v4") **CC BY 4.0**; runtime **onnxruntime (MIT)**. The AGPL-3.0
  `ultralytics` package is deliberately NOT a dependency — pre/post-processing
  (letterbox, decode, NMS) is reimplemented here, keeping the AGPL runtime
  out of the product. Caveat: Ultralytics claims YOLOv8-derived *weights* are
  AGPL derivatives, which would make the uploader's CC BY tag an unauthorized
  relicensing; untested in court, low practical risk, but disclose it.
- **This is an existing community checkpoint — nothing was trained in-house**
  — and its metrics (mAP50 ≈ 0.78) are self-reported on its own val split.
  Hence the plugin's EXPERIMENTAL label.
- **Known limitations:** outdoor/construction dataset bias (worse indoors, at
  night, warehouses); hi-viz color bias for vests; small/distant hardhats
  (< 20 px) missed; the negative classes (`NO-*`) are the weakest; crowded
  scenes confuse association. Absence of a positive detection counts as
  missing (fail-flagging, filtered by the sustain counter).
- Swap models freely via `SAFETY_PPE_MODEL_URL` (any YOLOv8-detect ONNX
  export): class names are read from the ONNX metadata, or set
  `SAFETY_PPE_CLASS_NAMES` explicitly.

## How it's wired to the plugin

`streamhub-core/src/plugins/safety-ppe/plugin.meta.ts` declares the plugin
(`needsWorker: true`) and a pure `worker.spawn(ctx)` that maps saved config to
this process:

```
python -m safety_ppe_worker --app <app>
```

| Env | From | Meaning |
|---|---|---|
| `SAFETY_PPE_APP` | (context) | App slug. |
| `SAFETY_PPE_ROOM` | `room` | HLS room to monitor. |
| `SAFETY_PPE_REQUIRE_HELMET` | `requireHelmet` | Enforce hard hats (default true). |
| `SAFETY_PPE_REQUIRE_VEST` | `requireVest` | Enforce hi-viz vests (default true). |
| `SAFETY_PPE_ZONES` | `zones` | JSON `[{"name","rect":[x,y,w,h]}]`, 0–1 coords; empty/invalid → full-frame zone `all`. |
| `SAFETY_PPE_WORK_HOURS` | `workHours` | `HH:MM-HH:MM` local time, overnight wraps; empty/invalid → always on. |
| `SAFETY_PPE_WORK_DAYS` | `workDays` | `mon-fri`, `mon,wed`, `1-5` (1=Mon); empty/invalid → every day. |
| `SAFETY_PPE_SUSTAIN_FRAMES` | `sustainFrames` | Fire after MORE THAN this many consecutive frames (default 3). |
| `SAFETY_PPE_COOLDOWN_SECONDS` | `cooldownSeconds` | Per zone+item re-fire suppression (default 120). |
| `SAFETY_PPE_CONFIDENCE` | `confidence` | Min detection confidence 0–1 (default 0.35). |
| `SAFETY_PPE_ASSOC_THRESHOLD` | `association` | Min containment of item-in-person to count as worn (default 0.5). |
| `SAFETY_PPE_FPS` | `fps` | Frames/sec to analyze (default 1 — see requirements). |
| `SAFETY_PPE_EXECUTION_PROVIDER` | `cuda` toggle | `cpu` or `cuda` (graceful CPU fallback). |
| `SAFETY_PPE_CALLBACK_URL` | `callbackUrl` | Optional webhook for `ppe.violation` events. |
| `SAFETY_PPE_CALLBACK_SECRET` | `callbackSecret` | Optional HMAC secret → `X-StreamHub-Signature: sha256=<hex>` (core callbacks format). |
| `SAFETY_PPE_MODEL_URL` | `modelUrl` | ONNX checkpoint URL (default: shipped model). |
| `SAFETY_PPE_MODEL_DIR` | (context) | Model cache (`<DATA_DIR>/models/safety-ppe`). |
| `SAFETY_PPE_CLASS_NAMES` | (optional) | Comma list overriding class names for custom models. |
| `SAFETY_PPE_DB` | (context) | SQLite violations DB (`<DATA_DIR>/safety-ppe.db`). |
| `SAFETY_PPE_EVIDENCE_DIR` | (context) | Snapshot root (`<DATA_DIR>/evidence`). |
| `SAFETY_PPE_HLS_DIR` | (context) | Local `<appDir>/hls` — used if present. |
| `SAFETY_PPE_PUBLIC_BASE` | `PUBLIC_BASE_URL` | Fallback base for the public HLS URL. |

The core owns start/stop/status/logs through the framework worker-hook:

```
POST /api/v1/apps/:app/plugins/safety-ppe/worker/start
POST /api/v1/apps/:app/plugins/safety-ppe/worker/stop
GET  /api/v1/apps/:app/plugins/safety-ppe/worker/status
GET  /api/v1/apps/:app/plugins/safety-ppe/logs      ← violations table source
```

SQLite schema (`violations` — the durable archive; query with any sqlite3
client):

```sql
violations(id, ts REAL, app TEXT, room TEXT, zone TEXT,
           missing TEXT /* 'helmet' | 'vest' | 'helmet,vest' */,
           confidence REAL, snapshot_path TEXT, acked INTEGER DEFAULT 0)
```

## Edge-ready / standalone

The worker is **pure env/args** — no core imports, no shared state beyond the
paths you hand it — so it runs anywhere with an HLS URL: a StreamHub Grid GPU
node (the plugin requests `grid` placement gated on the opt-in `ppe`
capability tag), a factory edge box, or plain Docker. Remember: the SQLite DB
and evidence JPEGs land on the machine the worker runs on.

### Docker

```bash
docker build -t streamhub-safety-ppe ./safety-ppe-worker
# add --build-arg PRELOAD_MODEL=1 to bake the ~100 MB model into the image

docker run --rm --name ppe-site-cam1 \
  -e SAFETY_PPE_APP=site \
  -e SAFETY_PPE_ROOM=cam1 \
  -e SAFETY_PPE_PUBLIC_BASE=https://streamhub.example.com \
  -e SAFETY_PPE_ZONES='[{"name":"dock","rect":[0.1,0.2,0.5,0.7]}]' \
  -e SAFETY_PPE_WORK_HOURS=08:00-18:00 \
  -e SAFETY_PPE_WORK_DAYS=mon-fri \
  -e SAFETY_PPE_CALLBACK_URL=https://your.app/hooks/ppe \
  -e SAFETY_PPE_CALLBACK_SECRET=change-me \
  -e SAFETY_PPE_DB=/data/safety-ppe.db \
  -e SAFETY_PPE_EVIDENCE_DIR=/data/evidence \
  -v ppe-data:/data \
  streamhub-safety-ppe --app site
```

### Bare Python

```bash
cd safety-ppe-worker
python -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
SAFETY_PPE_APP=site SAFETY_PPE_ROOM=cam1 \
  SAFETY_PPE_PUBLIC_BASE=https://streamhub.example.com \
  python -m safety_ppe_worker --app site
```

## Minimum requirements

- **CPU-only:** ~**1 s of one modern x86 core per analyzed frame** (YOLOv8m,
  640²). Budget 1–1.5 cores + ~2 GB RAM per stream at the default 1 fps.
  Don't raise fps on CPU; lower it (0.5) to stack streams.
- **GPU (recommended for >1 stream or fps ≥ 2):** NVIDIA ≥ 4 GB VRAM,
  `pip install onnxruntime-gpu`, `SAFETY_PPE_EXECUTION_PROVIDER=cuda`.
- **Disk:** ~100 MB model + evidence JPEGs (one per event, cooldown-limited).

## Tests

Pure-logic tests need **no** onnxruntime/opencv/network (sqlite3 is stdlib):

```bash
cd safety-ppe-worker
pip install pytest
pytest -q
```

They cover env parsing/clamping + stream-source resolution, class→role
mapping + ONNX metadata names parsing, the pure YOLOv8 decode → NMS →
letterbox-unmap pipeline, zone parsing + feet-anchor membership, the
person↔PPE containment association (the violation-decision core), the
sustained-streak + cooldown tracker, the work-hours schedule, the SQLite
store (real DB in tmp), the signed callback builder/poster, evidence path
building, and the full detect→associate→track→snapshot/store/POST loop with
every heavy piece faked.
