# StreamHub people-counter worker

Python worker for the **`people-counter`** StreamHub plugin: realtime
**line-crossing people counting** over an app's live HLS stream — YOLOv8
person detection + **ByteTrack** tracking (ultralytics built-in), IN/OUT
counting against an operator-drawn line, live occupancy, capacity alerts,
and a per-plugin SQLite log. One worker per app/room.

```
HLS  /hls/<app>/<room>/index.m3u8
  │            (opencv + ffmpeg backend, throttled to PC_FPS)
  ▼
YOLOv8 person detection + ByteTrack (persist=True, tuned persons yaml)
  │            (normalized bbox centers per track id)
  ▼
LineCrossingCounter (cross-product side test + buffered segment intersection,
  │                  cooldown / min-track / ID-switch guards)
  ├─▶ SQLite  <PC_DB_PATH>  (crossings + occupancy_samples)
  ├─▶ POST <PC_CALLBACK_URL>   signed events: count.in / count.out / occupancy.limit
  └─▶ POST STREAMHUB_INGEST_URL  latest counters snapshot (live-data channel)
```

The counting/tracking approach is **ported from Vision One**
(`streamhub-vision-one`: `vision_one/models/people_counting/counting.py` and
`custom_bytetrack_persons.yaml`) — the production-validated store-entrance
counter. See the provenance comments in `geometry.py`, `counter.py`,
`tracking.py` and `trackers/custom_bytetrack_persons.yaml`.

Structured JSON log lines go to stdout; when run via the plugin's worker-hook
the core mirrors them into the plugin **Logs** dialog, and the dashboard tab
reads its live IN/OUT/occupancy panel from the `counters` lines.

## How it's wired to the plugin

`streamhub-core/src/plugins/people-counter/plugin.meta.ts` declares the plugin
(`needsWorker: true`) and a pure `worker.spawn(ctx)` that maps the saved
config to this process:

```
python -m people_counter_worker --app <app>
```

| Env                  | From config     | Meaning |
|----------------------|-----------------|---------|
| `PC_APP`             | (context)       | App slug. |
| `PC_ROOM`            | `room`          | HLS room to analyze. |
| `PC_MODEL`           | `model` size    | `yolov8{n,s,m,l,x}` (nano→xlarge). |
| `PC_DEVICE`          | `cuda` toggle   | `cpu` or `cuda`. |
| `PC_CONFIDENCE`      | `confidence`    | Min person confidence 0–1 (default 0.3). |
| `PC_FPS`             | `fps`           | Frames/sec to sample (0.1–30, default 5). |
| `PC_LINE`            | `lineX1..lineY2`| `x1,y1,x2,y2` **normalized 0–1** counting line. |
| `PC_IN_DIRECTION`    | `inDirection`   | `right` or `left` — which side of p1→p2 is INSIDE (the arrow in the editor). |
| `PC_CAPACITY`        | `capacity`      | Occupancy alert threshold; `0` disables. |
| `PC_CALLBACK_URL`    | `callbackUrl`   | Where signed count events are POSTed (empty = local only). |
| `PC_CALLBACK_SECRET` | `callbackSecret`| HMAC-SHA256 secret for `X-StreamHub-Signature`. |
| `PC_DB_PATH`         | (context)       | Per-plugin SQLite file — the core passes `<DATA_DIR>/people-counter.db`. |
| `PC_HLS_DIR`         | (context)       | Local `<appDir>/hls` — used if present. |
| `PC_PUBLIC_BASE`     | `PUBLIC_BASE_URL` | Fallback base for the public HLS URL. |
| `STREAMHUB_INGEST_URL`/`_TOKEN` | (framework) | Live-data channel for the counters snapshot. |

