# StreamHub presence worker

Python worker for the **`presence`** StreamHub plugin — realtime
**workstation-presence detection**. It pulls an app's live stream over **HLS**,
runs **person detection** (ultralytics YOLOv8, lazy-imported like yolo-worker)
on sampled frames at low FPS, evaluates **point-in-zone occupancy** for the
configured zones, and turns occupancy into **events** through absence timers
and the work schedule — one worker per app/room.

```
HLS  /hls/<app>/<room>/index.m3u8
  │           (opencv + ffmpeg backend, throttled to PRESENCE_FPS, default 2)
  ▼
YOLOv8 person detection (nano by default, cpu|cuda)
  │           bbox anchor = bottom-center ("feet") → point-in-zone per zone
  ▼
PresenceMonitor (absence timers + schedule)
  │
  ├─ events ──► SQLite  <PRESENCE_DATA_DIR>/presence.db      (worker-OWNED history)
  ├─ events ──► POST …/plugins/presence/events (ingest token) → app's SIGNED callbacks + MQTT
  ├─ events ──► POST <PRESENCE_CALLBACK_URL>                  (optional raw webhook)
  └─ state  ──► POST …/plugins/presence/live   (ingest token) → dashboard Presence tab
```

Structured JSON log lines go to stdout; when run via the plugin's worker-hook
the core mirrors them into the plugin **Logs** dialog in the dashboard.

## Events

Three event types (all namespaced `presence.*` — the core's plugin-events
endpoint enforces the namespace so a worker can never spoof core events):

| Event                 | Fired when                                                          | Extra fields |
|-----------------------|---------------------------------------------------------------------|--------------|
| `presence.absent`     | a zone has been **empty continuously** longer than `thresholdMin` (default 5 min); once per empty episode | `emptyForSec`, `thresholdMin` |
| `presence.returned`   | a person shows up in a zone that had fired `absent`                  | `absentForSec`, `persons` |
| `presence.after_hours`| a person is present **outside the work schedule**; once per continuous occupied episode (re-arms when the zone empties or the schedule resumes) | `persons` |

The body the worker POSTs (to the core events endpoint AND the optional
external webhook) is:

```json
{
  "event": "presence.absent",
  "app": "live",
  "room": "office",
  "ts": 1767100000.5,
  "zone": "desk-1",
  "zoneName": "Front desk",
  "emptyForSec": 300.0,
  "thresholdMin": 5.0
}
```

The core wraps it into the standard **signed callback envelope**
(`{ id, event, app, room, ts, data }` + `X-StreamHub-Signature: sha256=<hmac>`)
and delivers it to the app's configured callback URL exactly like every other
StreamHub event; the MQTT tap mirrors it too. An empty desk at worker start is
treated as absent `thresholdMin` later (the timer anchors at the first sample).

## SQLite schema (worker-owned `presence.db`)

The worker OWNS `<PRESENCE_DATA_DIR>/presence.db` (stdlib `sqlite3`, WAL when
supported; the core plugin sets `PRESENCE_DATA_DIR=<appDir>/presence`, i.e.
`apps/<app>/presence/presence.db`). Rows older than 14 days are pruned at
start.

```sql
CREATE TABLE events (
  ts   REAL NOT NULL,   -- unix seconds (float)
  zone TEXT NOT NULL,   -- zone id (config zones[].id)
  type TEXT NOT NULL    -- presence.absent | presence.returned | presence.after_hours
);
CREATE INDEX idx_events_ts ON events(ts);

CREATE TABLE occupancy (
  ts      REAL NOT NULL,     -- unix seconds (float)
  zone    TEXT NOT NULL,     -- zone id
  persons INTEGER NOT NULL   -- persons counted in the zone at ts
);
CREATE INDEX idx_occupancy_ts ON occupancy(ts);
```

`occupancy` is a compact **step function**: a row is written on every count
CHANGE plus a 60 s heartbeat per zone — not one row per sampled frame. On
restart the worker seeds its in-memory timeline/event rings from the DB so the
dashboard timeline stays continuous.

## Live-data state (dashboard feed)

Every ~2 s the worker pushes its state to the framework live-data channel
(`POST …/plugins/presence/live`, `X-Plugin-Ingest-Token` auth). The dashboard
Presence tab polls the authenticated `GET …/plugins/presence/data?room=…`:

