# Plugins (framework + built-in catalogue)

> **Branding note — "Studio" in the UI, "plugins" in the code/API.** The
> dashboard surfaces this framework under the **Studio** brand (the sidebar
> entry, the per-app **Studio** tab, and the **Studio Marketplace** page at
> `/studio`; the legacy `/plugins` route redirects there). A plugin is shown to
> users as a *"Studio app"*. This is a presentation rebrand only: the REST API
> (`/apps/:app/plugins/*`), the backend/frontend `plugins` modules, the
> `PluginModule`/discovery internals, config keys and file paths are all
> **unchanged**. When this doc says "plugin", the UI says "Studio app".

## What it does

A small **plugin framework** lets features plug into both the backend and the
dashboard with **zero edits to any central registry**. A plugin is a file
dropped into a known folder — the framework discovers it, lists it in the
per-app **Studio** marketplace (branding; code/API = plugins), validates its
config against a typed schema, and (when the plugin declares one) owns the
lifecycle of its worker process.

- **Backend** — a declarative meta: for a built-in, one entry in
  `streamhub-core-go/internal/plugins/builtin/builtins.json` (embedded in the
  binary; until 3.2 these were `plugin.meta.ts` files of the NestJS core); for a
  decoupled app, a `streamhub.app.json` package composed into `plugins-vendor/`.
  The registry loads both; this manifest is the source of truth for the plugin's
  `id`, `category`, UI slot, `configSchema` (every field has a `default`, so an
  install with no config is immediately valid), whether it needs a worker, and
  its **taxonomy** — `kind` (`plugin` vs Studio `app`), any `storage` it owns and
  whether it is `export`able (see below).
- **Frontend** — drop `streamhub-web/src/plugins/<id>/index.tsx`
  default-exporting a `PluginModule`; `discovery.ts` picks it up via
  `import.meta.glob` (one level of sub-folder only, so the framework's own
  flat files are never mistaken for a plugin).

Install is **per app**; installing/enabling/configuring is independent of
whether the plugin has a worker.

### `configSchema` field shape

```ts
{ key: string; type: 'string'|'number'|'boolean'|'select'|'secret';
  label: string; default: any;            // required: every field has a default
  required?: boolean; min?: number; max?: number;  // number fields
  options?: {value, label}[];             // select fields (non-empty)
  format?: 'url';                         // optional, string/secret fields only (3.3.3)
  help?, placeholder?, …                  // free UI keys, served verbatim }
```

`format: "url"` marks a value the **worker calls from the host** (a webhook /
`callbackUrl`): `PATCH /apps/:app/plugins/:id` runs it through the SSRF egress
guard — `http`/`https` only, and a host that is / resolves to a private,
loopback, link-local or metadata address is a 400 (`config field '<key>' points
at a private/loopback/link-local address`), unless `STREAMHUB_CALLBACK_ALLOW_HOSTS`
admits it. Only the keys the PATCH sets are checked; an empty value means unset.
Any other `format` value, or `format` on a non-string field, fails discovery
(the plugin is skipped with the reason logged). The core can only check what is
stored — the worker must still dial through its own guard (`streamhub_sdk`),
since DNS can change after the PATCH. Mark every outbound URL field of a
decoupled app with it.

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

## Taxonomy — Plugin vs Studio App

A `kind` field (default `'plugin'`) splits the catalogue into simple in-process
**plugins** and full **Studio Apps** (`kind: 'app'`) — an App owns persistent
state and/or a worker and/or an app-sized primary UI, opens as a full page, and
(when worker-backed) can be **exported** as a standalone tarball. Three
additive, optional meta fields carry it, all validated at discovery and
projected onto the manifest (`toManifest`):

```ts
kind?: 'plugin' | 'app';            // default 'plugin'
storage?: { db?: string };          // bare SQLite filename the extension owns (informational)
export?: { workerDir?: string };    // repo-root worker dir → the app is exportable; only valid on kind:'app'
```

