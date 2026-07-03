# deface — Face Obfuscation plugin

Privacy `processor` plugin modelled on [ORB-HD/deface](https://github.com/ORB-HD/deface):
a Python worker (repo-root [`deface-worker/`](../../../../deface-worker/)) runs
**CenterFace** face detection (the ONNX model deface uses) over the app's live
HLS stream and streams normalized face boxes into the core's **plugin live-data
channel**; the player overlay ([`streamhub-web/src/plugins/deface/`](../../../../streamhub-web/src/plugins/deface/))
polls that channel and obfuscates each region **client-side**.

```
HLS  /hls/<app>/<room>/index.m3u8
  │        (opencv ffmpeg backend, throttled to `fps`)
  ▼
CenterFace (centerface.onnx, onnxruntime cpu|cuda, or OpenCV DNN)
  │        (thresh filter → NMS → mask-scale expansion → normalize 0–1)
  ▼
POST STREAMHUB_INGEST_URL   (framework live-data channel, per-start token)
  { "app", "room", "ts", "maskScale", "faces": [ { "bbox":[x,y,w,h], "score" } ] }
  ▼
GET /api/v1/apps/<app>/plugins/deface/live?room=<room>     (public, no auth)
  ▼
Player overlay: blur / mosaic / solid over each face (smoothed tracks)
```

The worker POSTs **every sampled frame** — an empty `faces` list clears the
overlay masks (unlike yolo, which only posts hits). Boxes in the payload are
**already expanded** by `maskScale` (`scale_bb` semantics: each side moves out
by `maskScale − 1` × that dimension) and the payload says so via `maskScale`,
so the overlay never re-expands them.

## ⚠️ Privacy caveat — read this first

This is **client-side obfuscation of the live player only**. The masks are
drawn by the viewer's browser on top of the video element:

- the **raw stream** (WebRTC, HLS segments, RTMP restreams) still contains the
  faces — anyone consuming the stream outside the StreamHub player sees them;
- **recordings / VODs / snapshots still contain the faces**;
- a viewer with DevTools can remove the overlay.

Treat it as a **presentation-layer privacy feature** (kiosk displays, public
embeds, demo screens), **not** as anonymization of the media itself.
Server-side anonymization of recordings (re-encoding with the masks burned in,
which is what the original `deface` CLI does to files) is **future work**.

## Config fields

Every field has a default — a fresh install is valid immediately; only `room`
must be set before enabling.

| Key | Type | Default | deface equivalent | Meaning |
|---|---|---|---|---|
| `room` | string | `''` (required) | input | HLS room to process: `/hls/<app>/<room>/index.m3u8`. |
| `thresh` | number 0–1 | `0.2` | `--thresh` | Detection sensitivity. Lower catches more faces (more false positives); raise if too much gets masked. |
| `replacewith` | select | `blur` | `--replacewith` | Player mask: `blur` (CSS backdrop-filter), `mosaic` (canvas pixelation of the real video pixels), `solid` (black fill), `none` (detect only — useful with `drawScores`). |
| `maskScale` | number 1–3 | `1.3` | `--mask-scale` | Enlarge detected boxes to cover hair/chin. Applied **worker-side**; the payload carries the value so nothing double-expands. |
| `boxes` | boolean | `false` | `--boxes` | `true` = rectangular masks; `false` = ellipses (deface default). |
| `mosaicSize` | number 2–200 | `20` | `--mosaicsize` | Pixel size of mosaic blocks. Only used when `replacewith=mosaic`. |
| `scale` | string | `''` | `--scale WxH` | Downscale frames for detection (e.g. `640x360`). Big CPU saver on HD streams; sizes are rounded up to the model's 32-px stride. Empty = native size. |
| `backend` | select | `auto` | `--backend` | `onnxrt` (onnxruntime), `opencv` (cv2.dnn), or `auto` (onnxrt when importable, else opencv). |
| `cuda` | boolean | `false` | `--execution-provider` | Use the CUDA execution provider (onnxrt backend only). Requires `onnxruntime-gpu`; **falls back to CPU automatically** (with a `note` log) when CUDA is unavailable. |
| `fps` | number 0.1–30 | `2` | (sampling) | Frames/second sampled from the stream. The overlay polls at ~this rate and smooths between updates. |
| `drawScores` | boolean | `false` | `--draw-scores` | Show the detection confidence next to each mask (debugging). |

Render-side options (`replacewith`, `boxes`, `mosaicSize`, `drawScores`,
`maskScale`) reach the anonymous player via the sanitized public config
(`GET /apps/:app/plugins/public`); detection options are mapped to `DEFACE_*`
env by the pure `worker.spawn(ctx)` in [`plugin.meta.ts`](./plugin.meta.ts).

## Worker & model

- Spawn: `python3 -m deface_worker --app <app>` with cwd = repo-root
  `deface-worker/` (override the interpreter with `PLUGIN_PYTHON`, the package
  location with `DEFACE_WORKER_DIR`).
- Model: `centerface.onnx` (~7.4 MB) is **downloaded on first run** to
  `<DATA_DIR>/models/deface/` (shared across apps), like yolo auto-downloads
  its weights. Override the source with `DEFACE_MODEL_URL`; pre-seed the file
  for air-gapped hosts.
- Live-data channel: the worker-hook injects `STREAMHUB_INGEST_URL` +
  `STREAMHUB_INGEST_TOKEN` (fresh per start); an operator can divert the feed
  with `DEFACE_CALLBACK_URL` (same payload, token header omitted for
  non-StreamHub targets… the token rides `X-Plugin-Ingest-Token`).
- Lifecycle is framework-owned: enable/disable (or the explicit
  `POST :id/worker/start|stop`) starts/stops the process; logs stream to
  `GET :id/logs` and the dashboard Logs dialog.

## GPU vs CPU

CenterFace is **much lighter than YOLO** — CPU handles a few FPS comfortably:

- **CPU (default, e.g. your-server):** keep `fps` low (1–4) and set
  `scale=640x360` for HD sources. That is fully real-time for masking purposes
  because the overlay smooths/holds masks between detections.
- **GPU (CUDA):** install `onnxruntime-gpu` in the worker's Python env, enable
  `cuda`. Only meaningful for high `fps` (>10) or many simultaneous rooms.
  Failure to initialize CUDA logs a note and continues on CPU — the worker
  never crash-loops over a missing GPU.

## Tests

- Backend manifest + spawn mapping: `plugin.meta.spec.ts` (jest).
- Live-data channel: `src/modules/plugins/plugin-livedata.spec.ts` (jest).
- Worker pure logic (config, geometry/mask math, CenterFace decode, callback,
  loop): `cd deface-worker && pytest` — **no onnxruntime/opencv needed**.
- Overlay pure logic (parsing, tracks/smoothing, letterbox geometry):
  `cd streamhub-web && node --test src/plugins/deface/overlay.util.spec.ts`.