```json
{
  "room": "office", "ts": 1767100000.5, "thresholdMin": 5,
  "schedule": { "window": "08:00-18:00", "days": "mon-fri", "tz": "", "inSchedule": true },
  "zones":    [ { "id", "name", "persons", "absent", "emptyForSec", "lastPresentTs" } ],
  "events":   [ /* recent events, newest first (≤30) */ ],
  "timeline": [ { "ts", "zone", "persons" } /* occupancy change points, ≤500, last 3 h */ ]
}
```

## How it's wired to the plugin

`streamhub-core/src/plugins/presence/plugin.meta.ts` declares the plugin
(`needsWorker: true`, `placement: 'grid'`) and a pure `worker.spawn(ctx)` that
maps the saved config to this process:

```
python -m presence_worker --app <app>
```

| Env                       | From config       | Meaning |
|---------------------------|-------------------|---------|
| `PRESENCE_APP`            | (context)         | App slug. |
| `PRESENCE_ROOM`           | `room`            | HLS room to monitor. |
| `PRESENCE_ZONES`          | `zones`           | JSON `[{id,name,x,y,w,h}]`, normalized 0-1 rects. |
| `PRESENCE_SCHEDULE`       | `schedule`        | Work window `HH:MM-HH:MM`; empty disables after-hours; start > end spans midnight. |
| `PRESENCE_SCHEDULE_DAYS`  | `scheduleDays`    | `mon-fri`, `mon,wed,fri`, … empty = all days. |
| `PRESENCE_TZ`             | `timezone`        | IANA tz for the schedule; empty = server local. |
| `PRESENCE_THRESHOLD_MIN`  | `thresholdMin`    | Absence threshold in minutes (default 5). |
| `PRESENCE_AFTER_HOURS`    | `afterHours`      | Enable `presence.after_hours` (default true). |
| `PRESENCE_MODEL`          | `model` size      | `yolov8{n,s,m}` (nano default). |
| `PRESENCE_DEVICE`         | `cuda` toggle     | `cpu` or `cuda`. |
| `PRESENCE_CONFIDENCE`     | `confidence`      | Min person confidence 0-1 (default 0.35). |
| `PRESENCE_FPS`            | `fps`             | Frames/sec to sample (0.1-10, default 2). |
| `PRESENCE_CALLBACK_URL`   | `callbackUrl`     | OPTIONAL external webhook for events. |
| `PRESENCE_DATA_DIR`       | (context)         | Where `presence.db` lives (`<appDir>/presence`; fallback `~/.cache/streamhub/presence/<app>`). |
| `PRESENCE_HLS_DIR`        | (context)         | Local `<appDir>/hls` — used if present. |
| `PRESENCE_PUBLIC_BASE`    | ctx.originUrl / `PUBLIC_BASE_URL` | Fallback base for the public HLS URL. |
| `PRESENCE_LIVEKIT_URL`    | (context)         | LiveKit hint (unused today). |
| `STREAMHUB_INGEST_URL`    | (worker-hook)     | Live-data channel POST target; the events URL is derived from it (`…/live` → `…/events`). |
| `STREAMHUB_INGEST_TOKEN`  | (worker-hook)     | Per-start ingest auth token. |

Source resolution: the local `index.m3u8` under `PRESENCE_HLS_DIR/<room>/` is
used when it exists (no network, no auth); otherwise the public
`PRESENCE_PUBLIC_BASE/hls/<app>/<room>/index.m3u8` URL.

The core owns start/stop/status/logs through the framework worker-hook — you
normally never launch this by hand (`POST …/plugins/presence/worker/start|stop`,
`GET …/worker/status`, `GET …/logs`; enabling/disabling the plugin also
starts/stops the worker).

## Edge/GRID execution

The worker is **pure by design** — every input arrives via env/args, results
leave via HTTP and its own SQLite file, and it imports **nothing** from the
core. That makes it safe to run anywhere:

- The plugin declares `worker.placement: 'grid'` with
  `grid: { capabilities: ['yolo'] }` (**no GPU requirement** — see below). When
  a cluster node advertises the capability, the core dispatches the resolved
  spawn spec to that node's grid agent; otherwise it transparently falls back
  to a local spawn (single-node installs unaffected).