| Manifest field | Value |
|---|---|
| `kind` | `meta.kind ?? 'plugin'` |
| `storage` | `{ db }` when declared, else `null` |
| `exportable` | `!!meta.export?.workerDir` |

The full taxonomy (the 22 built-ins' classification, the full-page App view, and
the export bundle format) lives in **[STUDIO-APPS.md](STUDIO-APPS.md)**. The
built-in table below carries the `Kind` column.

## Workers

`needsWorker: true` + a pure `worker.spawn(ctx)` (given a read-only context —
`app`, resolved `config`, `appDir`, `dataDir`, `livekitUrl` — returning
`{ command, args, env, cwd }`) makes the framework own the whole process
lifecycle: enabling the plugin (re)starts the worker, disabling stops it, and
start/stop/status/logs are exposed over the API. The core never needs to know
what the worker actually is — `yolo` and `deface` (below) both spawn a Python
process this way.

### Worker placement (GRID) — optional, defaults to `local`

`worker` gained two **optional, backward-compatible** fields so a worker can
ask to run on a remote BYO-GPU edge node instead of the origin. Every
pre-existing plugin keeps its exact behavior with zero edits — placement
defaults to `'local'`.

```ts
worker: {
  spawn(ctx) { /* unchanged */ },
  placement: 'grid',                 // 'local' (default) | 'grid'
  grid: {                            // only meaningful with placement:'grid'
    gpu: true,                       // hard filter
    minVramGb: 8,                    // hard filter (implies a GPU node)
    capabilities: ['cuda', 'whisper'], // hard filter (⊆ node's advertised tags)
    regions: ['eu'],                 // SOFT preference — reorders, never excludes
  },
}
```

- The registry **validates** these at discovery: an unknown `placement`, a
  `grid` block without `placement:'grid'`, or a malformed requirement shape
  skips the plugin with a logged reason (never a crash).
- `PluginManifest.workerPlacement` (`'local' | 'grid'`, defaulted by
  `toManifest`) is serialized to the marketplace so the dashboard can badge
  "runs on GRID" plugins; `WorkerState.placement` reports the **effective**
  placement of a run.
- Node selection reuses the cluster `nodes` registry verbatim — a node becomes
  grid-eligible by advertising a `grid` block in its heartbeat stats (see
  `PluginGridService`). Remote dispatch is a **deliberate stub** today
  (`TODO GRID-1`): a `'grid'` worker logs the node pick and **falls back to a
  local spawn**, so declaring `placement:'grid'` is always safe on a
  single-node install. Full design + TODO seams:
  [NEXTGEN-ADDONS.md](./NEXTGEN-ADDONS.md).

### Edge-capable workers (`worker.edge`) — optional, defaults to local-only

A third, optional `worker` flag declares a worker safe to run **distributed
per-stream** on registered edge nodes, not only co-located on the origin:

```ts
worker: {
  spawn(ctx) { /* unchanged pure spec */ },
  edge: true,   // this worker can be fanned out one-per-stream onto edge nodes
}
```

`worker.edge` is **distinct from `placement: 'grid'`**: `placement:'grid'` is the
local worker-hook asking to be dispatched to a single BYO-GPU node for its ONE
app-wide run, while `edge` declares the worker safe to **fan out** — one
assignment per `(app × stream)` — across the cluster's edge nodes. `toManifest`
serializes it as a boolean `edge` field, which (a) drives the marketplace
**"Edge-capable"** badge and (b) gates the app-scoped edge-assignments API
(`POST /apps/:app/edge/assignments` accepts only `edge: true` plugins). The spawn
stays the **same pure function** — the generic edge spawn resolver calls it with
a *remote* context (`originUrl` set) exactly like the grid path, so a worker that
already reads HLS over HTTP and POSTs signed events "just works" remotely. Eleven
built-ins declare it (the four vision apps + lpr, presence, deface, yolo,
safety-ppe, perimeter, people-counter). The full concept — edge nodes, the
control channel, the scheduler, reconcile — is
[vision-edge.md](vision-edge.md).

