# StreamHub perimeter worker

Python worker for the **`perimeter`** StreamHub plugin — realtime after-hours
intrusion detection. It pulls an app's live stream over **HLS**, runs
**YOLOv8n person detection** on sampled frames, tests each person's foot point
against the configured restricted **zones**, and — while the perimeter is
**ARMED** — fires `perimeter.intrusion` alerts with on-disk **evidence**.

```
HLS  /hls/<app>/<room>/index.m3u8
  │            (opencv + ffmpeg backend, throttled to PERIMETER_FPS)
  ▼
YOLOv8n person detection (cpu|cuda, lazy import)
  │            (normalized boxes → foot-anchor point-in-polygon per zone)
  ▼
ARMED?  manual override OR schedule (daily window + weekends, timezone-aware)
  │            (per-zone cooldown gates re-fires, default 60 s)
  ▼ intrusion
  ├─ evidence: snapshot JPEG (+ optional ~10 s HLS `-c copy` clip)
  ├─ SQLite row in perimeter.db
  ├─ POST perimeter.intrusion → PERIMETER_CALLBACK_URL   (signed if secret set)
  └─ live status (armed, persons, alert queue + thumbs) → STREAMHUB_INGEST_URL
```

Structured JSON log lines go to stdout; when run via the plugin's worker-hook
the core mirrors them into the plugin **Logs** dialog in the dashboard.

## How it's wired to the plugin

`streamhub-core/src/plugins/perimeter/plugin.meta.ts` declares the plugin
(`needsWorker: true`) and a pure `worker.spawn(ctx)` that maps the saved
config to this process:

```
python -m perimeter_worker --app <app>
```

with these env vars (the core sets them; you set them yourself when running
standalone / on an edge box):

| Env | From config | Meaning |
|---|---|---|
| `PERIMETER_APP` | (context) | App slug. |
| `PERIMETER_ROOM` | `room` | HLS room to watch. |
| `PERIMETER_ZONES` | `zones` | JSON zones — see **Zones** below. |
| `PERIMETER_MODEL` | `model` | `yolov8n` (default) or `yolov8s`. |
| `PERIMETER_DEVICE` | `cuda` toggle | `cpu` or `cuda`. |
| `PERIMETER_CONFIDENCE` | `confidence` | Min person confidence 0–1 (default 0.5). |
| `PERIMETER_FPS` | `fps` | Frames/sec to sample (0.1–10, default 1). |
| `PERIMETER_ANCHOR` | `anchor` | `foot` (bottom-center, default) or `center`. |
| `PERIMETER_ARM_MODE` | `armMode` | `schedule` \| `armed` \| `disarmed` (manual override). |
| `PERIMETER_ARM_SCHEDULE` | `armSchedule` | Daily window `HH:MM-HH:MM`, wraps midnight (default `22:00-06:00`). |
| `PERIMETER_ARM_WEEKENDS` | `armWeekends` | `true` arms all day Sat+Sun (default true). |
| `PERIMETER_TIMEZONE` | `timezone` | IANA tz the schedule is evaluated in — see **Timezone**. |
| `PERIMETER_COOLDOWN` | `cooldown` | Per-zone seconds between alerts (default 60). |
| `PERIMETER_CLIP_SECONDS` | `clipSeconds` | Evidence clip length; 0 disables (default 10). |
| `PERIMETER_ACK_THROUGH` | `ackThrough` | Unix seconds; alerts ≤ this are acked on boot. |
| `PERIMETER_DATA_DIR` | (context) | Where `perimeter.db` + `evidence/` live (`apps/<app>/perimeter/`). |
| `PERIMETER_CALLBACK_URL` | `callbackUrl` | Optional operator webhook for intrusion events. |
| `PERIMETER_CALLBACK_SECRET` | `callbackSecret` | HMAC secret — see **Signed events**. |
| `PERIMETER_HLS_DIR` | (context) | Local `<appDir>/hls` — used if present. |
| `PERIMETER_PUBLIC_BASE` | `PUBLIC_BASE_URL` | Fallback base for the public HLS URL. |
| `STREAMHUB_INGEST_URL` / `_TOKEN` | (worker-hook) | Framework live-data channel for the dashboard app-tab. |

Source resolution: the local `index.m3u8` under `PERIMETER_HLS_DIR/<room>/` is
used when it exists (no network, no auth); otherwise the public
`PERIMETER_PUBLIC_BASE/hls/<app>/<room>/index.m3u8` URL. The evidence **clip**
only works off the local playlist (it `-c copy`-concats the last segments on
disk); a worker reading HLS over HTTP records snapshot-only evidence.