- On a remote node the local HLS dir doesn't exist, so the reader falls back to
  the **public HLS URL** — `worker.spawn` passes `ctx.originUrl` as
  `PRESENCE_PUBLIC_BASE` on remote dispatch, and the worker-hook rewrites
  `STREAMHUB_INGEST_URL` to the origin's public base, so both the media input
  and the event/live feed-back work off-box. `PRESENCE_DATA_DIR` is simply
  created on the remote node's disk (worker-local history).
- Standalone/edge without the grid at all: run the Docker image (below) or
  `python -m presence_worker` with the env table above — point
  `PRESENCE_PUBLIC_BASE` at the StreamHub origin and `PRESENCE_CALLBACK_URL`
  at your receiver. (Without the worker-hook there is no ingest token, so the
  signed-callback/live-data paths are off; the external webhook still works.)

```bash
docker build -t streamhub-presence ./presence-worker

docker run --rm --name presence-live-office \
  -e PRESENCE_APP=live \
  -e PRESENCE_ROOM=office \
  -e PRESENCE_ZONES='[{"id":"desk-1","name":"Front desk","x":0.1,"y":0.2,"w":0.3,"h":0.4}]' \
  -e PRESENCE_SCHEDULE=08:00-18:00 \
  -e PRESENCE_SCHEDULE_DAYS=mon-fri \
  -e PRESENCE_THRESHOLD_MIN=5 \
  -e PRESENCE_PUBLIC_BASE=https://streamhub.example.com \
  -e PRESENCE_CALLBACK_URL=https://your.app/hooks/presence \
  -v presence-data:/data -e PRESENCE_DATA_DIR=/data \
  streamhub-presence --app live
```

## Minimum requirements

Honest CPU-only numbers (yolov8n ≈ 3.2M params; ultralytics resizes frames to
640 px for inference regardless of source resolution, so 720p vs 1080p input
mostly changes decode cost, not inference cost):

| Resource | Minimum | Comfortable | Notes |
|----------|---------|-------------|-------|
| CPU      | 1 modern x86-64 core (AVX2) | **2 cores** | yolov8n ≈ 80-150 ms/frame/core on 2020+ server cores → at the default **2 fps** inference uses ~0.2-0.3 core, HLS decode of a 720p stream ~0.1-0.2 core. Budget **~0.5 core per monitored room**, keep a 2nd core of headroom for spikes. `yolov8s` roughly ×3 that; prefer GPU for it. |
| RAM      | 1 GB free | 1.5 GB | CPU torch + ultralytics + opencv RSS is ~600-900 MB per worker process (the model itself is only ~6 MB; the framework stack dominates). |
| Disk     | ~2.5 GB for deps | — | torch CPU wheels + opencv; `yolov8n.pt` (~6 MB) auto-downloads on first run; `presence.db` grows a few MB/month per room (14-day prune). |
| GPU      | none required | optional | Any CUDA GPU (2 GB+ VRAM) drops inference to <10 ms/frame — only needed for many rooms, higher FPS, or `small`/`medium` models. Set the plugin's `cuda` toggle (`PRESENCE_DEVICE=cuda`). |

Rule of thumb: the default config (nano @ 2 fps, 720p HLS) is fine on the same
CPU-only host as the core, one worker per monitored room. Raising `fps` buys
faster absence detection (granularity = 1/fps) but costs linearly — presence
timers work on minutes, so 2 fps is plenty.

## Tests

Pure-logic only — no torch, no OpenCV, no network, no ffmpeg:

```bash
cd presence-worker && pytest
```

Covers zone geometry/parsing, schedule windows (incl. overnight + tz), the
absence/returned/after-hours state machine, the SQLite store, config env
parsing, the run-loop fan-out (core events + webhook + live pushes + DB
writes) and the pure detection normalization. Inference and frame reading are
injected fakes; `ultralytics`/`cv2` are imported lazily only in production
code paths.


## Measured GPU (AWS Tesla T4, 2026-07-10)
YOLOv8n @720p = **59 FPS** on a T4 (16.9 ms/frame, ~36% GPU util, 249 MiB). At the
default sampling fps (2–5), one T4 comfortably runs ~15–25 concurrent streams of
this plugin. ONNX-based plugins (lpr/safety-ppe) were not re-measured on GPU in
this run (CUDA-runtime mismatch on the DLAMI) — their documented CPU estimates stand.