### Workers survive a core restart

A worker's run intent is **persisted**, so a deploy or reboot no longer silently
kills every Python worker. The per-app `app_plugins` table carries a
`worker_desired` column (`'running'` | `'stopped'`, added idempotently on first
access): every choke point sets it — start / enable → `running`, stop / disable →
`stopped`. On boot `PluginsService.resumeDesiredWorkers()`
(`onApplicationBootstrap`) restarts every worker that is enabled, validly
configured, and whose recorded intent is `running`; legacy `NULL` rows are
backfilled conservatively (an enabled `needsWorker` install → `running`) and then
persisted. It is **best-effort** — a resume failure (bad config, missing
interpreter) is swallowed per-plugin and never blocks application startup. This is
why `lpr` / `perimeter` / `presence` detection now comes back on its own after a
`streamhub upgrade` instead of staying dead until someone re-toggles it in the
dashboard.

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
| GET | `/apps/:app/plugins` | Marketplace: every built-in plugin + this app's install/config state. Optional `?stream=`/`?room=` makes it stream-aware (opted-out plugin → `enabled:false`); no scope = unchanged. |
| GET | `/apps/:app/plugins/:id` | One marketplace entry (manifest + install state). |
| GET | `/apps/:app/plugins/:id/export` | **Studio App only** — download the installed, `exportable` App as a standalone gzip tarball (`streamhub-app-<id>-<version>.tar.gz`). `config:write`. See [STUDIO-APPS.md](STUDIO-APPS.md). |
| POST | `/apps/:app/plugins/:id/install` | Install into the app (idempotent). |
| PATCH | `/apps/:app/plugins/:id` | Enable/disable and/or reconfigure (`config` validated against the schema). |
| DELETE | `/apps/:app/plugins/:id` | Uninstall (stops its worker, clears its live-data feeds). |
| GET | `/apps/:app/plugins/:id/logs` | Per-plugin logs (`limit`, default 200, max 1000). |
| POST | `/apps/:app/plugins/:id/worker/start` | Explicitly (re)start a worker (`needsWorker` plugins). |
| POST | `/apps/:app/plugins/:id/worker/stop` | Explicitly stop a worker. |
| GET | `/apps/:app/plugins/:id/worker/status` | Current worker state. |
| POST / GET | `/apps/:app/plugins/:id/live` | Live-data channel — see above. |
| GET | `/apps/:app/plugins/public` | **Public, no auth** — this app's enabled `player-overlay` plugins, config sanitized (secrets/callback URLs stripped), for anonymous players. Optional `?stream=`/`?room=` subtracts that stream's opted-out overlays (per-stream opt-out). |

