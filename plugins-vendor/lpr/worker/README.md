# StreamHub LPR worker

Realtime license-plate recognition (ALPR) for a StreamHub app: reads a live
stream (HLS from the app, or an RTSP gate camera on the edge), recognizes
plates, matches them against a whitelist/blacklist and emits
`plate.detected` / `plate.allowed` / `plate.denied` events. Spawned per app by
the streamhub-core `lpr` plugin (`streamhub-core/src/plugins/lpr/`) through
the plugin worker-hook, or run standalone (Docker / systemd) on an edge box.

## Model choice + licenses (open-source only — owner requirement)

The inference stack is **[fast-alpr](https://github.com/ankandrew/fast-alpr)
(MIT)**, chosen as the best-maintained fully-MIT ALPR pipeline. It composes:

| Piece | Project | License | What it does |
|---|---|---|---|
| Plate detection | [open-image-models](https://github.com/ankandrew/open-image-models) | MIT | YOLOv9-t license-plate detectors, ONNX (`yolo-v9-t-{256,384,512}-license-plate-end2end`) |
| Plate OCR | [fast-plate-ocr](https://github.com/ankandrew/fast-plate-ocr) | MIT | CCT OCR models, ONNX (`cct-xs-v1-global-model`, `cct-s-v1-global-model` — trained on global plate formats) |
| Runtime | onnxruntime | MIT | CPU by default, CUDA optional |

No cloud APIs, no restrictive-license weights (the models are trained on open
datasets and MIT-released by the fast-alpr author). Models auto-download
(~20 MB total) into `LPR_MODEL_DIR` on first run. `fast_alpr` is imported
**lazily** — the pure-logic pytest suite runs without onnxruntime/opencv.

## Pipeline

```
HLS/RTSP ──frames @ LPR_FPS──▶ fast-alpr (detect ▸ OCR)
        ─▶ normalize (uppercase, strip separators)
        ─▶ min-confidence filter (LPR_CONFIDENCE)
        ─▶ dedupe window (same plate within LPR_DEDUPE_SEC = ONE event)
        ─▶ whitelist/blacklist match  (blacklist wins on a double hit)
        ─▶ snapshot JPEG + INSERT INTO lpr.db
        ─▶ deliver:
             • STREAMHUB_EVENTS_URL  → core → app SIGNED callbacks (+ MQTT)
             • LPR_CALLBACK_URL      → operator webhook (barrier opener)
             • STREAMHUB_INGEST_URL  → live-data ring → dashboard panel
```

The dedupe window anchors on the last **emitted** event, so a car idling in
view re-emits every `LPR_DEDUPE_SEC` seconds (bounded "still here"
heartbeats) instead of one event per sampled frame.

## Events

Per accepted read the worker emits `plate.detected` always, plus
`plate.allowed` (whitelist hit) or `plate.denied` (blacklist hit). Event
`data` payload (identical on every channel):

```json
{ "plate": "AB123CD", "confidence": 0.93, "ts": 1712345678.9,
  "listMatch": "whitelist", "snapshot": "/…/lpr/snapshots/1712345678900-AB123CD.jpg" }
```

- **Framework event channel** (`STREAMHUB_EVENTS_URL`, injected by the
  worker-hook; auth = `X-Plugin-Ingest-Token`): body
  `{event, room, data}`. The core validates the name against the plugin
  manifest's declared `events` and relays it through the app's **signed
  callbacks** — webhook envelope `{event, app, room, ts, data}` signed with
  `X-StreamHub-Signature: sha256=HMAC(secret, body)` — and the MQTT tap.
- **Direct callback** (`LPR_CALLBACK_URL`, optional): flat body
  `{app, room, event, plate, confidence, ts, listMatch, snapshot}` — no
  envelope parsing needed for a dumb consumer.

### Webhook recipe — open a barrier on `plate.allowed`

Point the app's callback URL (app `config.yaml` → `callbacks.url`) — or this
plugin's `callbackUrl` — at a tiny receiver next to the gate relay:

```js
// barrier.js — node barrier.js  (GPIO/relay vendor SDK where indicated)
const crypto = require('node:crypto');
const SECRET = process.env.STREAMHUB_CALLBACK_SECRET; // app callbacks.secret
require('node:http').createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const sig = 'sha256=' + crypto.createHmac('sha256', SECRET).update(body).digest('hex');
    if (req.headers['x-streamhub-signature'] !== sig) { res.writeHead(401); return res.end(); }
    const { event, data } = JSON.parse(body);
    if (event === 'plate.allowed') openBarrier(data.plate);   // your relay here
    if (event === 'plate.denied') alertGuard(data.plate, data.snapshot);
    res.writeHead(204); res.end();
  });
}).listen(8099);
```

(Signature check applies to the signed app-callbacks path; the plugin's
direct `callbackUrl` POSTs are unsigned — keep that receiver on a private
network or check a shared token yourself.)

## Per-app SQLite — `<LPR_DATA_DIR>/lpr.db`

The core plugin points `LPR_DATA_DIR` at `apps/<app>/lpr/`, so reads stay
tenant-scoped. Schema (`lpr_worker/store.py`):

```sql
CREATE TABLE reads (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            REAL    NOT NULL,   -- unix seconds (float) of the read
  plate         TEXT    NOT NULL,   -- normalized plate (A-Z0-9)
  confidence    REAL    NOT NULL,   -- OCR confidence 0..1
  list_match    TEXT,               -- 'whitelist' | 'blacklist' | NULL
  snapshot_path TEXT                -- absolute JPEG path, or NULL
);
CREATE INDEX idx_reads_ts    ON reads(ts);
CREATE INDEX idx_reads_plate ON reads(plate);
```

Snapshots land next to it in `<LPR_DATA_DIR>/snapshots/<unix-ms>-<PLATE>.jpg`.
Neither is pruned automatically — add a cron/tmpwatch if a busy gate needs it.

## Configuration (env; JSON override optional)

Everything arrives via env — the worker never imports core code.

| Env | Default | Meaning |
|---|---|---|
| `LPR_APP` | — (required) | App slug |
| `LPR_ROOM` | — | HLS room (required unless `LPR_SOURCE` set) |
| `LPR_SOURCE` | `''` | Explicit stream URL (RTSP/HLS/anything OpenCV opens) — wins over HLS resolution |
| `LPR_DETECTOR` | `yolo-v9-t-384-license-plate-end2end` | Detector model (256/384/512 variants) |
| `LPR_OCR_MODEL` | `cct-xs-v1-global-model` | OCR model |
| `LPR_DEVICE` | `cpu` | `cpu` \| `cuda` |
| `LPR_CONFIDENCE` | `0.5` | Min OCR confidence (0–1) |
| `LPR_FPS` | `2` | Sampled frames per second (0.1–30) |
| `LPR_DEDUPE_SEC` | `10` | Dedupe window (0 disables, max 300) |
| `LPR_WHITELIST` / `LPR_BLACKLIST` | `''` | Comma/newline-separated plates |
| `LPR_CALLBACK_URL` | `''` | Direct webhook (optional) |
| `LPR_SNAPSHOTS` | `true` | Save a JPEG per event |
| `LPR_DATA_DIR` | `~/.cache/streamhub/lpr` | Holds `lpr.db` + `snapshots/` |
| `LPR_MODEL_DIR` | `<data dir>/models` | ONNX model cache |
| `LPR_HLS_DIR` / `LPR_PUBLIC_BASE` | `''` | HLS source resolution (local dir preferred) |
| `STREAMHUB_EVENTS_URL` / `STREAMHUB_INGEST_URL` / `STREAMHUB_INGEST_TOKEN` | injected | Framework channels (worker-hook) — overridable via `LPR_EVENTS_URL` / `LPR_INGEST_URL` |
| `LPR_CONFIG_JSON` (or `--config file.json`) | `''` | JSON override using the plugin configSchema keys (`room`, `detector`, `ocrModel`, `confidence`, `fps`, `dedupeWindowSec`, `whitelist`, `blacklist`, `callbackUrl`, `snapshots`, `cuda`, `source`) |

## Edge / GRID execution

The worker is **pure** — stream URL in, HTTP out — so it runs anywhere:

- **GRID node**: the plugin declares `placement: 'grid'` with capability tag
  `lpr`. A cluster node advertising `{capabilities:['lpr']}` in its heartbeat
  gets the spawn; the origin injects absolute `STREAMHUB_EVENTS_URL` /
  `STREAMHUB_INGEST_URL` (PUBLIC_BASE_URL-based) so results flow back over
  HTTP. No eligible node → transparent local fallback.
- **Standalone edge box** (camera-side, e.g. a NUC at the gate):

  ```bash
  docker build -t lpr-worker lpr-worker/
  docker run -d --restart unless-stopped \
    -e LPR_APP=parking -e LPR_SOURCE="rtsp://10.0.0.5:554/stream1" \
    -e LPR_CALLBACK_URL="http://127.0.0.1:8099/gate" \
    -e LPR_WHITELIST="AB123CD,AA000AA" -e LPR_DEDUPE_SEC=10 \
    -v /var/lib/lpr:/data -e LPR_DATA_DIR=/data \
    lpr-worker
  ```

  Only outbound HTTP is needed; reads keep landing in the local `lpr.db`
  even if the callback target is down.

## Minimum requirements (honest numbers)

CPU inference (onnxruntime, default `yolo-v9-t-384` + `cct-xs` OCR) at
gate-camera resolution (720p–1080p, plate ≥ ~60 px wide):

- **~60–120 ms per sampled frame on one modern x86 core** (detector dominates;
  OCR adds ~5–15 ms per plate found) → a single core sustains **~4–8 FPS**.
  The default 2 FPS uses roughly ¼–½ of one core; the 256 detector is ~1.5–2×
  faster, the 512 ~2× slower. ARM (Pi 4/5 class) runs ~2–4× slower — use the
  256 detector and 1–2 FPS there.
- **RAM**: ~400–600 MB RSS (onnxruntime + OpenCV + models).
- **Disk**: ~20 MB models (cached) + snapshots (~100–200 KB each at 1080p).
- **GPU optional**: `cuda:true` + `pip install "fast-alpr[gpu]"` drops
  inference to a few ms/frame — only needed for many cameras per host or
  high sample rates, never for a single gate.
- Python 3.10+, ffmpeg-capable OpenCV (the Docker image ships it).

2 FPS is plenty for vehicles stopping at a barrier; use 4–8 FPS only for
free-flow lanes (and expect one core per camera at 384).

## Tests

```bash
cd lpr-worker && pytest      # pure logic only — no fast-alpr/onnxruntime/opencv
```

Covers plate normalization + list parsing/matching, the dedupe window, the
SQLite store, config/env/JSON-override parsing, payload builders, POST
auth/error handling and the full run_loop (inference mocked): event fan-out
per verdict, dedupe suppression, confidence filter, snapshot toggle,
live-ring seeding/bounding, edge mode without a room, post-error accounting.
