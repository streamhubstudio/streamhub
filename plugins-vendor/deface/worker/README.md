# StreamHub deface worker

Python worker for the **`deface`** StreamHub plugin (face obfuscation, modelled
on [ORB-HD/deface](https://github.com/ORB-HD/deface)). It pulls an app's live
stream over **HLS**, runs **CenterFace** face detection (ONNX) on sampled
frames, and **POSTs normalized face boxes** to the core's plugin live-data
channel — one worker per app/room. The player overlay does the actual masking
client-side.

```
HLS  /hls/<app>/<room>/index.m3u8
  │           (opencv + ffmpeg backend, throttled to DEFACE_FPS)
  ▼
CenterFace (centerface.onnx — onnxruntime cpu|cuda, or OpenCV DNN)
  │           (thresh filter → NMS → mask-scale expansion → normalize)
  ▼
POST <callback>   (every sampled frame — empty faces CLEAR the overlay)
  { "app", "room", "ts", "maskScale",
    "faces": [ { "bbox": [x, y, w, h] (0–1), "score": 0.93 } ] }
```

Structured JSON log lines go to stdout; when run via the plugin's worker-hook
the core mirrors them into the plugin **Logs** dialog in the dashboard.

## How it's wired to the plugin

`streamhub-core/src/plugins/deface/plugin.meta.ts` declares the plugin
(`needsWorker: true`) and a pure `worker.spawn(ctx)` that maps the saved config
to this process:

```
python -m deface_worker --app <app>
```

| Env                          | From                | Meaning |
|------------------------------|---------------------|---------|
| `DEFACE_APP`                 | (context)           | App slug. |
| `DEFACE_ROOM`                | `room`              | HLS room to process. |
| `DEFACE_THRESH`              | `thresh`            | Detection threshold 0–1 (default 0.2). |
| `DEFACE_MASK_SCALE`          | `maskScale`         | Box expansion factor (deface `--mask-scale`), applied before posting. |
| `DEFACE_SCALE`               | `scale`             | `WxH` detection downscale; empty = native. |
| `DEFACE_BACKEND`             | `backend`           | `auto` \| `onnxrt` \| `opencv`. |
| `DEFACE_EXECUTION_PROVIDER`  | `cuda` toggle       | `cpu` or `cuda` (onnxrt only; graceful CPU fallback). |
| `DEFACE_FPS`                 | `fps`               | Frames/sec to sample (0.1–30). |
| `DEFACE_MODEL_DIR`           | (context)           | Cache dir for `centerface.onnx` (`<DATA_DIR>/models/deface`). |
| `DEFACE_MODEL_URL`           | (optional)          | Override the model download URL. |
| `DEFACE_HLS_DIR`             | (context)           | Local `<appDir>/hls` — used if present. |
| `DEFACE_PUBLIC_BASE`         | `PUBLIC_BASE_URL`   | Fallback base for the public HLS URL. |
| `DEFACE_CALLBACK_URL`        | (optional override) | Divert the face feed to your own endpoint. |
| `STREAMHUB_INGEST_URL`       | worker-hook         | Default callback: the core live-data channel. |
| `STREAMHUB_INGEST_TOKEN`     | worker-hook         | Per-start auth token (sent as `X-Plugin-Ingest-Token`). |

The `centerface.onnx` model (~7.4 MB) is downloaded once into
`DEFACE_MODEL_DIR` on first run (atomic `.part` + rename); pre-seed the file
for air-gapped hosts.

The core owns start/stop/status/logs through the framework worker-hook — you
normally never launch this by hand:

```
POST /api/v1/apps/:app/plugins/deface/worker/start
POST /api/v1/apps/:app/plugins/deface/worker/stop
GET  /api/v1/apps/:app/plugins/deface/worker/status
GET  /api/v1/apps/:app/plugins/deface/logs
GET  /api/v1/apps/:app/plugins/deface/live?room=<room>   ← what the player polls
```

## Run standalone (per app)

### Docker

```bash
docker build -t streamhub-deface ./deface-worker

docker run --rm --name deface-live-main \
  -e DEFACE_APP=live \
  -e DEFACE_ROOM=main \
  -e DEFACE_THRESH=0.2 \
  -e DEFACE_MASK_SCALE=1.3 \
  -e DEFACE_SCALE=640x360 \
  -e DEFACE_FPS=2 \
  -e DEFACE_CALLBACK_URL=https://your.app/hooks/deface \
  -e DEFACE_PUBLIC_BASE=https://streamhub.example.com \
  streamhub-deface --app live
```

### Bare Python

```bash
cd deface-worker
python -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
DEFACE_APP=live DEFACE_ROOM=main \
  DEFACE_CALLBACK_URL=https://your.app/hooks/deface \
  DEFACE_PUBLIC_BASE=https://streamhub.example.com \
  python -m deface_worker --app live
```

## GPU vs CPU

CenterFace is a small single-stage detector — **CPU is fine for live masking**
(1–4 FPS with `DEFACE_SCALE=640x360` costs a few % of a core). For high FPS or
many rooms, install `onnxruntime-gpu` and set `DEFACE_EXECUTION_PROVIDER=cuda`;
when the CUDA provider is missing or fails to initialize the worker logs a
`note` and continues on CPU rather than crash-looping.

## Privacy caveat

This worker only *detects*; the masking happens in the **player**. The raw
stream and recordings still contain the faces — see the plugin README
(`streamhub-core/src/plugins/deface/README.md`) before treating this as
anonymization.

## Tests

Pure-logic tests need **no** onnxruntime/opencv/network:

```bash
cd deface-worker
pip install pytest
pytest -q
```

They cover env parsing + clamping, stream-source resolution, mask-scale box
math (`scale_bb` semantics), normalization, IoU/NMS, the CenterFace heatmap
decode, the model download/caching, the callback payload builder/poster (incl.
the ingest-token header) and the detect→POST loop (empty frames posted too).