**Per-stream opt-out.** A plugin enabled on the app applies to every live stream
by default; an operator can opt an individual stream out of specific plugins via
`GET`/`PATCH /apps/:app/streams/:id/plugins` (stored in the per-app
`streams.disabled_plugins` column). The overlay list endpoints above honor it
when passed a `?stream=`/`?room=` scope — see
[streams.md → Per-stream plugin opt-out](streams.md#per-stream-plugin-opt-out).

## Built-in plugins

`Kind` is the [Studio-App taxonomy](STUDIO-APPS.md): **app** = a full Studio App
(full-page UI, own storage/worker, exportable when worker-backed); **plugin** =
a simple in-process extension. `✅` in the Kind cell marks an **exportable** App.

| Plugin | id | Kind | Category | UI slot | Worker | Summary |
|---|---|---|---|---|---|---|
| Cockpit | `cockpit` | app | `panel` | `panel` | No | CCTV-style, drag-and-drop grid of every live stream in the app. |
| LPR — License Plate Recognition | `lpr` | app ✅ | `processor` | `app-tab` | **Yes** | Reads plates from the live stream (fast-alpr), dedupes + whitelist/blacklist, emits `plate.*` events; reads persist to `apps/<app>/lpr/lpr.db`. Details below. |
| Safety PPE monitor | `safety-ppe` | app ✅ | `processor` | `app-tab` | **Yes** | Helmet/vest violation detection (YOLOv8 ONNX) → SQLite + evidence JPEGs + signed webhook (experimental). |
| Perimeter — intrusion detection | `perimeter` | app ✅ | `processor` | `app-tab` | **Yes** | Person-in-zone detection while armed (schedule/manual) → evidence snapshot + clip + SQLite alert queue + signed webhook. |
| Presence — workstation presence | `presence` | app ✅ | `processor` | `app-tab` | **Yes** | Person → zone occupancy → `presence.absent/returned/after_hours` events + own `presence.db` history. |
| People counter | `people-counter` | app ✅ | `processor` | `app-tab` | **Yes** | Line-crossing people counting → tallies + events; own `people-counter.db`. |
| YOLO Object Detection | `yolo` | app ✅ | `processor` | `player-overlay` | **Yes** | Python worker runs YOLO over the live stream and POSTs detections to a callback. |
| Deface — Face Obfuscation | `deface` | app ✅ | `processor` | `player-overlay` | **Yes** | Python worker detects faces (CenterFace) and the player overlay blurs/mosaics/masks them client-side. Edge-capable. |
| Occupancy — Zone Dwell & Sessions | `occupancy` | app ✅ | `processor` | `app-tab` | **Yes** | YOLO11 + ByteTrack per-zone dwell → `occupancy.session_*` + over-limit `occupancy.alert`; own `occupancy.db`. Edge-capable. One of the four vision apps (shared `vision-edge-runtime`). |
| Counting — Line-Crossing Counter | `counting` | app ✅ | `processor` | `app-tab` | **Yes** | Multi-line tagged people counting (YOLO11 + ByteTrack) → `count.in/out` + live `count.occupancy`; own `counting.db`. Edge-capable. (Multi-line variant; `people-counter` is the simpler single-line webhook port.) |
| Crowd — Density Threshold | `crowd` | app ✅ | `processor` | `app-tab` | **Yes** | Periodic head-count per polygon zone with a multi-cycle threshold alert (`crowd.count` / `crowd.threshold`); own `crowd.db`. Edge-capable. |
| Demography — Age / Gender / Emotion | `demography` | app ✅ | `processor` | `app-tab` | **Yes** | Per-face age / gender / emotion (InsightFace, or opt-in openai/deepseek vision API) → `demography.face`; own `demography.db`. Edge-capable. |
| VOD Transcription | `transcription` | app | `processor` | `panel` | **Yes** | Transcribes recorded VODs (not the live stream): mp3 extract → Whisper (local faster-whisper worker by default, OpenAI API optional) → transcript row + SRT uploaded next to the VOD in S3. |
| Fleet — agent management | `fleet` | app | `panel` | `app-tab` | No (in-core MQTT) | nodos.dev-style fleet management for StreamHub Agents over the app's MQTT broker (telemetry, online/offline, restart/OTA/config/ping); own `fleet.db`. See [fleet.md](fleet.md). |
| Streamflow — Workflow Engine | `streamflow` | app | `tool` | `app-tab` | No (in-core) | n8n-style event-workflow engine: triggers (app events / `trigger.mqtt`) → actions, per-app `streamflow.db`. |
| Quality / Stream Health | `quality` | plugin | `tool` | `panel` | No | Bandwidth + latency test distilled into a green/amber/red traffic light. |
| Radio | `radio` | plugin | `panel` | `app-tab` | No | Audio-only WebRTC radio: go on air, count listeners, mint listen tokens. |
| Video Streaming | `streaming` | plugin | `tool` | `app-tab` | No | Go live with webcam + mic and forward the room to RTMP via server egress. |
| Vidstack player provider | `vidstack` | plugin | `tool` | `player` | No | Swaps the built-in video.js HLS/VOD player for a Vidstack player (`ui: 'player'`). See [players.md](players.md). |
| Timestamp CCTV | `timestamp` | plugin | `tool` | `player-overlay` | No | Live CCTV-style date/time stamp drawn on the player. |
| Watermark | `watermark` | plugin | `tool` | `player-overlay` | No | Text watermark drawn in a corner of the player. |
| Scheduled Live | `scheduled-live` | plugin | `tool` | `player-overlay` | No | Schedule premieres: a full-cover countdown hides the stream until the start time, then reveals it. |

Eleven Apps are **edge-capable** (and all exportable): the four vision apps
(`occupancy`, `counting`, `crowd`, `demography`) plus `lpr`, `safety-ppe`,
`perimeter`, `presence`, `people-counter`, `yolo` and `deface`. Each can run
co-located on the origin OR distributed per-stream on edge nodes
([vision-edge.md](vision-edge.md)), and each can be downloaded as a standalone
worker bundle that runs on your own infra and talks back over REST/webhooks (see
[STUDIO-APPS.md](STUDIO-APPS.md)). `lpr` reads plates with fast-alpr (MIT:
YOLOv9-t + ONNX OCR) and emits `plate.detected`/`plate.allowed`/`plate.denied`
through the app's signed callbacks (+ optional direct barrier webhook); see
the README of the `streamhub-app-lpr` repo (worker included).

Each of them has its full `configSchema` in its manifest — `builtins.json` for
the in-tree ones, the app repo's `streamhub.app.json` for the decoupled ones (a doc page per plugin is
tracked as a gap — see below); `deface`, `scheduled-live` and `transcription`
are documented in full here since they shipped most recently.

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