## Zones

`PERIMETER_ZONES` is a JSON array of normalized (0–1) shapes; the dashboard
zone editor writes it for you:

```json
[
  { "id": "gate",   "rect":   [0.60, 0.40, 0.35, 0.55] },
  { "id": "loading","points": [[0.05,0.55],[0.45,0.50],[0.45,0.95],[0.02,0.95]] }
]
```

`rect` is `[x, y, w, h]`; `points` is a polygon (≥ 3 vertices). Malformed
entries are dropped, never fatal. A person triggers a zone when their
**anchor point** (bottom-center of the detection box by default — "where they
stand") is inside the polygon.

## Arm/disarm schedule + timezone

The perimeter is armed when `armMode` is `armed` (manual), never when
`disarmed`, and otherwise (`schedule`) when the local time is inside the
daily `armSchedule` window (e.g. `22:00-06:00`, wrapping midnight; end
exclusive) **or** it's a weekend and `armWeekends` is on.

**Timezone note:** the schedule is wall-clock in `PERIMETER_TIMEZONE` (IANA
name, e.g. `America/Argentina/Buenos_Aires`). Empty/unknown values fall back
to the **host's local time — inside Docker that is usually UTC**, so set the
timezone explicitly unless the server clock is the site clock. The worker
logs a `note` when it falls back.

## Alert storms — per-zone cooldown

One alert per zone per `cooldown` seconds (default 60): a person lingering in
a zone re-fires only after the cooldown; other zones are independent.

## Evidence + per-plugin SQLite

Everything lives under `PERIMETER_DATA_DIR` (the plugin maps it to
`<DATA_DIR>/apps/<app>/perimeter/`):

```
perimeter/
├── perimeter.db                          # alert queue (schema below)
└── evidence/
    ├── 20260709-233015-482-gate.jpg      # snapshot at the trigger frame
    └── 20260709-233015-482-gate.mp4      # last ~10 s of HLS, -c copy (optional)
```

```sql
CREATE TABLE alerts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            REAL    NOT NULL,          -- unix seconds
  zone          TEXT    NOT NULL,          -- zone id
  confidence    REAL    NOT NULL,          -- best person confidence 0-1
  snapshot_path TEXT    NOT NULL DEFAULT '',
  clip_path     TEXT    NOT NULL DEFAULT '',
  acked         INTEGER NOT NULL DEFAULT 0
);
```

The worker owns all writes. The dashboard reads the queue through the plugin
live-data channel (the worker publishes the recent rows + small thumbnails)
and acknowledges via the plugin config: PATCHing `ackThrough=<alert ts>`
restarts the worker, which flips `acked=1` for that alert **and everything
older** on boot (alarm-queue "ack up to here" semantics).

## Events

### `perimeter.intrusion` → `PERIMETER_CALLBACK_URL`

```json
{
  "event": "perimeter.intrusion",
  "app": "live", "room": "cam-1", "ts": 1783551600.5,
  "zone": "gate", "confidence": 0.91,
  "snapshot": ".../evidence/20260709-233015-482-gate.jpg",
  "clip": ".../evidence/20260709-233015-482-gate.mp4"
}
```

**Signed events:** when `callbackSecret` is set the body is HMAC-SHA256
signed into `X-StreamHub-Signature: sha256=<hex>` — the same header + scheme
StreamHub's app callbacks use, so one verifier covers both. Point
`callbackUrl` at your app-webhook receiver (with the same secret) to fold
intrusions into your signed callback stream. Worker lifecycle events
(`plugin_worker_started/_stopped/_error`) already flow through the app's
signed callbacks via the framework worker-hook.

### Live status → `STREAMHUB_INGEST_URL` (dashboard app-tab)

Pushed every ~2 s (and immediately on an alert), size-capped under the core's
64 KiB live-payload limit (thumbnails are dropped first, metadata never):

```json
{
  "room": "cam-1", "ts": 1783551600.5,
  "armed": true, "mode": "schedule", "zones": 2,
  "persons": [{ "bbox": [0.44, 0.25, 0.12, 0.72], "conf": 0.91 }],
  "alerts": [{ "id": 7, "ts": 1783551600.5, "zone": "gate", "confidence": 0.91,
               "snapshot": "...", "clip": "...", "acked": false, "thumb": "<b64 jpeg>" }],
  "unacked": 1, "ackThrough": 0, "frame": "<b64 jpeg preview>"
}
```

## Edge-ready

The worker is a **pure env/args process** — no core imports, no shared
filesystem needed beyond its own data dir; HLS in over HTTP, HTTP out. That
makes it grid-placement compatible (the plugin declares `placement: 'grid'`
with a `yolo` capability; until a grid node is registered it transparently
runs locally) and trivially deployable on an edge box next to the camera:

```bash
docker build -t streamhub-perimeter ./perimeter-worker

docker run --rm --name perimeter-live-cam1 \
  -v /srv/perimeter-data:/data \
  -e PERIMETER_APP=live \
  -e PERIMETER_ROOM=cam-1 \
  -e PERIMETER_DATA_DIR=/data \
  -e PERIMETER_ZONES='[{"id":"gate","rect":[0.6,0.4,0.35,0.55]}]' \
  -e PERIMETER_ARM_SCHEDULE=22:00-06:00 \
  -e PERIMETER_TIMEZONE=America/Argentina/Buenos_Aires \
  -e PERIMETER_PUBLIC_BASE=https://streamhub.example.com \
  -e PERIMETER_CALLBACK_URL=https://your.app/hooks/perimeter \
  -e PERIMETER_CALLBACK_SECRET=change-me \
  streamhub-perimeter --app live
```

One container per app/room. On a remote node the evidence + `perimeter.db`
live on **that node's** disk; alert metadata + thumbnails still reach the
dashboard through the live channel, and events reach your webhook.

### Bare Python

```bash
cd perimeter-worker
python -m venv .venv && . .venv/bin/activate
pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu
pip install -r requirements.txt
PERIMETER_APP=live PERIMETER_ROOM=cam-1 PERIMETER_DATA_DIR=./data \
  PERIMETER_ZONES='[{"id":"gate","rect":[0.6,0.4,0.35,0.55]}]' \
  PERIMETER_PUBLIC_BASE=https://streamhub.example.com \
  python -m perimeter_worker --app live
```

## Minimum requirements (honest numbers)

CPU-only is the intended default — intrusion detection does not need every
frame, it needs *recent* frames:

- **CPU (no GPU, e.g. stream01):** `yolov8n` at **1–2 fps** costs roughly
  **0.5–1 modern x86 core per camera** (~100–300 ms/frame inference on one
  core plus HLS decode; ~1.5 GB RAM resident with torch + weights, ~1 GB
  disk for the CPU torch stack). Budget ~1 core + 2 GB RAM per watched room
  and it will never fall behind at 1 fps. `yolov8s` roughly doubles the
  CPU cost for better small/far-person recall.
- **Raspberry Pi / small ARM edge boxes:** run `yolov8n` at **0.3–1 fps**
  (`PERIMETER_FPS=0.5`) — detection latency of a couple of seconds is still
  far inside a useful intrusion-response window.
- **GPU (optional):** any CUDA GPU turns this into rounding error —
  `yolov8n` runs in a few ms/frame; set the `cuda` toggle
  (`PERIMETER_DEVICE=cuda`) and use CUDA torch wheels / `--gpus all`.
- Disk: evidence JPEGs are ~100–400 KB each; clips are `-c copy` (no
  re-encode), ~1–4 MB per 10 s at typical cam bitrates. The cooldown bounds
  the write rate (default: ≤ 1 alert/zone/minute).

The worker logs a startup `note` when running on CPU as a reminder to keep
FPS low; the FPS throttle drops frames rather than queueing, so an overloaded
box degrades to a lower sample rate instead of drifting behind the live edge.

## Tests

Pure-logic tests need **no** torch/opencv/network (sqlite is the stdlib):

```bash
cd perimeter-worker
pip install pytest
pytest -q
```

They cover point-in-polygon + zone parsing/anchoring, the arm/disarm schedule
(overnight wrap, weekends, timezone incl. fallback), the per-zone cooldown,
the SQLite alert store (insert/recent/ack-through/reopen), evidence path +
playlist-tail clip selection + the `-c copy` command, env parsing/clamping,
the signed webhook + ingest-token headers, and the detect→arm→alert→status
loop end to end with fakes.


## Measured GPU (AWS Tesla T4, 2026-07-10)
YOLOv8n @720p = **59 FPS** on a T4 (16.9 ms/frame, ~36% GPU util, 249 MiB). At the
default sampling fps (2–5), one T4 comfortably runs ~15–25 concurrent streams of
this plugin. ONNX-based plugins (lpr/safety-ppe) were not re-measured on GPU in
this run (CUDA-runtime mismatch on the DLAMI) — their documented CPU estimates stand.