Tuning knobs (env only, defaults = Vision One's production values):
`PC_TRACKER` (path to a tracker yaml; default = bundled
`trackers/custom_bytetrack_persons.yaml`), `PC_IMGSZ` (inference size, 640),
`PC_COOLDOWN_FRAMES` (15 ≈ 3 s @ 5 FPS), `PC_MAX_JUMP` (0.15 normalized —
ID-switch guard), `PC_SAMPLE_INTERVAL` (occupancy sample seconds, 10).

Source resolution: the local `index.m3u8` under `PC_HLS_DIR/<room>/` is used
when it exists (no network, no auth); otherwise the public
`PC_PUBLIC_BASE/hls/<app>/<room>/index.m3u8` URL.

## Events (signed webhooks)

`count.in`, `count.out` and `occupancy.limit` are POSTed to `PC_CALLBACK_URL`
with the SAME envelope + signature convention as StreamHub's app callbacks
(`modules/callbacks`), so one verifier handles both:

```json
{
  "id": "<uuid>", "event": "count.in", "app": "live", "room": "door",
  "ts": "2026-07-10T12:00:00.000Z", "timestamp": "…",
  "data": { "room": "door", "direction": "in", "trackId": 12,
            "confidence": 0.87, "in": 42, "out": 40, "occupancy": 2,
            "capacity": 50 }
}
```

Headers: `X-StreamHub-Event`, `X-StreamHub-Delivery`, `X-StreamHub-Timestamp`
and — when `callbackSecret` is set — `X-StreamHub-Signature: sha256=<hex>` =
HMAC-SHA256(secret, raw body). `occupancy.limit` fires ONCE when occupancy
reaches `capacity` and re-arms after it drops below (no alert spam).

The worker signs and delivers events **itself** (stdlib only), so delivery is
identical whether it runs on the origin or on a remote edge node.

## Per-plugin SQLite (`PC_DB_PATH`, default `<DATA_DIR>/people-counter.db`)

The worker OWNS this database (the core never opens it). WAL mode; the
`app`/`room` columns scope rows so several apps can share the one file.

```sql
CREATE TABLE crossings (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        REAL    NOT NULL,              -- unix seconds
  app       TEXT    NOT NULL DEFAULT '',
  room      TEXT    NOT NULL DEFAULT '',
  direction TEXT    NOT NULL CHECK (direction IN ('in','out')),
  track_id  INTEGER NOT NULL
);
CREATE TABLE occupancy_samples (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  ts    REAL    NOT NULL,                  -- unix seconds
  app   TEXT    NOT NULL DEFAULT '',
  room  TEXT    NOT NULL DEFAULT '',
  count INTEGER NOT NULL                   -- occupancy at ts
);
```

`crossings` is the audit log (one row per counted person); a periodic
`occupancy_samples` row (every `PC_SAMPLE_INTERVAL` s) gives cheap
time-series occupancy without replaying crossings.

## Minimum requirements (honest CPU numbers)

YOLOv8n + ByteTrack per frame on a modern x86 CPU core costs roughly
150–300 ms at `imgsz=640`. Realistic budgets:

- **CPU only (default, e.g. stream01):** `yolov8n`, `PC_FPS` **3–5**, input
  ≤ 720p, `PC_IMGSZ=640`. That is enough for walking-pace entrances (a person
  needs ≥2 sampled frames on each side of the line — at 4 FPS that's anyone
  slower than ~2 m/s through the door). Expect ~0.5–1.5 CPU cores per
  worker. `yolov8s` on CPU: halve the FPS. Anything bigger on CPU will fall
  behind the live edge — don't.
- **GPU (optional, CUDA):** any model size; `yolov8n/s` track comfortably at
  10–30 FPS (`cuda` toggle → `PC_DEVICE=cuda`, needs CUDA torch wheels).
  Vision One ran `yolov8m` @ 5 FPS batch on GPU with these exact tracker
  settings.
- **RAM:** ~1.5 GB per worker (torch + model). Disk: model weights ~6 MB
  (yolov8n) auto-downloaded on first run; SQLite grows ~100 bytes/crossing.

Counting accuracy depends far more on CAMERA PLACEMENT than on model size:
overhead or high-angle views with the line across the walking path (Vision
One's deployment geometry) count reliably with yolov8n; frontal low-angle
views cause occlusion misses regardless of model.

## Edge / GRID execution

The worker is a PURE process: every input arrives via env/args (no core
imports, no shared filesystem needed when using the public HLS URL, stdlib
HTTP out). That makes it grid-placement compatible today:

- the plugin declares `worker.placement: 'grid'`, so on clusters with a
  registered edge node advertising `capabilities: ['people-counter']` the
  framework dispatches it there (GRID-1); otherwise it transparently falls
  back to a local spawn — single-node installs need nothing;
- on a remote node the framework injects the ORIGIN-based
  `STREAMHUB_INGEST_URL` so the live counters still reach the dashboard, and
  `PC_PUBLIC_BASE` gives the worker the public HLS source (no disk sharing);
- signed events go straight from the edge node to `PC_CALLBACK_URL` —
  **no origin round-trip**, the HMAC signature works anywhere;
- `PC_DB_PATH` is node-local by design (each edge node keeps its own
  counting log; ship/aggregate it with your fleet tooling if needed).

### Run standalone (edge box, docker)

```bash
docker build -t streamhub-people-counter ./people-counter-worker

docker run --rm --name pc-live-door \
  -v /srv/people-counter:/data \
  -e PC_APP=live -e PC_ROOM=door \
  -e PC_MODEL=yolov8n -e PC_DEVICE=cpu \
  -e PC_FPS=4 -e PC_CONFIDENCE=0.3 \
  -e PC_LINE=0.2,0.5,0.8,0.5 -e PC_IN_DIRECTION=right \
  -e PC_CAPACITY=50 \
  -e PC_CALLBACK_URL=https://your.app/hooks/people \
  -e PC_CALLBACK_SECRET=shhh \
  -e PC_PUBLIC_BASE=https://streamhub.example.com \
  streamhub-people-counter --app live
```

### Bare Python

```bash
cd people-counter-worker
python -m venv .venv && . .venv/bin/activate
pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu
pip install -r requirements.txt
PC_APP=live PC_ROOM=door PC_PUBLIC_BASE=https://streamhub.example.com \
  python -m people_counter_worker --app live
```

## Tests

Pure-logic tests need **no** torch/opencv/network:

```bash
cd people-counter-worker
pip install pytest
pytest -q
```

They cover the crossing geometry (side sign, buffered intersection, direction
vs. the rotated/flipped IN arrow), the counter guards (cooldown, min track,
ID-switch jumps) + occupancy accounting, the capacity-alert edge, the SQLite
store, env parsing/clamping, the signed envelope/HMAC builder, and the
track→count→persist→deliver loop.


## Measured GPU (AWS Tesla T4, 2026-07-10)
YOLOv8n @720p = **59 FPS** on a T4 (16.9 ms/frame, ~36% GPU util, 249 MiB). At the
default sampling fps (2–5), one T4 comfortably runs ~15–25 concurrent streams of
this plugin. ONNX-based plugins (lpr/safety-ppe) were not re-measured on GPU in
this run (CUDA-runtime mismatch on the DLAMI) — their documented CPU estimates stand.