## Scheduled Live — countdown to a premiere

A `tool` / `player-overlay` plugin (no worker) that lets an operator schedule
one or more live-stream **premieres**. The main stream may already be
publishing continuously, but viewers do NOT see it until the scheduled start:
until then the player shows a full-cover **countdown** ("El vivo comienza en …")
and at the start time the cover animates away and the stream is revealed.

- The **agenda** (multiple events per app) lives in the per-app
  `scheduled_events` table, managed by a plain CRUD module (`modules/scheduled-live`).
  Each event stores `start_at` as an **absolute unix epoch in MILLISECONDS
  (UTC)** — the browser converts the operator's picked wall-time + IANA timezone
  into that absolute instant; the backend does no timezone math. `timezone` is
  kept only for display / round-trip editing. `room` is optional: `NULL` applies
  the countdown to every room in the app, otherwise it is scoped to that room.
- Enabling the plugin activates the overlay and exposes the agenda on the public
  overlays endpoint, so anonymous `/play` + `/embed` viewers get the countdown.
- The reveal/countdown/timezone math is pure and unit-tested
  (`streamhub-web/src/plugins/scheduled-live/overlay.util.ts`).
- **Real-time push**: every agenda mutation (create/update/delete) pushes an
  `agenda-updated` LiveKit **data message** (topic `scheduled-live`) to the
  affected room(s) — the event's room, or every live room of the app when the
  event is global. Overlays mounted inside a LiveKit room context (the WebRTC
  players) refetch the public agenda instantly on receipt; the overlay's 30 s
  poll remains as the fallback transport and is the only transport on HLS/MJPEG
  players (no LiveKit connection). The push is strictly best-effort: LiveKit
  being down never fails the agenda mutation.

### Config keys (`builtins.json` meta / display options)

