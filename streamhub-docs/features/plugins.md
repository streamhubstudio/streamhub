# Plugins (framework + built-in catalogue)

## What it does

A small **plugin framework** lets features plug into both the backend and the
dashboard with **zero edits to any central registry**. A plugin is a file
dropped into a known folder — the framework discovers it, lists it in the
per-app **Plugins** marketplace, validates its config against a typed schema,
and (when the plugin declares one) owns the lifecycle of its worker process.

- **Backend** — drop `streamhub-core/src/plugins/<id>/plugin.meta.ts`
  default-exporting `definePlugin({...})` (the contract lives in the single
  file `src/modules/plugins/plugin.contract.ts` — the ONE file a plugin author
  imports). A registry service globs the filesystem and dynamically imports
  each `plugin.meta.ts`; this manifest is the source of truth for the plugin's
  `id`, `category`, UI slot, `configSchema` (every field has a `default`, so an
  install with no config is immediately valid), and whether it needs a worker.
- **Frontend** — drop `streamhub-web/src/plugins/<id>/index.tsx`
  default-exporting a `PluginModule`; `discovery.ts` picks it up via
  `import.meta.glob` (one level of sub-folder only, so the framework's own
  flat files are never mistaken for a plugin).

Install is **per app**; installing/enabling/configuring is independent of
whether the plugin has a worker.

| Category | Meaning |
|---|---|
| `tool` | An on-demand utility (diagnostic panel, player overlay). |
| `processor` | Consumes/analyzes the media stream, typically via a worker. |
| `panel` | A self-contained dashboard surface for the app. |

| UI slot | Where it renders |
|---|---|
| `app-tab` | A full section (tab) inside an app in the dashboard. |
| `panel` | Wherever a `<PluginSlot placement="panel">` lives (marketplace active-panels area). |
| `player-overlay` | Drawn on top of the video player, client-side — auto-mounted on that app's players, including the public `/play`/`/embed` pages. |

## Workers

`needsWorker: true` + a pure `worker.spawn(ctx)` (given a read-only context —
`app`, resolved `config`, `appDir`, `dataDir`, `livekitUrl` — returning
`{ command, args, env, cwd }`) makes the framework own the whole process
lifecycle: enabling the plugin (re)starts the worker, disabling stops it, and
start/stop/status/logs are exposed over the API. The core never needs to know
what the worker actually is — `yolo` and `deface` (below) both spawn a Python
process this way.

## Live-data channel (worker → player)

A worker plugin often needs to stream small, fast-changing runtime data — face
or object bounding boxes, for example — straight to its own player overlay,
without an operator-owned callback URL in the loop. The framework provides an
in-memory "latest payload" channel keyed by `(app, plugin, room)`:

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | `/apps/:app/plugins/:id/live` | `X-Plugin-Ingest-Token` (not Bearer) | **Worker-only.** Push the latest payload for a room. |
| GET | `/apps/:app/plugins/:id/live` | Public, no auth | **Player-only.** Read the latest payload for a room. |

- **`POST`** is called by the plugin's own worker process. Auth is not the
  usual Bearer guard: the worker echoes the per-start token the framework
  injected as `STREAMHUB_INGEST_TOKEN` (alongside `STREAMHUB_INGEST_URL`) in
  the `X-Plugin-Ingest-Token` header — a stale or missing token (e.g. after a
  worker restart) is rejected with `401`. The body is the plugin's own JSON
  payload, size-capped (64KB); it must include a `room` string or the request
  is `400`. This is a live overlay feed, not an event log: storage is a pure
  in-memory map, **latest value only** (no history/queue, capped at 256 keys
  with oldest-first eviction), wiped on plugin uninstall and on core restart —
  nothing touches SQLite.
- **`GET`** is polled by player overlays, including the anonymous `/play` and
  `/embed` pages. It answers only for an installed **and enabled**
  `player-overlay` plugin (`404` otherwise) and returns
  `{ ts, ageMs, payload }` (all `null` when nothing has been pushed yet), so
  the overlay can apply its own staleness policy.

