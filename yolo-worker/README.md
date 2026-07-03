# StreamHub YOLO worker

Python worker for the **`yolo`** StreamHub plugin. It pulls an app's live stream
over **HLS**, runs **ultralytics YOLO** inference on sampled frames, and **POSTs
detections to a callback URL** — one worker per app/room.

```
HLS  /hls/<app>/<room>/index.m3u8
  │           (opencv + ffmpeg backend, throttled to YOLO_FPS)
  ▼
YOLO (yolov8n/s/m/l/x, cpu|cuda)
  │           (filter: confidence + COCO class list)
  ▼
POST <callbackUrl>
  { "app", "room", "ts", "detections": [ { "class", "conf", "bbox":[x1,y1,x2,y2] } ] }
```

Structured JSON log lines go to stdout; when run via the plugin's worker-hook
the core mirrors them into the plugin **Logs** dialog in the dashboard.

## How it's wired to the plugin

`streamhub-core/src/plugins/yolo/plugin.meta.ts` declares the plugin
(`needsWorker: true`) and a pure `worker.spawn(ctx)` that maps the saved config
to this process:

```
python -m yolo_worker --app <app>
```

with these env vars (the core sets them; you set them yourself when running
standalone):

| Env                | From config      | Meaning |
|--------------------|------------------|---------|
| `YOLO_APP`         | (context)        | App slug. |
| `YOLO_ROOM`        | `room`           | HLS room to analyze. |
| `YOLO_MODEL`       | `model` size     | `yolov8{n,s,m,l,x}` (nano→xlarge). |
| `YOLO_DEVICE`      | `cuda` toggle    | `cpu` or `cuda`. |
| `YOLO_CONFIDENCE`  | `confidence`     | Min confidence 0–1. |
| `YOLO_FPS`         | `fps`            | Frames/sec to sample (0.1–30). |
| `YOLO_CLASSES`     | `classes`        | Comma-separated COCO names; empty = all 80. |
| `YOLO_CALLBACK_URL`| `callbackUrl`    | Where detections are POSTed. |
| `YOLO_HLS_DIR`     | (context)        | Local `<appDir>/hls` — used if present. |
| `YOLO_PUBLIC_BASE` | `PUBLIC_BASE_URL`| Fallback base for the public HLS URL. |

Source resolution: the local `index.m3u8` under `YOLO_HLS_DIR/<room>/` is used
when it exists (no network, no auth); otherwise the public
`YOLO_PUBLIC_BASE/hls/<app>/<room>/index.m3u8` URL.

The core owns start/stop/status/logs through the framework worker-hook — you
normally never launch this by hand. It exposes:

```
POST /api/v1/apps/:app/plugins/yolo/worker/start
POST /api/v1/apps/:app/plugins/yolo/worker/stop
GET  /api/v1/apps/:app/plugins/yolo/worker/status
GET  /api/v1/apps/:app/plugins/yolo/logs
```

(enabling/disabling the plugin also starts/stops the worker automatically).

## Run standalone (per app)

### Docker (recommended)

```bash
docker build -t streamhub-yolo ./yolo-worker

docker run --rm --name yolo-live-main \
  -e YOLO_APP=live \
  -e YOLO_ROOM=main \
  -e YOLO_MODEL=yolov8n \
  -e YOLO_DEVICE=cpu \
  -e YOLO_CONFIDENCE=0.35 \
  -e YOLO_FPS=2 \
  -e YOLO_CLASSES=person,car \
  -e YOLO_CALLBACK_URL=https://your.app/hooks/yolo \
  -e YOLO_PUBLIC_BASE=https://streamhub.example.com \
  streamhub-yolo --app live
```

One container per app/room. To watch several rooms, run several containers with
different `YOLO_ROOM` / `--name`.

If the stream files are on the same host, mount them and use the local path
instead of the public URL:

```bash
docker run --rm \
  -v /srv/streamhub/apps/live/hls:/hls:ro \
  -e YOLO_HLS_DIR=/hls -e YOLO_ROOM=main -e YOLO_APP=live \
  -e YOLO_CALLBACK_URL=https://your.app/hooks/yolo \
  streamhub-yolo --app live
```

### Bare Python

```bash
cd yolo-worker
python -m venv .venv && . .venv/bin/activate
pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu
pip install -r requirements.txt
YOLO_APP=live YOLO_ROOM=main YOLO_CALLBACK_URL=https://your.app/hooks/yolo \
  YOLO_PUBLIC_BASE=https://streamhub.example.com python -m yolo_worker --app live
```

## GPU vs CPU — real-time note

YOLO is a heavy convnet. **Real-time detection needs a GPU.**

- **GPU (CUDA):** set `cuda` on (`YOLO_DEVICE=cuda`), use an `nvidia/cuda` base
  image + CUDA torch wheels, run with `--gpus all`. Even `yolov8m/l/x` can keep
  up with several FPS.
- **CPU (e.g. `your-server`, which has no GPU):** stick to **`yolov8n`/`yolov8s`**
  and a **low `fps` (1–3)**. Larger models or high FPS will fall behind the live
  edge — the reader drops to the newest segment on reconnect, so you still get
  recent frames, just not every one. Treat CPU as "sampled monitoring", not
  frame-accurate detection. The worker logs a `note` event on startup when
  running on CPU.

## Tests

Pure-logic tests need **no** torch/opencv/network:

```bash
cd yolo-worker
pip install pytest
pytest -q
```

They cover env parsing + clamping, stream-source resolution, the 80-class COCO
table + filter, the FPS throttle, detection normalization, the callback payload
builder/poster, and the detect→POST loop.