| Key | Type | Default | Meaning |
|---|---|---|---|
| `mode` | select | `cover` | `cover` = full countdown cover that hides the stream; `badge` = a small corner countdown chip that never occludes or mutes. |
| `accent` | string | `#2f7bff` | Hex accent colour for the countdown. |
| `headline` | string | `The live stream starts soon` | Big headline shown over the countdown. |
| `revealAnimation` | select | `fade` | How the cover leaves at start: `fade`, `zoom`, or `none` (instant). |
| `muteUntilStart` | boolean | `true` | Mute the player's media while the cover is up (never pauses — the stream is live); restored on reveal. `cover` mode only. |
| `showViewerLocalTime` | boolean | `true` | Show the start time in the viewer's local timezone plus the event's own zone label. |
| `autoHideAfterStartSec` | number (0–60) | `5` | How long the reveal animation runs after the start instant before the overlay disappears. |

### Agenda API (management + public)

All routes are under `/apps/:app/scheduled-live`. `start_at`/`startAt` is always
an absolute unix epoch **milliseconds** in UTC.

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/apps/:app/scheduled-live/public` | Public (no bearer) | Enabled, upcoming events for the player countdown. Query `?room=&sinceMs=`. |
| GET | `/apps/:app/scheduled-live` | Bearer + `config:read` | List every scheduled event (operator agenda). |
| POST | `/apps/:app/scheduled-live` | Bearer + `config:write` | Schedule a premiere (`{ startAt, timezone?, room?, title?, message?, enabled? }`). |
| PATCH | `/apps/:app/scheduled-live/:id` | Bearer + `config:write` | Update an event (move `startAt`, enable/disable, …). |
| DELETE | `/apps/:app/scheduled-live/:id` | Bearer + `config:write` | Delete an event. |

The `/public` route is declared before `/:id` so the literal `public` segment
is never captured as an id, and it only ever returns enabled, not-yet-past
events (24h lookback so a just-fired reveal is still covered).

## VOD Transcription — speech-to-text + SRT for recordings

A `processor` plugin that operates on **VODs** (finished MP4 recordings), not
the live stream. Backend package: `streamhub-core-go/internal/transcription/`
(wired in `cmd/streamhub/studioplane.go`, consumed by recording); the worker ships
with the decoupled `transcription` app.

**Flow** — on `vod_ready` (when `autoTranscribe` is on) or on demand via
`POST /apps/:app/vods/:id/transcribe`:

```
VOD MP4 (local file, or presigned S3 URL when the local copy was deleted)
  │  ffprobe: count audio streams
  ▼
ffmpeg: one 16 kHz mono MP3 per audio stream  (apps/<app>/transcripts/tmp/)
  │
  ├─ provider local (DEFAULT, open source, no API cost)
  │    core drops apps/<app>/transcripts/jobs/vod-<id>.json
  │    → python worker (faster-whisper) claims it (rename → .working),
  │      transcribes, writes results/vod-<id>.json atomically
  │    → core polls the result (30 min budget)
  │
  └─ provider openai
       POST /v1/audio/transcriptions per track (multipart mp3)
  ▼
merge per-track segments (speaker labels) → transcript text + SRT
  ▼
S3: <vod fileKey minus .mp4>.srt  (next to the recording, application/x-subrip)
DB: per-app `vod_transcripts` row (status/text/segments/speakers/srt_key)
    + `transcript: { srtKey, language, generatedAt }` in the VOD's metatags