The [`deface`](#deface--face-obfuscation) plugin is the reference example: its
worker POSTs detected face boxes on every sampled frame, and the player
overlay polls `GET :id/live` to draw the masks client-side.

## Other plugin routes

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/apps/:app/plugins` | Marketplace: every built-in plugin + this app's install/config state. |
| GET | `/apps/:app/plugins/:id` | One marketplace entry (manifest + install state). |
| POST | `/apps/:app/plugins/:id/install` | Install into the app (idempotent). |
| PATCH | `/apps/:app/plugins/:id` | Enable/disable and/or reconfigure (`config` validated against the schema). |
| DELETE | `/apps/:app/plugins/:id` | Uninstall (stops its worker, clears its live-data feeds). |
| GET | `/apps/:app/plugins/:id/logs` | Per-plugin logs (`limit`, default 200, max 1000). |
| POST | `/apps/:app/plugins/:id/worker/start` | Explicitly (re)start a worker (`needsWorker` plugins). |
| POST | `/apps/:app/plugins/:id/worker/stop` | Explicitly stop a worker. |
| GET | `/apps/:app/plugins/:id/worker/status` | Current worker state. |
| POST / GET | `/apps/:app/plugins/:id/live` | Live-data channel — see above. |
| GET | `/apps/:app/plugins/public` | **Public, no auth** — this app's enabled `player-overlay` plugins, config sanitized (secrets/callback URLs stripped), for anonymous players. |

## Built-in plugins

| Plugin | id | Category | UI slot | Worker | Summary |
|---|---|---|---|---|---|
| Cockpit | `cockpit` | `panel` | `panel` | No | CCTV-style, drag-and-drop grid of every live stream in the app. |
| Quality / Stream Health | `quality` | `tool` | `panel` | No | Bandwidth + latency test distilled into a green/amber/red traffic light. |
| Radio | `radio` | `panel` | `app-tab` | No | Audio-only WebRTC radio: go on air, count listeners, mint listen tokens. |
| Video Streaming | `streaming` | `tool` | `app-tab` | No | Go live with webcam + mic and forward the room to RTMP via server egress. |
| Timestamp CCTV | `timestamp` | `tool` | `player-overlay` | No | Live CCTV-style date/time stamp drawn on the player. |
| Watermark | `watermark` | `tool` | `player-overlay` | No | Text watermark drawn in a corner of the player. |
| YOLO Object Detection | `yolo` | `processor` | `player-overlay` | **Yes** | Python worker runs YOLO over the live stream and POSTs detections to a callback. |
| Deface — Face Obfuscation | `deface` | `processor` | `player-overlay` | **Yes** | Python worker detects faces (CenterFace) and the player overlay blurs/mosaics/masks them client-side. |

Each of the first seven has its full `configSchema` in its own
`streamhub-core/src/plugins/<id>/plugin.meta.ts` (a doc page per plugin is
tracked as a gap — see below); `deface` is documented in full here since it
shipped most recently.

## Deface — Face Obfuscation

A privacy `processor` plugin modelled on
[ORB-HD/deface](https://github.com/ORB-HD/deface): a Python worker
(`deface-worker/`, repo root) runs **CenterFace** face detection over the app's
live HLS stream and streams normalized face boxes into the live-data channel
above; the player overlay polls it and obfuscates each detected region
**client-side** — blur, mosaic or a solid mask.

```
HLS /hls/<app>/<room>/index.m3u8
  │   (sampled at `fps`)
  ▼
CenterFace (centerface.onnx — onnxruntime CPU/CUDA, or OpenCV DNN)
  │   (thresh filter → mask-scale expansion → normalize 0–1)
  ▼
POST /apps/:app/plugins/deface/live   (worker → core, per-start ingest token)
  ▼
GET /apps/:app/plugins/deface/live?room=<room>   (public, no auth)
  ▼
Player overlay: blur / mosaic / solid over each face (smoothed between polls)
```

The worker POSTs **every sampled frame** — an empty `faces` list actively
clears the overlay masks, unlike `yolo` (which only posts on a hit), because a
lingering stale mask is a rendering bug while a missing mask is a privacy bug.
Boxes are already expanded by `maskScale` before they're sent, so the overlay
never re-expands them. On the frontend, the overlay maps CenterFace's
normalized boxes onto the actual `<video>` element's rendered box (accounting
for `object-fit: contain` letterbox/pillarbox vs `cover` cropping) and debounces
empty payloads (3 consecutive empty samples or 1.5s, whichever first) before
clearing a mask, so a flaky detection on a static scene doesn't flicker.

### ⚠️ Privacy caveat — read this first

Deface anonymizes the **player only**. The masks are drawn by the viewer's
browser on top of the `<video>` element:

- the **raw stream** (WebRTC, HLS segments, RTMP restreams) still contains the
  faces — anyone consuming the stream outside the StreamHub player sees them;
- **recordings, VODs and snapshots still contain the faces** — nothing about
  the recording pipeline is touched;
- a viewer with DevTools can remove the overlay.

Treat it as a **presentation-layer privacy feature** (kiosk displays, public
embeds, demo screens) — not anonymization of the media itself. Server-side
anonymization of recordings (re-encoding with the masks burned in, which is
what the original `deface` CLI does to files) is not implemented.

### Configuration

Every field has a default — a fresh install is valid immediately; only `room`
must be set before the plugin can be enabled.

| Field | Type | Default | Notes |
|---|---|---|---|
| `room` | string | `""` | **Required.** HLS room to process — `/hls/<app>/<room>/index.m3u8`. |
| `thresh` | number | `0.2` | Detection threshold, `0`–`1`. |
| `replacewith` | select | `blur` | `blur` \| `mosaic` \| `solid` \| `none` (detect only). |
| `maskScale` | number | `1.3` | Enlarge detected boxes (`1`–`3`) to cover hair/chin. Worker-side; the payload carries the value so the overlay never double-expands. |
| `boxes` | boolean | `false` | Rectangular masks; off (default) draws ellipses. |
| `mosaicSize` | number | `20` | Mosaic block size in px (`2`–`200`), used when `replacewith: mosaic`. |
| `scale` | string | `""` | `WxH` to downscale frames for detection, e.g. `640x360`. Empty = native size. |
| `backend` | select | `auto` | `auto` (ONNX Runtime if importable, else OpenCV) \| `onnxrt` \| `opencv`. |
| `cuda` | boolean | `false` | CUDA execution provider (needs `onnxruntime-gpu`); falls back to CPU with a log note if unavailable. |
| `fps` | number | `2` | Frames sampled per second (`0.1`–`30`). |
| `drawScores` | boolean | `false` | Show detection confidence next to each mask (debug). |

Render-side options (`replacewith`, `boxes`, `mosaicSize`, `drawScores`,
`maskScale`) reach the anonymous player through the sanitized public config
(`GET /apps/:app/plugins/public`); detection options are mapped to `DEFACE_*`
environment variables by the worker's `spawn(ctx)`.

### The worker & model

```bash
python3 -m deface_worker --app <app>
```

- **Model** — `centerface.onnx` (~7.4MB) is downloaded on first run to
  `<DATA_DIR>/models/deface/` (shared across every app on the node, same
  pattern `yolo` uses). Override with `DEFACE_MODEL_URL`, or pre-seed the file
  for air-gapped hosts.
- **CPU is fine for most rooms** — CenterFace is much lighter than YOLO; keep
  `fps` low (1-4) and `scale` around `640x360` for HD sources. `cuda: true`
  only pays off above ~10fps or many simultaneous rooms, and never crash-loops
  over a missing GPU (it falls back to CPU with a log note).
- **Live-data channel** — the worker-hook injects a fresh
  `STREAMHUB_INGEST_URL`/`STREAMHUB_INGEST_TOKEN` per start; an operator can
  divert the feed with `DEFACE_CALLBACK_URL` (same payload shape).
- Overridable env: `PLUGIN_PYTHON` (interpreter, default `python3`) and
  `DEFACE_WORKER_DIR` (defaults to the `deface-worker/` checkout at the repo
  root).

### Enable and configure

```bash
curl -X POST https://YOUR-DOMAIN/api/v1/apps/live/plugins/deface/install \
  -H "Authorization: Bearer sk_..."

curl -X PATCH https://YOUR-DOMAIN/api/v1/apps/live/plugins/deface \
  -H "Authorization: Bearer sk_..." \
  -H "Content-Type: application/json" \
  -d '{"enabled": true, "config": {"room": "live", "replacewith": "blur"}}'

curl https://YOUR-DOMAIN/api/v1/apps/live/plugins/deface/worker/status \
  -H "Authorization: Bearer sk_..."
```

## Notes

- **Docker image**: the core image bakes a Python venv with the `deface-worker`
  runtime (`onnxruntime`/`opencv-python-headless`) always installed; `yolo`'s
  heavier stack (`torch`/`ultralytics`) is opt-in at build time
  (`INSTALL_YOLO_WORKER=1`) — see
  [operations/DEPLOY.md](../operations/DEPLOY.md).
- **Coverage gap**: `cockpit`, `quality`, `radio`, `streaming`, `timestamp`,
  `watermark` and `yolo` don't yet have a dedicated doc page here (only their
  in-code `plugin.meta.ts` and, for `yolo`, its worker's own README) — the
  table above and each plugin's config form in the dashboard are the best
  reference for those until pages are written.