```

**Engines**

- `local` (default): [faster-whisper](https://github.com/SYSTRAN/faster-whisper)
  — Whisper on CTranslate2, the fastest open-source engine on CPU (int8) and
  GPU. Models (`tiny`…`large-v3`) auto-download to
  `<DATA_DIR>/models/transcription/` (shared across apps). Runs fully
  offline; `pip install -r transcription-worker/requirements.txt` on the host
  (or bake it like the deface venv). tiny/base/small are fine on CPU for
  batch VOD work; medium/large-v3 want `device: cuda`.
- `openai`: OpenAI's transcription API as fallback when an `apiKey` is
  configured. **Use `whisper-1`** — it returns per-segment timestamps
  (`verbose_json`) that the SRT needs; `gpt-4o-transcribe` /
  `gpt-4o-mini-transcribe` return plain text only, so the SRT degrades to a
  single full-length cue. The key is core-side only; it is never passed to
  the python worker.

**Speaker / participant split — approach and limitation**

One speaker label **per audio track**, no acoustic diarization:

- MP4s with **multiple audio streams** → one transcript per stream, labelled
  `track-1`, `track-2`, … and merged chronologically (`[track-1] hello`).
- Single-track VODs recorded in **`track` / `audio` / `participant` mode**
  (TrackCompositeEgress — ONE publisher) → segments attributed to that
  publisher's stream id (`[cam-entrance] …`).
- **`room-composite` recordings carry ONE mixed track: segments get NO
  speaker label.** Whisper does not diarize; separating voices inside a mixed
  track would need an extra model (pyannote et al.) and is deliberately out
  of scope for the local engine. To get per-participant transcripts, record
  with `recordMode: track`/`audio` per publisher.

**Config** (every field defaulted — a fresh install is immediately valid;
nothing is `required`, the openai key is enforced at run time):

| Field | Type | Default | Notes |
|---|---|---|---|
| `provider` | select | `local` | `local` (faster-whisper worker) \| `openai` (paid API). |
| `model` | select | `small` | Local Whisper size: `tiny`\|`base`\|`small`\|`medium`\|`large-v3`. |
| `openaiModel` | select | `whisper-1` | `whisper-1` \| `gpt-4o-transcribe` \| `gpt-4o-mini-transcribe`. |
| `language` | string | `auto` | ISO code; `auto` = detect. |
| `autoTranscribe` | boolean | `true` | Transcribe every VOD as soon as it is `ready`. |
| `apiKey` | secret | `""` | OpenAI key — only for `provider: openai`. |
| `device` | select | `auto` | Local engine: `auto`\|`cpu`\|`cuda`. |

**API** (permissions mirror the other VOD routes):

| Method | Path | Permission | Purpose |
|--------|------|-----------|---------|
| POST | `/apps/:app/vods/:id/transcribe` | `vod:write` | Trigger/re-run (async; 409 if not `ready` or already running; 400 if the plugin is not installed+enabled). |
| GET | `/apps/:app/vods/:id/transcript` | `vod:read` | Status + text + timed `segments` (+`speaker`) + `speakers` + `srtKey`/`srtUrl` (presigned). 404 if never transcribed. |
| GET | `/apps/:app/vods/:id/transcript.srt` | `vod:read` | The SRT file, rebuilt from the stored segments (survives S3 upload failures). |

The dashboard surfaces the transcript (status, text, speakers) plus a
**Download SRT** button on the VOD detail dialog (Grabaciones tab → play).

**Worker** — `python3 -m transcription_worker --app <app>` (spawned by the
framework when the plugin is enabled; `TRANSCRIPTION_WORKER_DIR` /
`PLUGIN_PYTHON` overrides). It only handles `provider: local` jobs; with
`openai` it just idles on an empty jobs dir. A worker crash/absence never
hangs the API: the core's poll times out and fails the transcript row with a
"worker never picked up the job" hint. Malformed job files are parked as
`.bad` instead of being retried forever.

## Notes

- **Docker image**: the core image bakes a Python venv with the `deface-worker`
  runtime (`onnxruntime`/`opencv-python-headless`) always installed; `yolo`'s
  heavier stack (`torch`/`ultralytics`) is opt-in at build time
  (`INSTALL_YOLO_WORKER=1`) — see
  [operations/DEPLOY.md](../operations/DEPLOY.md).
- **Coverage gap**: `cockpit`, `quality`, `radio`, `streaming`, `timestamp`,
  `watermark` and `yolo` don't yet have a dedicated doc page here (only their
  meta — `builtins.json` for `watermark`, the app's `streamhub.app.json` for
  `yolo` — and, for `yolo`, its worker's own README) — the
  table above and each plugin's config form in the dashboard are the best
  reference for those until pages are written.
